/* arcade-backup-core.js — pure primitives for backup-to-trusted-peer (#31).
 * Companion to arcade-sync-core.js: that file owns the Arcade.sync wire
 * shapes; this one owns the kind:'backup' envelope BODY validator, the
 * bundle-string chunking, and the generation-retention decision the
 * launcher-side backup engine (arcade-backup.js) is built from.
 *
 * The payload being moved is a full save bundle (arcade-save.js buildBundle):
 * already checksummed, already covered by the import gates on the receiving
 * side (validateSaveBundle re-verifies shape, per-key allowlist, and checksum
 * before a restore commits anything). This module never parses the bundle —
 * it only moves and stores the serialized string.
 *
 * No top-level side effects: imports cleanly in Node so the validator,
 * chunker, and retention plan can be unit-tested without a browser (see
 * tools/backup-unit.mjs).
 */

import { sha256Hex, hlcCompare } from './arcade-sync-core.js';

// ---- protocol + storage constants ----
export const BACKUP_PROTOCOL_V = 1;
export const BACKUP_DB = 'arcade-backup';
// Generations kept per sender deviceId. Small on purpose: a backup target
// holds the peer's LAST few states, it is not a version-history feature.
export const BACKUP_GENERATIONS = 3;
// Chunk size for the serialized bundle. The transport frame cap is 256 KB;
// a 64 KB body leaves ample headroom even after JSON string-escaping of the
// embedded bundle text (worst case ~2x) plus envelope overhead.
export const BACKUP_CHUNK_CHARS = 64 * 1024;
// Structural cap on a single transfer's part count (the same reject-before-
// buffering posture as arcade-sync.js's MAX_DIGEST_PARTS): 512 × 64 KB
// bounds a transfer at 32M chars, well under MAX_IMPORT_BYTES.
export const BACKUP_MAX_PARTS = 512;
export const BACKUP_MAX_CHARS = BACKUP_CHUNK_CHARS * BACKUP_MAX_PARTS;

// The bundle checksum shape arcade-storage-core.js's checksumBundle mints.
const CHECKSUM_RE = /^sha256:[0-9a-f]{64}$/;

// ---- delta transfers (durability design §6, PR 8) ----
// A delta is a TRANSFER optimization, never a storage format: the receiver
// materializes the full bundle from its stored base generation + the delta
// document, must arrive at the offer's exact checksum, and then runs the
// full validateSaveBundle gate before storing — a delta can never smuggle
// state a full transfer couldn't. Wire stays v1 with additive ops: an
// offer may carry `deltaFrom` (old receivers ignore unknown fields and
// reply plain 'accept' ⇒ full transfer); a receiver holding that base
// replies 'accept-delta'; the sender answers with 'delta-info' (the delta
// document's chars/parts — the offer's counts describe the FULL bundle)
// and the delta rides the unchanged chunk/ack framing.
export const BACKUP_DELTA_FORMAT = 'pauls-arcade-backup-delta';
export const BACKUP_DELTA_V = 1;

// ---- chunking ----
// Fixed-width slices of the serialized bundle; ''.length === 0 still yields
// one chunk so `parts` is always >= 1 (mirrors chunkEntries' contract —
// the receiver needs at least one frame to know the transfer completed).
export function chunkString(s, size) {
    const chunks = [];
    for (let i = 0; i < s.length; i += size) chunks.push(s.slice(i, i + size));
    if (chunks.length === 0) chunks.push('');
    return chunks;
}

// ---- generation storage keys ----
// 'g|<deviceId>|<ms:13 digits>' — the fixed-width millis field makes plain
// lexicographic ordering of a sender's keys chronological (same trick as
// the HLC's packed millis).
export function genKey(deviceId, ms) {
    return 'g|' + deviceId + '|' + String(Math.trunc(ms)).padStart(13, '0');
}

