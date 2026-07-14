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
 * launcher-owned glue (see index.html's window.__arcade.storageHost).
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

// ---- pure validation (Node-testable) ----
// Runs import gates 4–6 over an already-parsed bundle: shape, per-key
// allowlist + value-type filter, then checksum. Checksum verifies the file's
// ORIGINAL sections (parsed.data/stores/files), never the filtered cleanData —
// we verify what was signed, not what we kept, to detect tampering. Returns a
// discriminated result the caller maps to a toast; on success it hands back
// everything the commit path needs.
export async function validateSaveBundle(parsed) {
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
    if (cleanKeys.length === 0) {
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
    if (typeof parsed.checksum !== 'string' || parsed.checksum !== expected) {
        return { ok: false, reason: 'checksum-mismatch' };
    }
    return { ok: true, isV2, cleanData, cleanKeys, droppedKeys, protectedSkipped, parsedStores, parsedFiles };
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

    async function buildBundle(data) {
        const dbNames = await listArcadeDbNames();
        const gameIds = await gatherGameIds(data, dbNames);
        const stores = await collectStores(dbNames);
        const files = await collectFiles(gameIds, dbNames);
        return {
            format: SAVE_FORMAT,
            schemaVersion: SAVE_SCHEMA,
            exportedAt: new Date().toISOString(),
            appVersion: '1.0.0',
            checksum: await checksumBundle(data, stores, files),
            data: data,
            stores: stores,
            files: files
        };
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
        // Gates 4–6: shape, per-key allowlist, checksum (pure, unit-tested).
        const v = await validateSaveBundle(parsed);
        if (!v.ok) {
            const MSG = {
                'not-a-save': 'File is not a valid arcade save.',
                'no-valid-keys': 'Save contained no valid arcade keys.',
                'checksum-error': 'Could not verify checksum.',
                'checksum-mismatch': 'Checksum mismatch — file may be corrupt.'
            };
            showToast(MSG[v.reason] || 'File is not a valid arcade save.', { error: true });
            return;
        }
        const { isV2, cleanData, cleanKeys, droppedKeys, protectedSkipped, parsedStores, parsedFiles } = v;
        // Gate 7: confirm with user. Import merges: keys in the file
        // overwrite their current values, keys NOT in the file are kept
        // — the copy must say so.
        const storeEntryCount = Object.keys(parsedStores).reduce((n, s) => n + Object.keys(parsedStores[s] || {}).length, 0);
        const importFileCount = countFiles(parsedFiles);
        const asyncSummary = (storeEntryCount || importFileCount)
            ? 'It will also restore ' + storeEntryCount + ' stored records and ' + importFileCount + ' files.\n' : '';
        const summary = 'This will import ' + cleanKeys.length + ' arcade keys from the file, '
            + 'overwriting their current values. Saved data not in the file is kept as-is.\n'
            + asyncSummary
            + (droppedKeys.length ? droppedKeys.length + ' invalid keys will be ignored.\n' : '')
            + (protectedSkipped ? 'This device\'s identity and saved connections are kept as-is (not overwritten).\n' : '')
            + '\nYour current state will be auto-saved to your Downloads folder first.\nContinue?';
        if (!window.confirm(summary)) return;
        // Gate 8: auto-backup current state (if non-empty)
        const currentData = collectArcadeKeys();
        if (Object.keys(currentData).length > 0) {
            try {
                const backup = await buildBundle(currentData);
                const ok = downloadJSON('pauls-arcade-autobackup-' + isoStamp() + '.json', backup);
                if (!ok && !window.confirm('Auto-backup download was blocked. Continue without backup?')) {
                    return;
                }
            } catch (e) {
                if (!window.confirm('Auto-backup failed. Continue without backup?')) return;
            }
        }
        // Gate 9: quota probe
        if (!quotaProbe()) {
            showToast('localStorage is full — cannot import.', { error: true });
            return;
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
            return;
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
        // Notify mounted iframes. Opaque frames can't see storage events
        // — each gets its fresh post-import snapshot to reseed its cache.
        for (const gid of host.listMountedGameIds()) {
            host.postToIframe(gid, { type: 'arcade:state.replaced', state: host.stateSnapshotFor(gid) });
        }
        showToast('Imported ' + cleanKeys.length + ' keys' + asyncNote + ' successfully.');
    }

    const btnSave = document.getElementById('btn-save');
    const btnLoad = document.getElementById('btn-load');
    const fileLoad = document.getElementById('file-load');
    btnSave.addEventListener('click', () => { exportSave(); });
    btnLoad.addEventListener('click', () => { fileLoad.click(); });
    fileLoad.addEventListener('change', () => {
        const f = fileLoad.files && fileLoad.files[0];
        // Reset so picking the same file twice still fires 'change'.
        fileLoad.value = '';
        if (f) importSaveFile(f);
    });
}
