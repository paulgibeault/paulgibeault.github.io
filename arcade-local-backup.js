/* arcade-local-backup.js — the launcher-side automatic local backup engine
 * (#30). "A user who never imports a save file has zero backups" — this
 * closes that gap without any pairing or consent: on every boot, if the
 * newest kept snapshot is missing or more than 24h stale, the engine builds
 * the device's full save bundle (arcade-save.js exportBundleString — the
 * exact same checksummed export a Save-to-file download or a peer backup
 * produces) and stores it in the device-local 'arcade-local-backup'
 * IndexedDB. The newest LOCAL_BACKUP_GENERATIONS snapshots are kept
 * (planGenerationStore, reused as-is from arcade-backup-core.js). Restoring
 * rides the SAME import pipeline a save-file load uses (validate, confirm,
 * auto-backup, rollback-safe commit) — a local-backup restore is never a
 * second, weaker import path.
 *
 * Trust posture: same-origin only, nothing ever leaves the device — unlike
 * arcade-backup.js's backup-to-trusted-peer (#31), which requires mutual
 * pairing consent because the bundle crosses a device boundary, this is the
 * same trust boundary as the Save/Load buttons themselves. That's why the
 * rolling IDB snapshot is always-on with zero opt-in and no consent hook.
 *
 * Optional on-disk folder (Chromium): the File System Access API lets the
 * user grant a real folder on disk for a periodic dated export, mirroring
 * the IDB retention (same generation cap, pruned the same way). Feature-
 * detected and hidden entirely where the API doesn't exist. The browser
 * gates both showDirectoryPicker() and requestPermission() on a user
 * gesture — an unattended boot-time snapshot cycle NEVER calls
 * requestPermission, only queryPermission; re-granting after a revoke can
 * only happen from the folder button's own click.
 *
 * Lazy-ish by design: ensureDb() opens the 'arcade-local-backup' IndexedDB
 * on the engine's first snapshot attempt (called once at boot by
 * index.html) rather than at construction time, but — unlike the peer
 * backup engine, which may never touch its IDB in a session that has no P2P
 * event — this one always runs within moments of boot, since the feature is
 * active every session by design.
 */

import {
    LOCAL_BACKUP_DB,
    LOCAL_BACKUP_GENERATIONS,
    LOCAL_BACKUP_MAX_CHARS,
    localSnapshotKey,
    isSnapshotStale,
    planGenerationStore
} from './arcade-local-backup-core.js';
import { idbOpen, idbGet, idbPut, idbKeys, idbDel } from './arcade-storage-core.js';
import { ArcadeDiag } from './arcade-diag.js';

const FOLDER_FILE_RE = /^pauls-arcade-local-backup-(.+)\.json$/;

function isoStamp() {
    return new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
}