// ---- generation retention ----
// existing: [{key, checksum}] for ONE sender, sorted oldest-first (the
// engine sorts by key — see genKey). Decides whether an arriving bundle
// becomes a new generation and which old ones fall off the end:
//   - identical content to the NEWEST kept generation → don't store
//     (reconnect churn must not burn generations on unchanged data)
//   - otherwise store, and prune oldest until `cap` remain (including the
//     newcomer).
export function planGenerationStore(existing, incomingChecksum, cap) {
    const newest = existing.length ? existing[existing.length - 1] : null;
    if (newest && newest.checksum === incomingChecksum) return { store: false, prune: [] };
    const excess = existing.length + 1 - cap;
    return {
        store: true,
        prune: excess > 0 ? existing.slice(0, excess).map((g) => g.key) : []
    };
}

// ---- inbound envelope validation ----
// Every field is checked before anything is buffered or stored: bad
// envelopes are rejected with a reason, never partially trusted (the
// validateSyncEnvelope house style). Ops:
//   offer   {id, checksum, chars, parts, exportedAt} — sender proposes a
//            transfer; receiver answers accept/decline after the consent gate
//   accept  {id}
//   decline {id, reason?}
//   chunk   {id, seq, parts, body} — one slice of the serialized bundle
//   ack     {id, checksum} — receiver stored a generation successfully
export function validateBackupEnvelope(env) {
    if (!env || typeof env !== 'object') return { ok: false, reason: 'bad-op' };
    if (env.v !== BACKUP_PROTOCOL_V) return { ok: false, reason: 'bad-v' };
    const op = env.op;
    if (op !== 'offer' && op !== 'accept' && op !== 'decline' && op !== 'chunk' && op !== 'ack'
        && op !== 'accept-delta' && op !== 'delta-info') {
        return { ok: false, reason: 'bad-op' };
    }
    if (typeof env.id !== 'string' || env.id.length < 1 || env.id.length > 64) {
        return { ok: false, reason: 'bad-id' };
    }

    if (op === 'offer') {
        if (typeof env.checksum !== 'string' || !CHECKSUM_RE.test(env.checksum)) return { ok: false, reason: 'bad-checksum' };
        if (!Number.isInteger(env.chars) || env.chars < 1 || env.chars > BACKUP_MAX_CHARS) return { ok: false, reason: 'bad-size' };
        if (!Number.isInteger(env.parts) || env.parts < 1 || env.parts > BACKUP_MAX_PARTS) return { ok: false, reason: 'bad-size' };
        if (typeof env.exportedAt !== 'string' || env.exportedAt.length > 40) return { ok: false, reason: 'bad-meta' };
        // deltaFrom is OPTIONAL (absent on offers with no usable base) —
        // when present it names the base bundle checksum a delta could be
        // computed against. Old receivers never look at it.
        if (env.deltaFrom !== undefined
            && (typeof env.deltaFrom !== 'string' || !CHECKSUM_RE.test(env.deltaFrom))) {
            return { ok: false, reason: 'bad-checksum' };
        }
        return { ok: true, op: op };
    }

    if (op === 'accept-delta') {
        if (typeof env.base !== 'string' || !CHECKSUM_RE.test(env.base)) return { ok: false, reason: 'bad-checksum' };
        return { ok: true, op: op };
    }

    if (op === 'delta-info') {
        if (!Number.isInteger(env.chars) || env.chars < 1 || env.chars > BACKUP_MAX_CHARS) return { ok: false, reason: 'bad-size' };
        if (!Number.isInteger(env.parts) || env.parts < 1 || env.parts > BACKUP_MAX_PARTS) return { ok: false, reason: 'bad-size' };
        return { ok: true, op: op };
    }

    if (op === 'chunk') {
        if (!Number.isInteger(env.parts) || env.parts < 1 || env.parts > BACKUP_MAX_PARTS) return { ok: false, reason: 'bad-size' };
        if (!Number.isInteger(env.seq) || env.seq < 0 || env.seq >= env.parts) return { ok: false, reason: 'bad-seq' };
        if (typeof env.body !== 'string' || env.body.length > BACKUP_CHUNK_CHARS) return { ok: false, reason: 'bad-body' };
        return { ok: true, op: op };
    }

    if (op === 'ack') {
        if (typeof env.checksum !== 'string' || !CHECKSUM_RE.test(env.checksum)) return { ok: false, reason: 'bad-checksum' };
        return { ok: true, op: op };
    }

    // accept / decline
    if (op === 'decline' && env.reason !== undefined
        && (typeof env.reason !== 'string' || env.reason.length > 32)) {
        return { ok: false, reason: 'bad-meta' };
    }
    return { ok: true, op: op };
}

