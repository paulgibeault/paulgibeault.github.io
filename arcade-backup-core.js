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
    if (op !== 'offer' && op !== 'accept' && op !== 'decline' && op !== 'chunk' && op !== 'ack') {
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
