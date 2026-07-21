/* arcade-leaderboard-core.js — pure, DOM-free merge core for shared
 * leaderboards (union-merge of peer score entries into the real
 * arcade.v1.<gameId>.scores.<cat> boards). No storage, no network — the
 * launcher engine (arcade-leaderboard.js) owns those; this file owns the
 * math, so convergence is exhaustively unit-testable.
 *
 * WHY A SEPARATE CHANNEL (not Arcade.sync): the sync engine is strictly
 * last-writer-wins per whole key — a synced scores array is clobbered
 * wholesale, losing the other device's entries. A leaderboard needs set-union
 * semantics, so scores keys are carved out of sync (see arcade-sync.js) and
 * replicated here instead.
 *
 * CONVERGENCE (the load-bearing property, property-tested in
 * tools/leaderboard-unit.mjs): mergeBoards is `top-N(sort(A ∪ B))` under a
 * TOTAL order (score, then ts, then a stable per-entry identity). Union under
 * a total order + a deterministic cap is a semilattice join — commutative,
 * associative, idempotent — so N devices gossiping in ANY order reach the
 * byte-identical board, and re-merging an already-merged board reports
 * `changed:false`, which is what terminates the anti-entropy echo.
 *
 * Every inbound entry is validated like arcade-records-core does: peer data is
 * hostile. validateBoardEntry normalizes to a fixed field set, so once both
 * sides merge once, their stored bytes match exactly.
 */

import { KEY_PREFIX, syncEligibleKey } from './arcade-storage-core.js';
import { DEVICE_ID_RE, isPlainObject } from './arcade-envelope.js';
import { chunkEntries } from './arcade-sync-core.js';

export const SCORES_CAP = 100;                 // MUST equal the SDK's SCORES_CAP (asserted in units)
export const LB_ENTRY_MAX = 512;               // serialized bytes per entry
export const LB_BOARD_MAX = 32 * 1024;         // serialized bytes per board (a bigger board is skipped)
export const LB_FRAME_BUDGET = 96 * 1024;      // per-frame serialized budget (< transport 256 KB)
export const LB_MAX_BOARDS_PER_FRAME = 32;

const EID_RE = /^[A-Za-z0-9_-]{1,16}$/;

// A leaderboard key is a sync-eligible key whose second segment is exactly
// 'scores' with a non-empty category. (syncEligibleKey already rejects
// _meta/global/sidecars/ls.) Exported so arcade-sync.js can carve these out.
export function isLeaderboardKey(k) {
    if (!syncEligibleKey(k)) return false;
    const seg = k.slice(KEY_PREFIX.length).split('.');
    return seg[1] === 'scores' && seg.length >= 3 && seg.slice(2).join('.').length > 0;
}

// FNV-1a 32-bit → 8-hex. Synchronous (sha256Hex is async and merge must stay
// pure/sync). Used only as a legacy-entry fingerprint, never for security.
export function fnv1a32(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
}

// Dedupe identity for the union. Attributed entries (dev+eid, stamped by the
// SDK at add() time) are globally unique. Legacy/unattributed entries fall
// back to a content fingerprint — two byte-identical legacy entries collapse
// to one, which is acceptable for a leaderboard. Legacy entries are NEVER
// retroactively stamped: stamping at send time would make the two devices
// store different bytes and break convergence.
export function entryIdentity(e) {
    if (e && typeof e.dev === 'string' && e.dev && typeof e.eid === 'string' && e.eid) {
        return e.dev + ':' + e.eid;
    }
    return 'legacy:' + fnv1a32(JSON.stringify([
        e ? e.score : null,
        e ? e.ts : null,
        (e && typeof e.name === 'string') ? e.name : null,
        (e && typeof e.key === 'string') ? e.key : null
    ]));
}

// Validate + normalize one entry to a fixed field set, or null. Normalizing is
// what makes two devices' stored boards byte-identical after they merge.
export function validateBoardEntry(e) {
    if (!isPlainObject(e)) return null;
    if (typeof e.score !== 'number' || !isFinite(e.score)) return null;
    if (typeof e.ts !== 'number' || !isFinite(e.ts) || e.ts <= 0) return null;
    const out = { score: e.score, ts: e.ts };
    if (typeof e.name === 'string' && e.name) out.name = e.name.slice(0, 32);
    if (typeof e.key === 'string' && e.key) out.key = e.key.slice(0, 64);
    if (typeof e.dev === 'string' && DEVICE_ID_RE.test(e.dev)) out.dev = e.dev;
    if (typeof e.eid === 'string' && EID_RE.test(e.eid)) out.eid = e.eid;
    if (isPlainObject(e.meta)) out.meta = e.meta;
    let size;
    try { size = JSON.stringify(out).length; } catch (err) { return null; }
    if (size > LB_ENTRY_MAX && out.meta !== undefined) {
        delete out.meta;                       // meta is garnish — drop it before rejecting
        try { size = JSON.stringify(out).length; } catch (err) { return null; }
    }
    return size > LB_ENTRY_MAX ? null : out;
}