// ---- delta build / apply (durability §6) ----
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// Per-key content hashes of a bundle's data section. Reuses the journal's
// already-computed hashes where a live record exists; keys outside journal
// coverage (`_meta.*`, `global.*`, import-committed keys) are hashed here —
// a journal-only diff would silently miss their changes.
export async function dataHashesOf(bundleObj) {
    const out = {};
    const data = (bundleObj && bundleObj.data) || {};
    const jrec = (bundleObj && bundleObj.journal && bundleObj.journal.records) || {};
    for (const k of Object.keys(data)) {
        const r = jrec[k];
        out[k] = (r && typeof r.x === 'string' && r.del !== 1) ? r.x : await sha256Hex(data[k]);
    }
    return out;
}

// What the SENDER persists per peer alongside the acked checksum ('a|'
// rows): everything a future delta build needs to diff against the acked
// bundle WITHOUT holding the bundle itself — per-key data hashes, the
// manifest's whole-DB/whole-file hashes, and the bundle journal clock (the
// watermark guard input). null when the bundle lacks journal/manifest
// sections (pre-durability build) — no delta base, full transfers only.
export async function senderBaseInfo(bundleObj) {
    if (!bundleObj || !bundleObj.journal || !bundleObj.manifest) return null;
    return {
        clock: (typeof bundleObj.journal.clock === 'string') ? bundleObj.journal.clock : null,
        dataHashes: await dataHashesOf(bundleObj),
        storeHashes: { ...(bundleObj.manifest.stores || {}) },
        fileHashes: { ...(bundleObj.manifest.files || {}) }
    };
}

// The §6 correctness guard: cap-only tombstone GC evicts the oldest
// tombstones past the per-app cap; a delta computed against a base older
// than an evicted tombstone may not be able to express that deletion. The
// engine persists an eviction watermark (max evicted HLC); an offer may
// carry deltaFrom only when the base bundle's journal clock is >= that
// ceiling (or nothing was ever evicted). Conservative and cheap — the
// ceiling only moves when an app exceeds the 512-tombstone cap.
export function deltaOfferAllowed(info, ceiling) {
    if (!info || typeof info.checksum !== 'string') return false;
    if (!info.dataHashes || !info.storeHashes || !info.fileHashes) return false;
    if (ceiling === null || ceiling === undefined) return true;
    return typeof info.clock === 'string' && hlcCompare(info.clock, ceiling) >= 0;
}

