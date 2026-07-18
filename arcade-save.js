/* arcade-save.js — full-fidelity save export / import for the launcher.
 *
 * A save bundle is a complete backup of a device's arcade data: localStorage
 * (per-game state, global settings, ls-proxy subtrees), Arcade.store IndexedDB
 * databases, and Arcade.files blobs (OPFS or IDB fallback). Export gathers all
 * three, signs them with a canonical checksum, and downloads a JSON file.
 * Import verifies the checksum, filters every key through the same allowlist
 * the live storage bridge uses (arcade-storage-core.js), refuses to overwrite
 * device-identity / TOFU-trust records, auto-backs-up the current state, then
 * commits behind a synchronous snapshot/rollback for the localStorage half.
 *
 * The bundle-validation gates (shape → per-key allowlist → checksum) are
 * exported as a pure `validateSaveBundle` so they can be unit-tested in Node
 * without a browser (see tools/save-validation-unit.mjs) — allowlist drift is
 * then visible and pinned in one place.
 *
 * initSaveLoad(host) wires the Save/Load buttons; `host` supplies the
 * launcher-owned glue (see index.html's window.__arcade.storageHost). It
 * returns the bundle API the backup engine builds on (exportBundleString /
 * importBundleJson) — the same buildBundle + gates 4–10 pipeline, minus the
 * file layer.
 */

import {
    KEY_PREFIX,
    isSafeArcadeKey,
    isLsProxyBackupKey,
    IMPORT_PROTECTED_KEYS,
    SAVE_FORMAT,
    SAVE_SCHEMA,
    MAX_IMPORT_BYTES,
    PROBE_KEY,
    checksumData,
    checksumBundle,
    checksumCanonical,
    syncEligibleKey,
    STORE_DB_RE,
    FILE_GID_RE,
    FILE_NAME_RE,
    hasDunderSegment,
    idbOpen,
    idbAll,
    idbPut,
    blobToB64,
    b64ToBlob,
    listArcadeDbNames,
    opfsRoot
} from './arcade-storage-core.js';
import { HLC_RE } from './arcade-sync-core.js';

// ---- bundle provenance sections (durability design §4, Node-testable) ----
// Optional, additive, SELF-checksummed `journal` + `manifest` top-level
// sections at schemaVersion 2 — the same additive-superset pattern as
// welcome.caps and the SDP-codec extras trailer. validateSaveBundle reads
// only the fields it knows, so every existing device provably ignores them;
// the outer checksum keeps covering exactly data/stores/files. The sections
// are advisory, never authoritative: a tampered or absent section degrades
// consumers to today's behavior (no clock seed, no tombstone adoption, no
// delta) and can never grant write authority the bundle body lacks.
export const JOURNAL_SECTION_V = 1;
export const MANIFEST_SECTION_V = 1;
const REC_HASH_RE = /^[0-9a-f]{64}$/;
const SECTION_SUM_RE = /^sha256:[0-9a-f]{64}$/;

// records: { fullKey: {h, x, del, t} } (both classes merged — class is a
// device-local property, not a bundle property). Bounded by construction:
// only keys present in `data` (dataKeys) plus tombstones, so the section can
// never dwarf the data it annotates.
export async function buildJournalSection(clock, records, dataKeys) {
    const bounded = {};
    for (const k of Object.keys(records || {})) {
        const rec = records[k];
        if (!rec) continue;
        if (rec.del !== 1 && !(dataKeys && dataKeys.has(k))) continue;
        bounded[k] = { h: rec.h, x: rec.x, del: rec.del ? 1 : 0, t: rec.t };
    }
    const clk = (typeof clock === 'string') ? clock : null;
    return {
        v: JOURNAL_SECTION_V,
        clock: clk,
        records: bounded,
        checksum: await checksumCanonical({ clock: clk, records: bounded })
    };
}

// Shape + self-checksum gate for a bundle's journal section. Fails closed to
// { ok: false } on ANY irregularity — consumers then treat the bundle as
// journal-less (today's behavior), never partially trust a section.
export async function verifyJournalSection(journal) {
    if (!journal || typeof journal !== 'object' || Array.isArray(journal)) return { ok: false };
    if (journal.v !== JOURNAL_SECTION_V) return { ok: false };
    const clk = journal.clock;
    if (clk !== null && (typeof clk !== 'string' || !HLC_RE.test(clk))) return { ok: false };
    const records = journal.records;
    if (!records || typeof records !== 'object' || Array.isArray(records)) return { ok: false };
    for (const k of Object.keys(records)) {
        if (!syncEligibleKey(k)) return { ok: false };
        const rec = records[k];
        if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return { ok: false };
        if (typeof rec.h !== 'string' || !HLC_RE.test(rec.h)) return { ok: false };
        if (typeof rec.x !== 'string' || !REC_HASH_RE.test(rec.x)) return { ok: false };
        if (rec.del !== 0 && rec.del !== 1) return { ok: false };
        if (typeof rec.t !== 'number' || !Number.isFinite(rec.t) || rec.t < 0) return { ok: false };
    }
    let expected;
    try { expected = await checksumCanonical({ clock: clk, records: records }); } catch (e) { return { ok: false }; }
    if (journal.checksum !== expected) return { ok: false };
    return { ok: true, clock: clk, records: records };
}

