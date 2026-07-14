/* arcade-storage-core.js — shared primitives for the opaque-frame storage
 * bridge (arcade-storage-bridge.js) and the save/import machinery
 * (arcade-save.js).
 *
 * This is the ONE place every storage allowlist lives — key regexes, the
 * dunder guard, the store/file name checks, the import-protected set, and the
 * per-key/per-op size caps. Keeping them side by side is deliberate: the
 * launcher's whole storage trust boundary (games run sandboxed WITHOUT
 * allow-same-origin, so the launcher is their custodian) reduces to these
 * predicates, and drift between "what a bridge write accepts" and "what a save
 * export/import accepts" was a real bug class (a game key that round-trips
 * live but silently drops from every backup). One file = one audit surface.
 *
 * No top-level side effects: every browser global (localStorage, indexedDB,
 * navigator, crypto, Blob, FileReader, atob) is touched only inside a function
 * body, so this module imports cleanly in Node for unit-testing the pure
 * validation/checksum/key-predicate helpers (Node 20+ has globalThis.crypto).
 */

export const KEY_PREFIX = 'arcade.v1.';
// Anything outside this namespace is rejected on import, so an imported
// file can never poison non-arcade keys on the origin's localStorage.
export const KEY_RE = /^arcade\.v1\.[a-z0-9_-]+(\.[a-zA-Z0-9_.-]+)+$/;
// Dunder path segments are rejected outright: keys are inert in
// localStorage, but game code walks key paths and merges stored
// values, so a save file must never smuggle prototype-polluting
// segments past the allowlist.
export const DUNDER_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);
export function isSafeArcadeKey(k) {
    if (!KEY_RE.test(k)) return false;
    for (const seg of k.split('.')) {
        if (DUNDER_SEGMENTS.has(seg)) return false;
    }
    return true;
}
// Keys an import must NOT overwrite, even though export includes them for
// inspection. The save checksum is integrity, not authenticity — anyone
// can craft a valid file — so a malicious save could otherwise replace
// this device's identity or its TOFU trust records (fingerprint pins,
// auto-reconnect flags in knownPeers), laundering a future impostor past
// the fingerprint-changed warning. Restoring device identity/trust is a
// deliberate, separate action, never a silent side effect of a save load.
export const IMPORT_PROTECTED_KEYS = new Set([
    KEY_PREFIX + '_meta.knownPeers',
    KEY_PREFIX + '_meta.deviceId',
    KEY_PREFIX + '_meta.deviceName'
]);
export const SAVE_FORMAT = 'pauls-arcade-save';
// Schema 2 adds `stores` (Arcade.store IndexedDB) and `files`
// (Arcade.files OPFS/IDB blobs). v1 (localStorage-only) files still import.
export const SAVE_SCHEMA = 2;
// Blobs (base64, ~33% inflation) can make a full-fidelity save large.
export const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
export const PROBE_KEY = KEY_PREFIX + '_meta.probe';

// ---- ls-proxy key namespace ----
// hecknsic (and potentially other games) install a postMessage-backed shim
// that overrides window.localStorage; per-game keys live under
// arcade.v1.<gameId>.ls.<key> so they ride along with save/load bundling.
export function lsPrefix(gameId) { return KEY_PREFIX + gameId + '.ls.'; }
// A legacy ls-proxy key stores its sub-key verbatim, so it can contain
// characters (spaces, ':', '/') that the stricter isSafeArcadeKey regex
// rejects — which would silently drop it from every save/restore. Export
// and import treat the whole '.ls.' subtree as backup-eligible as long
// as it stays inside a valid game namespace and carries no dunder
// segment (so it can't poison prototypes or escape the namespace).
export const LS_PROXY_KEY_RE = /^arcade\.v1\.[a-z0-9_-]+\.ls\..+$/;
export function isLsProxyBackupKey(k) {
    if (!LS_PROXY_KEY_RE.test(k)) return false;
    for (const seg of k.split('.')) { if (DUNDER_SEGMENTS.has(seg)) return false; }
    return true;
}

// ---- bridge size caps + write allowlist ----
export const BRIDGE_VALUE_MAX = 2 * 1024 * 1024; // per-key sanity cap
// Per-op caps for the async bridge. A runaway game must not exhaust the
// shared origin quota (the qrp2p identity/pairing key stores live there
// too — draining it would break P2P persistence arcade-wide).
export const BRIDGE_STORE_VALUE_MAX = 16 * 1024 * 1024;
export const BRIDGE_FILE_MAX = 64 * 1024 * 1024;
export function approxSize(v) {
    if (v == null) return 0;
    if (typeof v === 'string') return v.length;
    if (v instanceof Blob) return v.size;
    if (v instanceof ArrayBuffer) return v.byteLength;
    if (ArrayBuffer.isView(v)) return v.byteLength;
    try { return JSON.stringify(v).length; } catch (e) { return Infinity; }
}
export const SETTINGS_KEY_RE = /^arcade\.v1\.global\.(fontScale|theme|reducedMotion|audioVolume|handedness)$/;