export function initLocalBackupEngine(host) {
    const showToast = host.showToast || (() => {});

    // ---- lazy-loaded engine state ----
    let db = null;
    let loadingPromise = null;
    let index = [];             // [{key, checksum, chars, exportedAt, receivedAt}] oldest-first
    let folderHandle = null;    // cached FileSystemDirectoryHandle, or null if never granted
    let snapshotting = null;    // in-flight maybeSnapshot() promise — a racing caller converges on it

    let btnFolderLabelEl = null;

    function ensureDb() {
        if (db) return Promise.resolve();
        if (loadingPromise) return loadingPromise;
        loadingPromise = (async () => {
            db = await idbOpen(LOCAL_BACKUP_DB);
            // Keys + per-generation META rows only — never the 's|' bundle
            // strings (an idbAll-style read would materialize every stored
            // snapshot at once just to build this index).
            const keys = await idbKeys(db);
            for (const key of keys) {
                if (typeof key !== 'string') continue;
                if (key.charAt(0) === 'm' && key.charAt(1) === '|') {
                    const v = (await idbGet(db, key)) || {};
                    index.push({
                        key: 's' + key.slice(1), checksum: v.checksum, chars: v.chars,
                        exportedAt: v.exportedAt, receivedAt: v.receivedAt
                    });
                } else if (key === 'folder') {
                    const v = await idbGet(db, key);
                    if (v && v.handle) folderHandle = v.handle;
                }
            }
            index.sort((a, b) => a.key < b.key ? -1 : 1);
        })();
        return loadingPromise;
    }

    // ---- snapshot cycle ----
    async function storeSnapshot(bundle) {
        const plan = planGenerationStore(index, bundle.checksum, LOCAL_BACKUP_GENERATIONS);
        if (!plan.store) return false; // identical to the newest kept generation — nothing changed
        let ms = Date.now();
        let key = localSnapshotKey(ms);
        while (index.some((g) => g.key === key)) key = localSnapshotKey(++ms);
        const meta = { checksum: bundle.checksum, chars: bundle.json.length, exportedAt: bundle.exportedAt || '', receivedAt: ms };
        // Split rows: the bundle string under 's|…', its meta under 'm|…' —
        // ensureDb's index build reads only the latter.
        await idbPut(db, key, { json: bundle.json });
        await idbPut(db, 'm' + key.slice(1), meta);
        index.push({ key, ...meta });
        for (const pk of plan.prune) {
            try { await idbDel(db, pk); await idbDel(db, 'm' + pk.slice(1)); } catch (e) {}
        }
        index = index.filter((g) => plan.prune.indexOf(g.key) === -1);
        // Silent on success by design (routine 24h background cycle) — the
        // Connection Log carries the record; toasts are reserved for
        // restore/folder actions and failures.
        ArcadeDiag.log('local-backup', `snapshot stored (${index.length} generation${index.length === 1 ? '' : 's'} kept)`);
        return true;
    }

    async function maybeSnapshot(force) {
        if (snapshotting) return snapshotting;
        snapshotting = (async () => {
            try {
                await ensureDb();
                const newest = index.length ? index[index.length - 1] : null;
                if (!force && !isSnapshotStale(newest ? newest.receivedAt : null, Date.now())) return false;
                let bundle;
                try { bundle = await host.getBundleJson(); }
                catch (e) {
                    ArcadeDiag.log('local-backup', `bundle build failed: ${(e && e.message) || e}`);
                    return false;
                }
                if (!bundle) return false; // nothing importable to back up yet
                if (bundle.json.length > LOCAL_BACKUP_MAX_CHARS) {
                    ArcadeDiag.log('local-backup', `bundle too large to snapshot (${bundle.json.length} > ${LOCAL_BACKUP_MAX_CHARS} chars)`);
                    return false;
                }
                const stored = await storeSnapshot(bundle);
                if (stored) await tryFolderExport(bundle, false).catch(() => {});
                return stored;
            } finally {
                snapshotting = null;
            }
        })();
        return snapshotting;
    }

    // ---- restore ----
    async function listGenerations() {
        await ensureDb();
        // Newest first for display; meta only (the bundle string stays in IDB).
        return index.slice().reverse().map((g) => ({ ...g }));
    }

    async function restoreLatest() {
        await ensureDb();
        if (!index.length) {
            showToast('No local backup stored on this device yet.');
            return false;
        }
        const newest = index[index.length - 1];
        let rec;
        try { rec = await idbGet(db, newest.key); } catch (e) { rec = null; }
        if (!rec || typeof rec.json !== 'string') {
            showToast('Could not read the stored backup.', { error: true });
            return false;
        }
        const when = new Date(newest.receivedAt).toLocaleString();
        return host.importBundleJson(rec.json, 'Restore the automatic local backup from ' + when + '?');
    }

    // ---- FS Access folder lifecycle ----
    function folderSupported() {
        return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
    }

    async function folderPermission(handle, requestIfMissing) {
        let p;
        try { p = await handle.queryPermission({ mode: 'readwrite' }); }
        catch (e) { return 'denied'; }
        // NEVER called from an unattended boot cycle (requestIfMissing is
        // only ever true from a real click) — requestPermission is
        // gesture-gated and would silently no-op/throw otherwise.
        if (p !== 'granted' && requestIfMissing) {
            try { p = await handle.requestPermission({ mode: 'readwrite' }); } catch (e) {}
        }
        return p;
    }

    async function pruneFolder() {
        if (!folderHandle || typeof folderHandle.values !== 'function') return;
        const files = [];
        for await (const entry of folderHandle.values()) {
            if (entry.kind !== 'file') continue;
            const m = FOLDER_FILE_RE.exec(entry.name);
            if (m) files.push({ name: entry.name, stamp: m[1] });
        }
        files.sort((a, b) => a.stamp < b.stamp ? -1 : a.stamp > b.stamp ? 1 : 0);
        const excess = files.length - LOCAL_BACKUP_GENERATIONS;
        if (excess <= 0) return;
        for (const f of files.slice(0, excess)) {
            try { await folderHandle.removeEntry(f.name); } catch (e) {}
        }
    }

    async function tryFolderExport(bundle, justGranted) {
        if (!folderHandle) return false;
        const perm = await folderPermission(folderHandle, !!justGranted);
        if (perm !== 'granted') {
            ArcadeDiag.log('local-backup', 'folder permission not granted — skipped disk export');
            return false;
        }
        const name = 'pauls-arcade-local-backup-' + isoStamp() + '.json';
        try {
            const fh = await folderHandle.getFileHandle(name, { create: true });
            const w = await fh.createWritable();
            await w.write(bundle.json);
            await w.close();
        } catch (e) {
            ArcadeDiag.log('local-backup', `folder export failed: ${(e && e.message) || e}`);
            return false;
        }
        await pruneFolder().catch(() => {});
        return true;
    }

    async function chooseFolder() {
        if (!folderSupported()) return false;
        // showDirectoryPicker() must be the very first await in this chain —
        // no prior await may consume the click's user-activation window.
        let handle;
        try { handle = await window.showDirectoryPicker({ id: 'arcade-local-backup', mode: 'readwrite' }); }
        catch (e) { return false; } // user cancelled — not an error
        await ensureDb();
        folderHandle = handle;
        // Best-effort: a real FileSystemDirectoryHandle is structured-clone-
        // able via IndexedDB (spec'd browser support), but a failure here
        // (unsupported browser quirk, quota) must not lose the in-memory
        // grant for the rest of THIS session — it would just not survive a
        // reload.
        try { await idbPut(db, 'folder', { handle }); }
        catch (e) { ArcadeDiag.log('local-backup', `could not persist folder grant: ${(e && e.message) || e}`); }
        const bundle = await host.getBundleJson().catch(() => null);
        if (bundle) await tryFolderExport(bundle, true).catch(() => {});
        return true;
    }

    async function forgetFolder() {
        await ensureDb();
        folderHandle = null;
        try { await idbDel(db, 'folder'); } catch (e) {}
    }

    // ---- DOM wiring ----
    function renderFolderLabel() {
        if (!btnFolderLabelEl) return;
        btnFolderLabelEl.textContent = 'Backup Folder: ' + (folderHandle ? folderHandle.name : 'Off');
    }

    function attachDom() {
        const btnRestore = document.getElementById('btn-restore-local-backup');
        const btnFolder = document.getElementById('btn-choose-backup-folder');
        btnFolderLabelEl = document.getElementById('btn-choose-backup-folder-label');

        btnRestore.addEventListener('click', () => { restoreLatest().catch(() => {}); });

        if (!folderSupported()) {
            btnFolder.hidden = true;
            return;
        }
        btnFolder.addEventListener('click', async () => {
            if (!folderHandle) {
                const ok = await chooseFolder();
                renderFolderLabel();
                if (ok) showToast('📁 Backup folder set: ' + folderHandle.name);
                return;
            }
            // Re-check is itself a real click — safe to request, not just query.
            const perm = await folderPermission(folderHandle, true);
            if (perm === 'granted') {
                showToast('📁 Backup folder access confirmed: ' + folderHandle.name);
                return;
            }
            if (window.confirm('Access to "' + folderHandle.name + '" was not granted. Forget this folder?')) {
                await forgetFolder();
                renderFolderLabel();
            }
        });
    }

    attachDom();
    ensureDb().then(renderFolderLabel).catch(() => {});

    return {
        maybeSnapshot,
        restoreLatest,
        listGenerations,
        chooseFolder,
        forgetFolder,
        // Test hook: read-only status snapshot — acceptance suites poll this
        // instead of reaching into IndexedDB directly.
        async _debugStatus() {
            await ensureDb();
            const newest = index.length ? index[index.length - 1] : null;
            return {
                count: index.length,
                newest: newest ? { checksum: newest.checksum, receivedAt: newest.receivedAt } : null,
                folder: folderHandle ? folderHandle.name : null
            };
        }
    };
}
