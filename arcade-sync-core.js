/* arcade-sync-core.js — pure primitives for Arcade.sync (multi-device state
 * replication over P2P, LWW). Companion to arcade-storage-core.js: that file
 * owns the storage-trust allowlists (including `syncEligibleKey`, the sync
 * key-eligibility predicate); this file owns the HLC clock, the digest/diff
 * envelope shapes, and the pure decision functions the launcher-side sync
 * engine (arcade-sync.js, a later work package) is built from.
 *
 * No top-level side effects: no localStorage/indexedDB/network access at
 * import time, only `crypto.subtle` inside `sha256Hex` (Node 20+ has
 * globalThis.crypto). This module imports cleanly in Node so the clock math,
 * chunking, planning, and validation logic can be unit-tested without a
 * browser (see tools/sync-unit.mjs).
 */

import { syncEligibleKey } from './arcade-storage-core.js';
import { DEVICE_ID_PATTERN } from './arcade-envelope.js';

// ---- protocol + storage constants ----
export const SYNC_PROTOCOL_V = 1;
export const SYNC_DB = 'arcade-sync';
export const SYNC_TOMBSTONE_TTL_MS = 30 * 24 * 3600 * 1000;
export const SYNC_TOMBSTONE_CAP_PER_APP = 512;

// ---- HLC (hybrid logical clock) ----
// Packed sortable string: <millis:13 digits>:<counter:4 digits>:<deviceId>.
// Fixed-width zero-padded fields make plain lexicographic string compare an
// exact causal LWW order; deviceId (the shared shape, composed from
// arcade-envelope.js's DEVICE_ID_PATTERN) is the built-in tiebreaker between
// same-millis/same-counter stamps from different devices (never happens in
// practice, but keeps hlcCompare total).
export const HLC_RE = new RegExp('^\\d{13}:\\d{4}:' + DEVICE_ID_PATTERN + '$', 'i');

export function hlcPack(millis, counter, deviceId) {
    const m = String(Math.trunc(millis)).padStart(13, '0');
    const c = String(Math.trunc(counter)).padStart(4, '0');
    return m + ':' + c + ':' + deviceId;
}

// null on non-match (malformed/foreign strings never throw — callers treat
// them as "no clock").
export function hlcParse(s) {
    if (typeof s !== 'string' || !HLC_RE.test(s)) return null;
    const i1 = s.indexOf(':');
    const i2 = s.indexOf(':', i1 + 1);
    return {
        millis: parseInt(s.slice(0, i1), 10),
        counter: parseInt(s.slice(i1 + 1, i2), 10),
        deviceId: s.slice(i2 + 1)
    };
}