// Diffs the CURRENT full bundle (parsed, with journal+manifest sections)
// against the persisted base info. Returns the delta document, or null when
// no delta can be built (missing sections/hashes). Deletions come from
// key-set presence (base hash exists, key gone now) — NOT from current
// tombstones — so an evicted tombstone cannot silently drop a deletion from
// the diff; the watermark guard above stays defense-in-depth.
export async function buildBackupDelta(baseInfo, bundleObj) {
    if (!baseInfo || !baseInfo.dataHashes || !baseInfo.storeHashes || !baseInfo.fileHashes) return null;
    if (typeof baseInfo.checksum !== 'string') return null;
    if (!bundleObj || !bundleObj.manifest || !bundleObj.journal
        || typeof bundleObj.checksum !== 'string') return null;

    const curHashes = await dataHashesOf(bundleObj);
    const set = {};
    const del = [];
    for (const k of Object.keys(curHashes)) {
        if (baseInfo.dataHashes[k] !== curHashes[k]) set[k] = bundleObj.data[k];
    }
    for (const k of Object.keys(baseInfo.dataHashes)) {
        if (!hasOwn(curHashes, k)) del.push(k);
    }

    const stores = {};
    const delStores = [];
    const curStores = bundleObj.manifest.stores || {};
    for (const n of Object.keys(curStores)) {
        if (baseInfo.storeHashes[n] !== curStores[n]) stores[n] = (bundleObj.stores || {})[n];
    }
    for (const n of Object.keys(baseInfo.storeHashes)) {
        if (!hasOwn(curStores, n)) delStores.push(n);
    }

    const byPath = new Map();
    const bfiles = bundleObj.files || {};
    for (const dir of Object.keys(bfiles)) {
        for (const it of (Array.isArray(bfiles[dir]) ? bfiles[dir] : [])) {
            if (it && typeof it.name === 'string') byPath.set(dir + '/' + it.name, it);
        }
    }
    const files = {};
    const delFiles = [];
    const curFiles = bundleObj.manifest.files || {};
    for (const p of Object.keys(curFiles)) {
        if (baseInfo.fileHashes[p] !== curFiles[p] && byPath.has(p)) files[p] = byPath.get(p);
    }
    for (const p of Object.keys(baseInfo.fileHashes)) {
        if (!hasOwn(curFiles, p)) delFiles.push(p);
    }

    // File arrays are ORDER-SENSITIVE under the canonical checksum
    // (stableStringify sorts object keys but preserves array order), and
    // the receiver cannot know what order the sender's fresh enumeration
    // produced — carry it, so materialization reproduces the target bundle
    // exactly even when backends enumerate differently across builds.
    const fileOrder = {};
    for (const dir of Object.keys(bfiles)) {
        fileOrder[dir] = (Array.isArray(bfiles[dir]) ? bfiles[dir] : [])
            .filter((it) => it && typeof it.name === 'string')
            .map((it) => it.name);
    }

    return {
        format: BACKUP_DELTA_FORMAT,
        v: BACKUP_DELTA_V,
        from: baseInfo.checksum,
        to: bundleObj.checksum,
        exportedAt: String(bundleObj.exportedAt || '').slice(0, 40),
        set, del, stores, delStores, files, delFiles, fileOrder,
        // The stored generation must carry CURRENT provenance sections, not
        // the base's stale ones — restores seed from them (PR 7) and future
        // deltas diff against them.
        journal: bundleObj.journal,
        manifest: bundleObj.manifest
    };
}