// One content hash per store DB and per file — already-serialized material
// (the bundle carries every row/blob anyway), so hashing at build time is
// marginal. Change detection and deltas for these sections operate at
// whole-DB / whole-file granularity, which matches how they actually change
// (blobs are replaced, not edited).
export async function buildManifestSection(stores, files) {
    const storeHashes = {};
    for (const name of Object.keys(stores || {})) {
        storeHashes[name] = await checksumCanonical(stores[name]);
    }
    const fileHashes = {};
    for (const dir of Object.keys(files || {})) {
        const items = Array.isArray(files[dir]) ? files[dir] : [];
        for (const it of items) {
            if (!it || typeof it.name !== 'string') continue;
            fileHashes[dir + '/' + it.name] = await checksumCanonical(typeof it.b64 === 'string' ? it.b64 : '');
        }
    }
    return {
        v: MANIFEST_SECTION_V,
        stores: storeHashes,
        files: fileHashes,
        checksum: await checksumCanonical({ stores: storeHashes, files: fileHashes })
    };
}

export async function verifyManifestSection(manifest) {
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return { ok: false };
    if (manifest.v !== MANIFEST_SECTION_V) return { ok: false };
    const stores = manifest.stores, files = manifest.files;
    if (!stores || typeof stores !== 'object' || Array.isArray(stores)) return { ok: false };
    if (!files || typeof files !== 'object' || Array.isArray(files)) return { ok: false };
    for (const name of Object.keys(stores)) {
        if (!STORE_DB_RE.test(name) || hasDunderSegment(name)) return { ok: false };
        if (typeof stores[name] !== 'string' || !SECTION_SUM_RE.test(stores[name])) return { ok: false };
    }
    for (const path of Object.keys(files)) {
        const slash = path.indexOf('/');
        if (slash <= 0) return { ok: false };
        const dir = path.slice(0, slash), name = path.slice(slash + 1);
        if (!FILE_GID_RE.test(dir) || hasDunderSegment(dir) || !FILE_NAME_RE.test(name)) return { ok: false };
        if (typeof files[path] !== 'string' || !SECTION_SUM_RE.test(files[path])) return { ok: false };
    }
    let expected;
    try { expected = await checksumCanonical({ stores: stores, files: files }); } catch (e) { return { ok: false }; }
    if (manifest.checksum !== expected) return { ok: false };
    return { ok: true, stores: stores, files: files };
}