// Fixed widths make plain string compare correct (no numeric parsing needed).
export function hlcCompare(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

// Monotonic local issue: millis never regresses versus the persisted prior
// stamp, even if the wall clock does; counter breaks ties within the same
// millisecond and overflow (>9999 same-millis writes) bumps millis by one
// rather than wrapping.
export function hlcNext(prev, nowMs, deviceId) {
    const p = prev ? hlcParse(prev) : null;
    let millis = p ? Math.max(nowMs, p.millis) : nowMs;
    let counter = (p && millis === p.millis) ? p.counter + 1 : 0;
    if (counter > 9999) { millis += 1; counter = 0; }
    return hlcPack(millis, counter, deviceId);
}

// Standard HLC receive: advance the local clock to max(prev, remote, now)
// before the next local stamp, so a subsequent hlcNext always sorts after
// anything already observed (locally or from the remote).
export function hlcRecv(prev, remote, nowMs, deviceId) {
    const p = prev ? hlcParse(prev) : null;
    const r = hlcParse(remote);
    if (!r) return hlcNext(prev, nowMs, deviceId); // malformed remote: fall back to a local stamp
    const pMillis = p ? p.millis : -1;
    const pCounter = p ? p.counter : 0;
    let millis = Math.max(pMillis, r.millis, nowMs);
    let counter;
    if (millis === pMillis && millis === r.millis) counter = Math.max(pCounter, r.counter) + 1;
    else if (millis === pMillis) counter = pCounter + 1;
    else if (millis === r.millis) counter = r.counter + 1;
    else counter = 0;
    if (counter > 9999) { millis += 1; counter = 0; }
    return hlcPack(millis, counter, deviceId);
}

// ---- checksum ----
export async function sha256Hex(str) {
    const buf = new TextEncoder().encode(str);
    const hash = await crypto.subtle.digest('SHA-256', buf);
    const bytes = new Uint8Array(hash);
    let hex = '';
    for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
    return hex;
}

// ---- chunking ----
// Partitions a flat entries array into frame-sized chunks: each chunk holds
// at most `maxEntries` items and its JSON-serialized size stays under
// `budgetBytes` (best-effort — a single oversize entry still gets its own
// chunk rather than being dropped; callers cap individual entries elsewhere,
// e.g. SYNC_VALUE_MAX). An empty input still yields one empty chunk, because
// the wire protocol's `parts` count must be >= 1 for the receiver to know a
// digest exchange (even a "nothing to declare" one) is complete.
export function chunkEntries(entries, maxEntries, budgetBytes) {
    const chunks = [];
    let cur = [];
    let curBytes = 2; // "[]"
    for (const e of entries) {
        let size;
        try { size = JSON.stringify(e).length + 1; } catch (err) { size = budgetBytes; }
        if (cur.length > 0 && (cur.length >= maxEntries || curBytes + size > budgetBytes)) {
            chunks.push(cur);
            cur = [];
            curBytes = 2;
        }
        cur.push(e);
        curBytes += size;
    }
    chunks.push(cur); // always at least one chunk, even if empty
    return chunks;
}

// ---- digest reconciliation ----
// localMap: Map<fullKey, {h, x, del, t}> (the engine's RAM mirror).
// remoteEntries: [[key, hlc, hash], ...] from a (reassembled) digest.
// Returns the partition the receiver acts on: keys to request (`need`),
// local keys to proactively send (`send` — includes remote-absent local
// keys, i.e. keys missing from the remote's completed digest), and
// same-content records where only the HLC bookkeeping should be reconciled
// (`adopt`, no data motion).
export function planFromDigest(localMap, remoteEntries) {
    const need = [];
    const send = [];
    const adopt = [];
    const seen = new Set();
    for (const entry of remoteEntries) {
        const k = entry[0], rh = entry[1], rx = entry[2];
        seen.add(k);
        const local = localMap.get(k);
        if (!local) { need.push(k); continue; }
        if (local.x === rx) {
            if (local.h !== rh) adopt.push([k, hlcCompare(local.h, rh) >= 0 ? local.h : rh]);
            continue;
        }
        if (hlcCompare(rh, local.h) > 0) need.push(k);
        else if (hlcCompare(local.h, rh) > 0) send.push(k);
        // equal HLC with differing hash can't happen (an HLC uniquely
        // identifies one write); no-op if it somehow does.
    }
    for (const k of localMap.keys()) {
        if (!seen.has(k)) send.push(k);
    }
    return { need, send, adopt };
}

// ---- apply decision (LWW) ----
// localRec may be undefined (key never seen locally). remoteEntry carries at
// least {h}, and either {v} / {del:1} (a live diff entry) or {x} (a hash,
// e.g. resolved from a digest exchange) — whichever the caller has on hand.
export function applyDecision(localRec, remoteEntry) {
    if (!localRec) return 'apply';
    if (remoteEntry.h === localRec.h) return 'skip'; // already applied this exact stamp
    if (remoteEntry.x !== undefined && remoteEntry.x === localRec.x) return 'adopt-hlc'; // same content, reconcile bookkeeping only
    return hlcCompare(remoteEntry.h, localRec.h) > 0 ? 'apply' : 'skip';
}

// ---- conflict detection ----
// "Concurrent loss" (pragmatic definition, not vector-clock concurrency):
// the local record being overwritten was authored by THIS device and the
// peer we're syncing with had not yet observed it (its per-pair replication
// cursor is older than the record's HLC, or there is no cursor at all yet).
export function isConcurrentLoss(localRec, cursorHlc, myDeviceId) {
    if (!localRec) return false;
    const p = hlcParse(localRec.h);
    if (!p || p.deviceId !== myDeviceId) return false;
    if (!cursorHlc) return true;
    return hlcCompare(localRec.h, cursorHlc) > 0;
}

// ---- inbound envelope validation ----
// Every field is checked before anything touches storage: bad envelopes are
// rejected with a reason, never partially trusted. `caps` = {maxEntries,
// valueMax} (SYNC_MAX_ENTRIES / SYNC_VALUE_MAX in production).
export function validateSyncEnvelope(env, caps) {
    if (!env || typeof env !== 'object') return { ok: false, reason: 'bad-op' };
    if (env.v !== 1) return { ok: false, reason: 'bad-v' };
    const op = env.op;
    if (op !== 'digest' && op !== 'req' && op !== 'diff') return { ok: false, reason: 'bad-op' };
    const maxEntries = (caps && typeof caps.maxEntries === 'number') ? caps.maxEntries : Infinity;
    const valueMax = (caps && typeof caps.valueMax === 'number') ? caps.valueMax : Infinity;

    if (op === 'digest') {
        const entries = env.entries;
        if (!Array.isArray(entries) || entries.length > maxEntries) return { ok: false, reason: 'too-many' };
        for (const e of entries) {
            if (!Array.isArray(e) || e.length !== 3) return { ok: false, reason: 'bad-key' };
            const k = e[0], h = e[1], x = e[2];
            if (!syncEligibleKey(k)) return { ok: false, reason: 'bad-key' };
            if (typeof h !== 'string' || !HLC_RE.test(h)) return { ok: false, reason: 'bad-hlc' };
            if (typeof x !== 'string' || !/^[0-9a-f]{64}$/.test(x)) return { ok: false, reason: 'bad-hash' };
        }
        return { ok: true, op: op };
    }

    if (op === 'req') {
        const keys = env.keys;
        if (!Array.isArray(keys) || keys.length > maxEntries) return { ok: false, reason: 'too-many' };
        for (const k of keys) {
            if (!syncEligibleKey(k)) return { ok: false, reason: 'bad-key' };
        }
        return { ok: true, op: op };
    }

    // op === 'diff'
    const entries = env.entries;
    if (!Array.isArray(entries) || entries.length > maxEntries) return { ok: false, reason: 'too-many' };
    for (const e of entries) {
        if (!e || typeof e !== 'object') return { ok: false, reason: 'bad-key' };
        if (!syncEligibleKey(e.k)) return { ok: false, reason: 'bad-key' };
        if (typeof e.h !== 'string' || !HLC_RE.test(e.h)) return { ok: false, reason: 'bad-hlc' };
        if (e.del === 1) continue;
        if (typeof e.v !== 'string' || e.v.length > valueMax) return { ok: false, reason: 'bad-value' };
    }
    return { ok: true, op: op };
}