// Total order: primary score (per `order`), tie-break ts ascending, final
// tie-break the stable identity. Deterministic across devices → convergence.
function compareEntries(a, b, order) {
    if (a.score !== b.score) return order === 'asc' ? a.score - b.score : b.score - a.score;
    if (a.ts !== b.ts) return a.ts - b.ts;
    const ia = entryIdentity(a), ib = entryIdentity(b);
    return ia < ib ? -1 : ia > ib ? 1 : 0;
}

// Union-merge remoteEntries into localList under `order`, cap SCORES_CAP.
// resetAt (ms) drops REMOTE entries with ts <= resetAt (a local reset blocks
// resurrection of pre-reset entries here; peers keep their own copies).
// Returns { list, changed }; `changed` is a byte comparison against localList,
// so the first merge normalizes-and-writes and a converged board is stable.
export function mergeBoards(localList, remoteEntries, order, resetAt) {
    const cutoff = (typeof resetAt === 'number' && isFinite(resetAt)) ? resetAt : 0;
    const ord = order === 'asc' ? 'asc' : 'desc';
    const map = new Map();
    // Locals first so they win identity collisions (bytes already on disk win).
    if (Array.isArray(localList)) {
        for (const e of localList) {
            const n = validateBoardEntry(e);
            if (!n) continue;
            const id = entryIdentity(n);
            if (!map.has(id)) map.set(id, n);
        }
    }
    if (Array.isArray(remoteEntries)) {
        for (const e of remoteEntries) {
            const n = validateBoardEntry(e);
            if (!n || n.ts <= cutoff) continue;
            const id = entryIdentity(n);
            if (!map.has(id)) map.set(id, n);
        }
    }
    const merged = Array.from(map.values());
    merged.sort((a, b) => compareEntries(a, b, ord));
    if (merged.length > SCORES_CAP) merged.length = SCORES_CAP;
    const changed = JSON.stringify(merged) !== JSON.stringify(Array.isArray(localList) ? localList : []);
    return { list: merged, changed };
}

// Partition boards ([{k, order, list}]) into wire frames under the per-frame
// budget, skipping any single board that serializes over LB_BOARD_MAX (the
// engine logs the skip). Mirrors sync's oversize handling.
export function chunkBoards(boards) {
    const kept = [];
    const skipped = [];
    for (const b of (Array.isArray(boards) ? boards : [])) {
        let size;
        try { size = JSON.stringify(b).length; } catch (e) { skipped.push({ k: b && b.k, reason: 'unserializable' }); continue; }
        if (size > LB_BOARD_MAX) { skipped.push({ k: b.k, reason: 'oversize' }); continue; }
        kept.push(b);
    }
    return { frames: chunkEntries(kept, LB_MAX_BOARDS_PER_FRAME, LB_FRAME_BUDGET), skipped };
}

// Inbound envelope BODY validator (the transport-shape classifier lives in
// arcade-envelope.js). Frame-level shape + caps only — per-entry validation is
// mergeBoards's job, so one bad entry never rejects a whole frame.
export function validateLeaderboardEnvelope(env) {
    if (!isPlainObject(env)) return { ok: false, reason: 'bad-op' };
    if (env.v !== 1) return { ok: false, reason: 'bad-v' };
    if (env.op !== 'boards') return { ok: false, reason: 'bad-op' };
    const entries = env.entries;
    if (!Array.isArray(entries) || entries.length > LB_MAX_BOARDS_PER_FRAME) return { ok: false, reason: 'too-many' };
    for (const b of entries) {
        if (!isPlainObject(b)) return { ok: false, reason: 'bad-board' };
        if (!isLeaderboardKey(b.k)) return { ok: false, reason: 'bad-key' };
        if (b.order !== 'asc' && b.order !== 'desc') return { ok: false, reason: 'bad-order' };
        if (!Array.isArray(b.list) || b.list.length > SCORES_CAP) return { ok: false, reason: 'bad-list' };
    }
    return { ok: true, op: 'boards' };
}