// ---- pure validation (Node-testable) ----
// Runs import gates 4–6 over an already-parsed bundle: shape, per-key
// allowlist + value-type filter, then checksum. Checksum verifies the file's
// ORIGINAL sections (parsed.data/stores/files), never the filtered cleanData —
// we verify what was signed, not what we kept, to detect tampering. Returns a
// discriminated result the caller maps to a toast; on success it hands back
// everything the commit path needs.
export async function validateSaveBundle(parsed, opts) {
    // Gate 4: shape — accept schema v1 (localStorage-only) through the
    // current SAVE_SCHEMA (adds stores/files).
    if (!parsed || typeof parsed !== 'object'
        || parsed.format !== SAVE_FORMAT
        || !(parsed.schemaVersion >= 1 && parsed.schemaVersion <= SAVE_SCHEMA)
        || !parsed.data || typeof parsed.data !== 'object'
        || Array.isArray(parsed.data)) {
        return { ok: false, reason: 'not-a-save' };
    }
    const isV2 = parsed.schemaVersion >= 2;
    const parsedStores = (isV2 && parsed.stores && typeof parsed.stores === 'object' && !Array.isArray(parsed.stores)) ? parsed.stores : {};
    const parsedFiles = (isV2 && parsed.files && typeof parsed.files === 'object' && !Array.isArray(parsed.files)) ? parsed.files : {};
    // Gate 5: per-key allowlist + value type
    const cleanData = {};
    const droppedKeys = [];
    let protectedSkipped = 0;
    for (const k of Object.keys(parsed.data)) {
        if ((!isSafeArcadeKey(k) && !isLsProxyBackupKey(k)) || typeof parsed.data[k] !== 'string') {
            droppedKeys.push(k);
            continue;
        }
        if (IMPORT_PROTECTED_KEYS.has(k)) {
            // Device identity / trust records are never overwritten by an
            // import (see IMPORT_PROTECTED_KEYS) — skip silently-but-noted.
            protectedSkipped++;
            continue;
        }
        cleanData[k] = parsed.data[k];
    }
    const cleanKeys = Object.keys(cleanData);
    // A v2 bundle whose localStorage section holds nothing importable can
    // still be a legitimate save: a device whose games persist only via
    // Arcade.store/files carries data solely in those sections (and this
    // rule must stay in step with exportBundleString's "nothing to back up"
    // check, or backup offers loop forever unstorable). Only a bundle with
    // nothing in ANY section is 'no-valid-keys'.
    if (cleanKeys.length === 0
        && Object.keys(parsedStores).length === 0
        && Object.keys(parsedFiles).length === 0) {
        return { ok: false, reason: 'no-valid-keys' };
    }
    // Gate 6: checksum (over the file's original sections — we verify
    // what was signed, not what we filtered, to detect tampering). v1
    // uses the flat-data checksum; v2 covers data + stores + files.
    let expected;
    try {
        expected = isV2
            ? await checksumBundle(parsed.data, parsedStores, parsedFiles)
            : await checksumData(parsed.data);
    } catch (e) {
        return { ok: false, reason: 'checksum-error' };
    }
    const checksumOk = typeof parsed.checksum === 'string' && parsed.checksum === expected;
    // Human-only override: a mismatch is a hard reject by default (the
    // posture every non-interactive caller — peer backup, local backup —
    // keeps, since neither ever passes opts). Only the interactive
    // file-import path may set allowChecksumMismatch, and only after the
    // user has explicitly confirmed a warning (see importParsedBundle).
    if (!checksumOk && !(opts && opts.allowChecksumMismatch)) {
        return { ok: false, reason: 'checksum-mismatch' };
    }
    return { ok: true, isV2, cleanData, cleanKeys, droppedKeys, protectedSkipped, parsedStores, parsedFiles, checksumOk };
}

// ---- optional passphrase encryption (#29, Node-testable) ----
// AES-GCM with a PBKDF2-stretched passphrase key, mirroring p2p/rendezvous-
// crypto.js's decrypt-then-parse discipline (auth-tag failure returns null,
// never partial/garbage bytes reaching JSON.parse) — but as standalone
// helpers, since that module only exports its RendezvousCrypto class (no
// generic AEAD-with-provided-key primitive) and derives its key from a
// high-entropy pairing secret via HKDF, not a low-entropy passphrase via
// PBKDF2. Encrypts the WHOLE serialized bundle string; the plaintext inside
// carries its own format/schemaVersion, so this envelope only needs its own.
export const ENC_FORMAT = 'pauls-arcade-save-enc';
export const ENC_VERSION = 1;
// PBKDF2-SHA256 iteration count — sub-second on modern hardware for a
// one-shot interactive export/import, at the current OWASP floor (600k for
// PBKDF2-SHA256). Decrypt honors the envelope's own `iterations`, so bundles
// minted at the old 250k count still import unchanged.
const ENC_ITERATIONS = 600000;
// Decrypt-side ceiling on envelope-supplied iterations: a hostile envelope
// could otherwise pin the importing device in PBKDF2 for minutes. Generous
// headroom above anything we ever minted or plan to mint.
const ENC_MAX_ITERATIONS = 10000000;

// Chunked to avoid a call-stack blowout: String.fromCharCode(...bytes) on a
// large typed array (a bundle can be tens of MB with blobs) can exceed the
// engine's argument-spread limit. Exported for arcade-backup.js's at-rest
// sealing — one codec implementation on the launcher side, not three.
export function bytesToB64(bytes) {
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
}
export function b64ToBytes(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

async function deriveAesKey(passphrase, salt, iterations, usage) {
    const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
        baseKey, { name: 'AES-GCM', length: 256 }, false, [usage]
    );
}

export async function encryptBundleJson(json, passphrase) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveAesKey(passphrase, salt, ENC_ITERATIONS, 'encrypt');
    const aad = new TextEncoder().encode(ENC_FORMAT + '/v' + ENC_VERSION);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, new TextEncoder().encode(json));
    return {
        format: ENC_FORMAT, v: ENC_VERSION, kdf: 'PBKDF2-SHA256', iterations: ENC_ITERATIONS,
        salt: bytesToB64(salt), iv: bytesToB64(iv), ciphertext: bytesToB64(new Uint8Array(ciphertext))
    };
}