export function bridgeKeyWritable(gameId, key) {
    if (typeof key !== 'string' || key.length > 512) return false;
    if (key === KEY_PREFIX + '_meta.dev') return true;
    if (!isSafeArcadeKey(key)) return false;
    return key.startsWith(KEY_PREFIX + gameId + '.')
        || key.startsWith(KEY_PREFIX + 'global.');
}

export const STORE_NAME_RE = /^[a-z0-9_-]{1,64}$/i;
// Mirrors the SDK's direct-mode backend choice exactly (OPFS when
// navigator.storage.getDirectory exists, per-app IDB '.files' otherwise) so
// data written before this launcher version — or via save import — is found
// where the game itself would have put it.
export const BRIDGE_FILE_NAME_RE = /^[a-z0-9._-]{1,128}$/i;

// ---- canonical checksum ----
export async function checksumData(data) {
    const keys = Object.keys(data).sort();
    const parts = new Array(keys.length);
    for (let i = 0; i < keys.length; i++) {
        parts[i] = JSON.stringify(keys[i]) + ':' + JSON.stringify(data[keys[i]]);
    }
    const canonical = '{' + parts.join(',') + '}';
    const buf = new TextEncoder().encode(canonical);
    const hash = await crypto.subtle.digest('SHA-256', buf);
    const bytes = new Uint8Array(hash);
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
        hex += bytes[i].toString(16).padStart(2, '0');
    }
    return 'sha256:' + hex;
}

// ---- async per-app storage (Arcade.store / Arcade.files) ----
// The SDK keeps large/binary app data in per-app IndexedDB databases
// (arcade.v1.<gameId>.store.<name> and arcade.v1.<gameId>.files) and
// OPFS dirs (arcade.v1.<gameId>). The launcher enumerates them so a
// save bundle is a full-fidelity backup, not just localStorage. The
// allowlist regexes below never match the P2P key stores (qrp2p-*),
// so device identity/pairing secrets are never exported.
export const STORE_DB_RE = /^arcade\.v1\.[a-z0-9_-]+\.store\.[a-z0-9_-]{1,64}$/i;
export const FILE_GID_RE = /^arcade\.v1\.[a-z0-9_-]+$/i;
export const FILE_NAME_RE = /^[a-z0-9._-]{1,128}$/i;

export function hasDunderSegment(s) {
    return s.split('.').some((seg) => DUNDER_SEGMENTS.has(seg));
}

// Recursive key-sorted stringify → a deterministic canonical form so the
// checksum is stable regardless of property order.
export function stableStringify(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
    const keys = Object.keys(v).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}
export async function checksumBundle(data, stores, files) {
    const canonical = stableStringify({ data: data, stores: stores, files: files });
    const buf = new TextEncoder().encode(canonical);
    const hash = await crypto.subtle.digest('SHA-256', buf);
    const bytes = new Uint8Array(hash);
    let hex = '';
    for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
    return 'sha256:' + hex;
}

// Minimal IndexedDB helpers (the SDK's stores all use a single 'kv'
// object store; opening with this upgrade is compatible).
export function idbOpen(name) {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(name, 1);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}
export function idbAll(db) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction('kv', 'readonly');
        const s = tx.objectStore('kv');
        const keysReq = s.getAllKeys();
        const valsReq = s.getAll();
        tx.oncomplete = () => {
            const out = [];
            for (let i = 0; i < keysReq.result.length; i++) {
                out.push({ key: keysReq.result[i], value: valsReq.result[i] });
            }
            resolve(out);
        };
        tx.onerror = () => reject(tx.error);
    });
}
export function idbPut(db, key, value) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}
export function idbGet(db, key) {
    return new Promise((resolve, reject) => {
        const req = db.transaction('kv', 'readonly').objectStore('kv').get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}
export function idbDel(db, key) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}
export function idbClear(db) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}
export function blobToB64(blob) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onerror = () => reject(new Error('blob read failed'));
        r.onload = () => {
            const s = String(r.result);
            const i = s.indexOf(',');
            resolve(i >= 0 ? s.slice(i + 1) : '');
        };
        r.readAsDataURL(blob);
    });
}
export function b64ToBlob(b64, type) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: type || 'application/octet-stream' });
}
// indexedDB.databases() is Chromium/Safari-only (absent in Firefox).
// Store enumeration needs it; without it we still export localStorage
// and (deterministically-named) OPFS files, just not IndexedDB stores.
export async function listArcadeDbNames() {
    if (!indexedDB.databases) return null;
    try {
        const dbs = await indexedDB.databases();
        return dbs.map((d) => d && d.name).filter(Boolean);
    } catch (e) { return null; }
}
export function opfsRoot() {
    if (navigator.storage && navigator.storage.getDirectory) return navigator.storage.getDirectory();
    return Promise.resolve(null);
}