// Structural gate over a reassembled delta document. Deliberately shallow:
// the materialized bundle runs the FULL validateSaveBundle gate afterwards
// (checksum, per-key allowlist, shape), so this only has to keep the apply
// step itself safe — types, key shapes, and checksum fields.
export function validateBackupDelta(doc) {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, reason: 'bad-shape' };
    if (doc.format !== BACKUP_DELTA_FORMAT || doc.v !== BACKUP_DELTA_V) return { ok: false, reason: 'bad-format' };
    if (typeof doc.from !== 'string' || !CHECKSUM_RE.test(doc.from)) return { ok: false, reason: 'bad-checksum' };
    if (typeof doc.to !== 'string' || !CHECKSUM_RE.test(doc.to)) return { ok: false, reason: 'bad-checksum' };
    if (doc.exportedAt !== undefined && (typeof doc.exportedAt !== 'string' || doc.exportedAt.length > 40)) return { ok: false, reason: 'bad-meta' };
    const isMap = (v) => v && typeof v === 'object' && !Array.isArray(v);
    const isStrArr = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string' && s.length <= 512);
    if (!isMap(doc.set) || !isStrArr(doc.del)) return { ok: false, reason: 'bad-data' };
    for (const k of Object.keys(doc.set)) {
        if (k.length > 512 || typeof doc.set[k] !== 'string') return { ok: false, reason: 'bad-data' };
    }
    if (!isMap(doc.stores) || !isStrArr(doc.delStores)) return { ok: false, reason: 'bad-stores' };
    for (const n of Object.keys(doc.stores)) {
        if (!isMap(doc.stores[n])) return { ok: false, reason: 'bad-stores' };
    }
    if (!isMap(doc.files) || !isStrArr(doc.delFiles)) return { ok: false, reason: 'bad-files' };
    for (const p of Object.keys(doc.files)) {
        const it = doc.files[p];
        if (p.indexOf('/') <= 0 || !isMap(it) || typeof it.name !== 'string' || typeof it.b64 !== 'string') {
            return { ok: false, reason: 'bad-files' };
        }
    }
    if (doc.fileOrder !== undefined) {
        if (!isMap(doc.fileOrder)) return { ok: false, reason: 'bad-files' };
        for (const dir of Object.keys(doc.fileOrder)) {
            if (!isStrArr(doc.fileOrder[dir])) return { ok: false, reason: 'bad-files' };
        }
    }
    return { ok: true };
}

// Materializes the target bundle's sections from the stored base bundle +
// a (validated) delta document. Null-prototype scratch objects so a hostile
// '__proto__'/'constructor' key in the delta can only ever become an own
// property — never prototype pollution; the dunder key itself then fails
// the downstream validateSaveBundle allowlist or the checksum match.
export function applyBackupDelta(baseObj, doc) {
    const data = Object.assign(Object.create(null), (baseObj && baseObj.data) || {});
    for (const k of doc.del) delete data[k];
    for (const k of Object.keys(doc.set)) data[k] = doc.set[k];

    const stores = Object.assign(Object.create(null), (baseObj && baseObj.stores) || {});
    for (const n of doc.delStores) delete stores[n];
    for (const n of Object.keys(doc.stores)) stores[n] = doc.stores[n];

    const byPath = new Map();
    const bfiles = (baseObj && baseObj.files) || {};
    for (const dir of Object.keys(bfiles)) {
        for (const it of (Array.isArray(bfiles[dir]) ? bfiles[dir] : [])) {
            if (it && typeof it.name === 'string') byPath.set(dir + '/' + it.name, { dir, it });
        }
    }
    for (const p of doc.delFiles) byPath.delete(p);
    for (const p of Object.keys(doc.files)) {
        const slash = p.indexOf('/');
        byPath.set(p, { dir: p.slice(0, slash), it: doc.files[p] });
    }
    const files = Object.create(null);
    for (const [p, { dir, it }] of byPath.entries()) {
        if (!files[dir]) files[dir] = [];
        files[dir].push({ path: p, it });
    }
    // Reproduce the SENDER's per-dir item order (doc.fileOrder) — file
    // arrays are order-sensitive under the canonical checksum. Items the
    // order list doesn't mention keep their insertion order at the end.
    const order = (doc.fileOrder && typeof doc.fileOrder === 'object') ? doc.fileOrder : {};
    const out = Object.create(null);
    for (const dir of Object.keys(files)) {
        const names = Array.isArray(order[dir]) ? order[dir] : [];
        const rank = new Map(names.map((n, i) => [dir + '/' + n, i]));
        files[dir].sort((a, b) => {
            const ra = rank.has(a.path) ? rank.get(a.path) : Infinity;
            const rb = rank.has(b.path) ? rank.get(b.path) : Infinity;
            return ra - rb;
        });
        out[dir] = files[dir].map((e) => e.it);
    }
    // Plain-prototype copies for JSON round-tripping/consumers downstream.
    return { data: { ...data }, stores: { ...stores }, files: { ...out } };
}