// Returns the decrypted JSON string, or null on ANY failure (wrong
// passphrase, tampered ciphertext, malformed envelope) — the caller never
// sees a partially-decrypted or unauthenticated result.
export async function decryptBundleJson(envelope, passphrase) {
    if (!envelope || envelope.format !== ENC_FORMAT || typeof envelope.salt !== 'string'
        || typeof envelope.iv !== 'string' || typeof envelope.ciphertext !== 'string') {
        return null;
    }
    try {
        const salt = b64ToBytes(envelope.salt);
        const iv = b64ToBytes(envelope.iv);
        const iterations = Number.isInteger(envelope.iterations) ? envelope.iterations : ENC_ITERATIONS;
        if (iterations < 1 || iterations > ENC_MAX_ITERATIONS) return null;
        const key = await deriveAesKey(passphrase, salt, iterations, 'decrypt');
        const aad = new TextEncoder().encode(envelope.format + '/v' + envelope.v);
        const plaintextBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, b64ToBytes(envelope.ciphertext));
        return new TextDecoder().decode(plaintextBuf);
    } catch (e) { return null; } // wrong passphrase or tampered ciphertext — AES-GCM auth tag fails closed
}

export function initSaveLoad(host) {
    const showToast = host.showToast;

    async function gatherGameIds(data, dbNames) {
        const ids = new Set();
        for (const k of Object.keys(data || {})) {
            const m = /^arcade\.v1\.([a-z0-9_-]+)\./i.exec(k);
            if (m && m[1] !== '_meta' && m[1] !== 'global') ids.add(m[1]);
        }
        for (const n of (dbNames || [])) {
            const m = /^arcade\.v1\.([a-z0-9_-]+)\.(?:store\.|files$)/i.exec(n);
            if (m) ids.add(m[1]);
        }
        const root = await opfsRoot();
        if (root && root.values) {
            try {
                for await (const h of root.values()) {
                    const m = /^arcade\.v1\.([a-z0-9_-]+)$/i.exec(h.name);
                    if (h.kind === 'directory' && m) ids.add(m[1]);
                }
            } catch (e) {}
        }
        return ids;
    }
    async function collectStores(dbNames) {
        const out = {};
        if (!dbNames) return out;
        for (const name of dbNames) {
            if (!STORE_DB_RE.test(name)) continue;
            try {
                const db = await idbOpen(name);
                const rows = await idbAll(db);
                db.close();
                const kv = {};
                for (const r of rows) {
                    try { JSON.stringify(r.value); kv[String(r.key)] = r.value; } catch (e) { /* skip non-JSON */ }
                }
                out[name] = kv;
            } catch (e) {}
        }
        return out;
    }
    async function collectFiles(gameIds, dbNames) {
        const out = {};
        const root = await opfsRoot();
        const dbSet = dbNames ? new Set(dbNames) : null;
        for (const gid of gameIds) {
            const dir = 'arcade.v1.' + gid;
            const items = [];
            if (root) {
                try {
                    const d = await root.getDirectoryHandle(dir, { create: false });
                    for await (const h of d.values()) {
                        if (h.kind !== 'file') continue;
                        const f = await h.getFile();
                        items.push({ name: h.name, type: f.type || '', size: f.size, b64: await blobToB64(f) });
                    }
                } catch (e) {}
            }
            // IDB fallback backend — only open if it actually exists (avoid
            // creating empty DBs); when we can't enumerate, try anyway.
            if (!dbSet || dbSet.has(dir + '.files')) {
                try {
                    const db = await idbOpen(dir + '.files');
                    const rows = await idbAll(db);
                    db.close();
                    for (const r of rows) {
                        const rec = r.value || {};
                        if (rec.blob instanceof Blob) {
                            items.push({ name: String(r.key), type: rec.type || rec.blob.type || '', size: rec.size || rec.blob.size, b64: await blobToB64(rec.blob) });
                        }
                    }
                } catch (e) {}
            }
            if (items.length) out[dir] = items;
        }
        return out;
    }
    async function writeStores(stores) {
        let count = 0;
        for (const name of Object.keys(stores || {})) {
            if (!STORE_DB_RE.test(name) || hasDunderSegment(name)) continue;
            const kv = stores[name];
            if (!kv || typeof kv !== 'object' || Array.isArray(kv)) continue;
            try {
                const db = await idbOpen(name);
                for (const k of Object.keys(kv)) { await idbPut(db, k, kv[k]); count++; }
                db.close();
            } catch (e) {}
        }
        return count;
    }
    async function writeFiles(files) {
        let count = 0;
        const root = await opfsRoot();
        for (const dir of Object.keys(files || {})) {
            if (!FILE_GID_RE.test(dir) || hasDunderSegment(dir)) continue;
            const items = Array.isArray(files[dir]) ? files[dir] : [];
            for (const it of items) {
                if (!it || typeof it.name !== 'string' || !FILE_NAME_RE.test(it.name) || typeof it.b64 !== 'string') continue;
                let blob;
                try { blob = b64ToBlob(it.b64, it.type); } catch (e) { continue; }
                let wrote = false;
                if (root) {
                    try {
                        const d = await root.getDirectoryHandle(dir, { create: true });
                        const fh = await d.getFileHandle(it.name, { create: true });
                        const w = await fh.createWritable();
                        await w.write(blob); await w.close();
                        wrote = true;
                    } catch (e) {}
                }
                if (!wrote) {
                    try {
                        const db = await idbOpen(dir + '.files');
                        await idbPut(db, it.name, { blob: blob, size: blob.size, type: blob.type });
                        db.close();
                        wrote = true;
                    } catch (e) {}
                }
                if (wrote) count++;
            }
        }
        return count;
    }

    function collectArcadeKeys() {
        // Save-export governance: the SDK's state.set(key, v,
        // {exportable:false}) lists local-only keys (telemetry, caches)
        // in arcade.v1.<gameId>._noExport — those never inflate a save.
        const noExport = new Set();
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (!k || !/^arcade\.v1\.[a-z0-9_-]+\._noExport$/.test(k)) continue;
            try {
                const list = JSON.parse(localStorage.getItem(k));
                if (Array.isArray(list)) {
                    for (const item of list) {
                        if (typeof item === 'string') noExport.add(item);
                    }
                }
            } catch (e) {}
        }
        const out = {};
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (!k || noExport.has(k)) continue;
            if (!isSafeArcadeKey(k) && !isLsProxyBackupKey(k)) continue;
            const v = localStorage.getItem(k);
            if (typeof v === 'string') out[k] = v;
        }
        return out;
    }

    function isoStamp() {
        return new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
    }

    function downloadJSON(filename, obj) {
        const json = JSON.stringify(obj, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        try {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            return true;
        } catch (err) {
            // Fallback: open in a new tab so the user can save manually.
            try {
                const w = window.open();
                if (w) {
                    w.document.body.style.cssText = 'font-family:monospace;white-space:pre;padding:20px;';
                    w.document.body.textContent = json;
                    return true;
                }
            } catch (e) {}
            return false;
        }
    }

    // opts.appId (#29) scopes the bundle to one app: localStorage keys,
    // store DBs, and files dir are all filtered to that app's arcade.v1.
    // prefix, and _meta/global are excluded entirely (per-app data shouldn't
    // carry device identity or shared settings). Whole-arcade export
    // (exportSave, and the backup engines via exportBundleString) calls this
    // with no opts and is completely unaffected.
    async function buildBundle(data, opts) {
        const appId = opts && opts.appId;
        const scopedData = appId ? filterDataByApp(data, appId) : data;
        const dbNames = await listArcadeDbNames();
        // gatherGameIds scans dbNames/OPFS independently of `data` and would
        // otherwise surface OTHER apps that merely have a store/files DB but
        // no localStorage key — force to exactly {appId} instead.
        const scopedDbNames = (appId && dbNames)
            ? dbNames.filter((n) => n.indexOf(KEY_PREFIX + appId + '.') === 0)
            : dbNames;
        const gameIds = appId ? new Set([appId]) : await gatherGameIds(scopedData, dbNames);
        const stores = await collectStores(scopedDbNames);
        const files = await collectFiles(gameIds, scopedDbNames);
        const bundle = {
            format: SAVE_FORMAT,
            schemaVersion: SAVE_SCHEMA,
            exportedAt: new Date().toISOString(),
            appVersion: '1.0.0',
            checksum: await checksumBundle(scopedData, stores, files),
            data: scopedData,
            stores: stores,
            files: files
        };
        // Additive provenance sections (durability design §4). Advisory by
        // invariant: a failure here degrades to a section-less bundle —
        // exactly today's format — never a failed export.
        try {
            if (host.getJournalSnapshot) {
                const snap = await host.getJournalSnapshot();
                if (snap && snap.records && typeof snap.records === 'object') {
                    let recs = snap.records;
                    if (appId) {
                        const prefix = KEY_PREFIX + appId + '.';
                        const scoped = {};
                        for (const k of Object.keys(recs)) {
                            if (k.indexOf(prefix) === 0) scoped[k] = recs[k];
                        }
                        recs = scoped;
                    }
                    bundle.journal = await buildJournalSection(snap.clock, recs, new Set(Object.keys(scopedData)));
                }
            }
        } catch (e) {}
        try {
            bundle.manifest = await buildManifestSection(stores, files);
        } catch (e) {}
        return bundle;
    }

    function filterDataByApp(data, appId) {
        const prefix = KEY_PREFIX + appId + '.';
        const out = {};
        for (const k of Object.keys(data)) if (k.indexOf(prefix) === 0) out[k] = data[k];
        return out;
    }

    function countFiles(files) {
        let n = 0;
        for (const k of Object.keys(files || {})) n += (files[k] || []).length;
        return n;
    }

    // ---- save (export) ----
    async function exportSave() {
        const data = collectArcadeKeys();
        let bundle;
        try {
            bundle = await buildBundle(data);
        } catch (err) {
            showToast('Save failed: could not serialize data.', { error: true });
            return;
        }
        const keyCount = Object.keys(data).length;
        const storeCount = Object.keys(bundle.stores).length;
        const fileCount = countFiles(bundle.files);
        if (keyCount === 0 && storeCount === 0 && fileCount === 0) {
            showToast('Nothing to save — no arcade data found.', { error: true });
            return;
        }
        const ok = downloadJSON('pauls-arcade-save-' + isoStamp() + '.json', bundle);
        const extra = (storeCount || fileCount) ? ' + ' + storeCount + ' stores, ' + fileCount + ' files' : '';
        if (ok) showToast('Saved ' + keyCount + ' keys' + extra + ' to your Downloads folder.');
        else showToast('Save failed: browser blocked the download.', { error: true });
    }

    // ---- save (export) — per-app / encrypted (#29) ----
    // A deliberately separate flow from exportSave(): the plain "Export to
    // File" button stays a single click with zero prompts. This one asks up
    // to two optional questions (scope, then passphrase) before downloading.
    async function exportSaveAdvanced() {
        const data = collectArcadeKeys();
        const dbNames = await listArcadeDbNames();
        const gameIds = [...(await gatherGameIds(data, dbNames))].sort();
        let appId;
        if (gameIds.length > 0) {
            const choice = await host.dialog({
                message: 'Export everything, or just one app?\n\nApps with data: ' + gameIds.join(', ')
                    + '\n\nType an app name to export only that app, or leave blank for everything.',
                input: true, inputValue: '', okLabel: 'Continue', cancelLabel: 'Cancel'
            });
            if (choice === null) return; // cancelled
            const trimmed = choice.trim();
            if (trimmed) {
                if (gameIds.indexOf(trimmed) === -1) {
                    showToast('Unknown app "' + trimmed + '" — export cancelled.', { error: true });
                    return;
                }
                appId = trimmed;
            }
        }
        const passphrase = await host.dialog({
            message: 'Optional: enter a passphrase to encrypt this export. Leave blank for a plain-text file.',
            input: true, inputType: 'password', inputValue: '', okLabel: 'Export', cancelLabel: 'Cancel'
        });
        if (passphrase === null) return; // cancelled

        let bundle;
        try { bundle = await buildBundle(data, { appId }); }
        catch (err) { showToast('Save failed: could not serialize data.', { error: true }); return; }
        const keyCount = Object.keys(bundle.data).length;
        const storeCount = Object.keys(bundle.stores).length;
        const fileCount = countFiles(bundle.files);
        if (keyCount === 0 && storeCount === 0 && fileCount === 0) {
            showToast('Nothing to save' + (appId ? ' for "' + appId + '"' : '') + '.', { error: true });
            return;
        }
        let payload = bundle;
        if (passphrase) {
            try { payload = await encryptBundleJson(JSON.stringify(bundle), passphrase); }
            catch (e) { showToast('Encryption failed.', { error: true }); return; }
        }
        const namePart = (appId || 'all') + (passphrase ? '-encrypted' : '');
        const ok = downloadJSON('pauls-arcade-save-' + namePart + '-' + isoStamp() + '.json', payload);
        const extra = (storeCount || fileCount) ? ' + ' + storeCount + ' stores, ' + fileCount + ' files' : '';
        if (ok) {
            showToast('Saved ' + keyCount + ' keys' + extra
                + (appId ? ' for "' + appId + '"' : '') + (passphrase ? ', encrypted' : '') + '.');
        } else {
            showToast('Save failed: browser blocked the download.', { error: true });
        }
    }

    // ---- load (import) ----
    function quotaProbe() {
        try {
            localStorage.setItem(PROBE_KEY, '1');
            localStorage.removeItem(PROBE_KEY);
            return true;
        } catch (e) { return false; }
    }

    function snapshotKeys(keys) {
        const snap = {};
        for (const k of keys) snap[k] = localStorage.getItem(k);
        return snap;
    }

    function restoreSnapshot(snap) {
        for (const k of Object.keys(snap)) {
            const v = snap[k];
            try {
                if (v === null) localStorage.removeItem(k);
                else localStorage.setItem(k, v);
            } catch (e) { /* best-effort restore */ }
        }
    }

    function readFileText(file) {
        return new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onerror = () => reject(new Error('read failed'));
            r.onabort = () => reject(new Error('read aborted'));
            r.onload = () => resolve(r.result);
            r.readAsText(file);
        });
    }

    async function importSaveFile(file) {
        // Gate 1: size
        if (!file || file.size > MAX_IMPORT_BYTES) {
            showToast('File rejected: size exceeds 64 MB.', { error: true });
            return;
        }
        // Gate 2: read
        let text;
        try { text = await readFileText(file); }
        catch (e) { showToast('Could not read file.', { error: true }); return; }
        // Gate 3: parse
        let parsed;
        try { parsed = JSON.parse(text); }
        catch (e) { showToast('Not valid JSON.', { error: true }); return; }
        // Encrypted export (#29): detected before any of the normal shape
        // gates run — the outer envelope is never a save bundle itself.
        if (parsed && parsed.format === ENC_FORMAT) {
            const passphrase = await host.dialog({
                message: 'This backup is encrypted. Enter the passphrase to decrypt it:',
                input: true, inputType: 'password', inputValue: '', okLabel: 'Decrypt', cancelLabel: 'Cancel'
            });
            if (passphrase === null) return; // cancelled
            const plaintext = await decryptBundleJson(parsed, passphrase);
            if (plaintext === null) {
                // Single attempt by design — re-clicking Import from File
                // tries again rather than looping a passphrase prompt.
                showToast('Incorrect passphrase, or the backup is corrupted.', { error: true });
                return;
            }
            try { parsed = JSON.parse(plaintext); }
            catch (e) { showToast('Decrypted data is not a valid save.', { error: true }); return; }
        }
        await importParsedBundle(parsed, {});
    }

    // Gates 4–10 over an already-parsed bundle — shared by the file-import
    // path above (gates 1–3 are file-specific) and the backup-restore path
    // (arcade-backup.js hands over a stored generation via importBundleJson
    // below). opts.intro, when present, leads the confirm text so a restore
    // says whose backup it is. Returns true only when the commit happened.
    async function importParsedBundle(parsed, opts) {
        // Gates 4–6: shape, per-key allowlist, checksum (pure, unit-tested).
        let v = await validateSaveBundle(parsed);
        let checksumOverridden = false;
        // Human-only override (#29): a checksum-mismatched file is normally
        // a hard reject. Give the user an explicit, separate warning before
        // re-validating with the override flag — never silently downgrade a
        // reject into an accept.
        if (!v.ok && v.reason === 'checksum-mismatch') {
            const proceed = window.confirm(
                'This file\'s checksum doesn\'t match its contents — it may be hand-edited or corrupted.\n\n'
                + 'Importing anyway skips this integrity check. Continue at your own risk?'
            );
            if (!proceed) {
                showToast('Checksum mismatch — file may be corrupt.', { error: true });
                return false;
            }
            v = await validateSaveBundle(parsed, { allowChecksumMismatch: true });
            checksumOverridden = true;
        }
        if (!v.ok) {
            const MSG = {
                'not-a-save': 'File is not a valid arcade save.',
                'no-valid-keys': 'Save contained no valid arcade keys.',
                'checksum-error': 'Could not verify checksum.',
                'checksum-mismatch': 'Checksum mismatch — file may be corrupt.'
            };
            showToast(MSG[v.reason] || 'File is not a valid arcade save.', { error: true });
            return false;
        }
        const { isV2, cleanData, cleanKeys, droppedKeys, protectedSkipped, parsedStores, parsedFiles } = v;
        // Gate 7: confirm with user. Import merges: keys in the file
        // overwrite their current values, keys NOT in the file are kept
        // — the copy must say so.
        const storeEntryCount = Object.keys(parsedStores).reduce((n, s) => n + Object.keys(parsedStores[s] || {}).length, 0);
        const importFileCount = countFiles(parsedFiles);
        const asyncSummary = (storeEntryCount || importFileCount)
            ? 'It will also restore ' + storeEntryCount + ' stored records and ' + importFileCount + ' files.\n' : '';
        const summary = ((opts && opts.intro) ? opts.intro + '\n\n' : '')
            + (checksumOverridden ? '⚠️ This file\'s checksum could not be verified — importing without an integrity guarantee.\n' : '')
            + 'This will import ' + cleanKeys.length + ' arcade keys from the file, '
            + 'overwriting their current values. Saved data not in the file is kept as-is.\n'
            + asyncSummary
            + (droppedKeys.length ? droppedKeys.length + ' invalid keys will be ignored.\n' : '')
            + (protectedSkipped ? 'This device\'s identity and saved connections are kept as-is (not overwritten).\n' : '')
            + '\nYour current state will be auto-saved to your Downloads folder first.\nContinue?';
        if (!window.confirm(summary)) return false;
        // Gate 8: auto-backup current state (if non-empty)
        const currentData = collectArcadeKeys();
        if (Object.keys(currentData).length > 0) {
            try {
                const backup = await buildBundle(currentData);
                const ok = downloadJSON('pauls-arcade-autobackup-' + isoStamp() + '.json', backup);
                if (!ok && !window.confirm('Auto-backup download was blocked. Continue without backup?')) {
                    return false;
                }
            } catch (e) {
                if (!window.confirm('Auto-backup failed. Continue without backup?')) return false;
            }
        }
        // Gate 9: quota probe
        if (!quotaProbe()) {
            showToast('localStorage is full — cannot import.', { error: true });
            return false;
        }
        // Gate 10: stage + commit. Snapshot keys we will overwrite.
        const snap = snapshotKeys(cleanKeys);
        try {
            for (const k of cleanKeys) {
                localStorage.setItem(k, cleanData[k]);
            }
        } catch (err) {
            restoreSnapshot(snap);
            showToast('Write failed mid-import — prior state restored.', { error: true });
            return false;
        }
        // Async storage (stores/files) is written AFTER the localStorage
        // commit. It can't share the synchronous snapshot/rollback above, so
        // it's best-effort — the auto-backup taken at Gate 8 is the safety
        // net if a write fails midway.
        let asyncNote = '';
        if (isV2) {
            try {
                const sc = await writeStores(parsedStores);
                const fc = await writeFiles(parsedFiles);
                if (sc || fc) asyncNote = ' (+' + sc + ' records, ' + fc + ' files)';
            } catch (e) {
                asyncNote = ' — note: some app data could not be restored (your auto-backup has the original)';
            }
        }
        // Sync engine hook (arcade-sync.js, wired in index.html): an import
        // is a deliberate "now" edit — re-stamp every imported key that's
        // synced so it wins over older remote edits on the next sync.
        if (host.onImportCommitted) { try { host.onImportCommitted(cleanKeys); } catch (e) {} }
        // Notify mounted iframes. Opaque frames can't see storage events
        // — each gets its fresh post-import snapshot to reseed its cache.
        for (const gid of host.listMountedGameIds()) {
            host.postToIframe(gid, { type: 'arcade:state.replaced', state: host.stateSnapshotFor(gid) });
        }
        showToast('Imported ' + cleanKeys.length + ' keys' + asyncNote + ' successfully.');
        return true;
    }

    const btnSave = document.getElementById('btn-save');
    const btnSaveAdvanced = document.getElementById('btn-save-advanced');
    const btnLoad = document.getElementById('btn-load');
    const fileLoad = document.getElementById('file-load');
    btnSave.addEventListener('click', () => { exportSave(); });
    btnSaveAdvanced.addEventListener('click', () => { exportSaveAdvanced(); });
    btnLoad.addEventListener('click', () => { fileLoad.click(); });
    fileLoad.addEventListener('change', () => {
        const f = fileLoad.files && fileLoad.files[0];
        // Reset so picking the same file twice still fires 'change'.
        fileLoad.value = '';
        if (f) importSaveFile(f);
    });

    // Bundle API for the backup engine (arcade-backup.js): the exact export
    // and import machinery the Save/Load buttons use, minus the file layer.
    return {
        /**
         * Serialize the current device state as a save-bundle string, or null
         * when there is nothing to back up. "Nothing" means no key an import
         * would actually commit: a fresh device holds only IMPORT_PROTECTED
         * meta keys (deviceId, knownPeers, …), and a bundle of just those
         * fails validateSaveBundle ('no-valid-keys') on every receiver — so
         * it must never be offered in the first place. The checksum is the
         * bundle's own (checksumBundle over data/stores/files).
         */
        async exportBundleString() {
            const data = collectArcadeKeys();
            const bundle = await buildBundle(data);
            const importable = Object.keys(data).some((k) => !IMPORT_PROTECTED_KEYS.has(k));
            if (!importable
                && Object.keys(bundle.stores).length === 0
                && countFiles(bundle.files) === 0) return null;
            return { json: JSON.stringify(bundle), checksum: bundle.checksum, exportedAt: bundle.exportedAt };
        },

        /**
         * Run a serialized bundle through the full import pipeline (gates
         * 3–10: parse, validate, confirm, auto-backup, commit). Returns true
         * only when the commit happened.
         */
        async importBundleJson(json, intro) {
            if (typeof json !== 'string' || json.length > MAX_IMPORT_BYTES) {
                showToast('Backup rejected: size exceeds 64 MB.', { error: true });
                return false;
            }
            let parsed;
            try { parsed = JSON.parse(json); }
            catch (e) { showToast('Backup is not valid JSON.', { error: true }); return false; }
            return importParsedBundle(parsed, { intro });
        }
    };
}
