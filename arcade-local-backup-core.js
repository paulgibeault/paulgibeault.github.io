/* arcade-local-backup-core.js — pure primitives for automatic local backup
 * (#30). Companion to arcade-backup-core.js: that file owns the
 * kind:'backup' peer-transfer envelope + chunking; this one owns the
 * device-local snapshot key format and the staleness check the launcher-side
 * engine (arcade-local-backup.js) is built from. Retention/dedup reuses
 * arcade-backup-core.js's planGenerationStore verbatim — it has no
 * per-sender dimension baked into it, so a flat, single-chain history (one
 * device, no deviceId) is exactly the shape it already operates on. One
 * tested implementation, two consumers.
 *
 * No top-level side effects: imports cleanly in Node so the staleness/key
 * helpers can be unit-tested without a browser (see tools/local-backup-unit.mjs).
 */

// ---- storage constants ----
export const LOCAL_BACKUP_DB = 'arcade-local-backup';
// Generations kept. Matches arcade-backup-core.js's BACKUP_GENERATIONS by
// deliberate choice (both backup features share one retention policy) —
// this is the sole local safety net for a user who never exports manually,
// but still bounded against large blob-heavy bundles.
export const LOCAL_BACKUP_GENERATIONS = 3;
// A boot re-snapshots only when the newest kept generation is at least this
// stale.
export const LOCAL_BACKUP_STALE_MS = 24 * 60 * 60 * 1000;
// Same ceiling as a save-file import (arcade-storage-core.js MAX_IMPORT_BYTES) —
// this feature stores the identical bundle, just locally instead of via a file.
export const LOCAL_BACKUP_MAX_CHARS = 64 * 1024 * 1024;

// ---- snapshot storage keys ----
// 's|<ms:13 digits>' — no per-sender dimension (one device, one chain), so
// simpler than arcade-backup-core.js's genKey('g|<deviceId>|<ms>'); the
// fixed-width millis field still makes plain lexicographic ordering
// chronological.
export function localSnapshotKey(ms) {
    return 's|' + String(Math.trunc(ms)).padStart(13, '0');
}

// ---- staleness ----
// No prior snapshot (null/undefined/non-finite newestAt) always counts as
// stale — a fresh install must accrue one on its very first boot.
export function isSnapshotStale(newestAt, now, staleMs) {
    if (newestAt == null || !Number.isFinite(newestAt)) return true;
    const window_ = staleMs == null ? LOCAL_BACKUP_STALE_MS : staleMs;
    return (now - newestAt) >= window_;
}

// ---- build-avoidance fingerprint (durability design, PR 7) ----
// A generation's meta row may carry the checksums of its bundle's data
// section and manifest section (arcade-save.js exportBundleString /
// durabilityFingerprint — computed identically on both sides). When the
// device's CURRENT cheap fingerprint equals the newest generation's, nothing
// a bundle would carry has changed, so the engine renews the staleness clock
// WITHOUT assembling the full bundle. Fails closed: a legacy meta (no
// fingerprint fields) or an unavailable fingerprint never matches, so those
// devices build-and-compare exactly as before.
export function fingerprintMatches(meta, fp) {
    return !!(meta && fp
        && typeof meta.dataChecksum === 'string' && meta.dataChecksum === fp.dataChecksum
        && typeof meta.manifestChecksum === 'string' && meta.manifestChecksum === fp.manifestChecksum);
}

// ---- retention/dedup: reused as-is, not reimplemented ----
export { planGenerationStore } from './arcade-backup-core.js';
