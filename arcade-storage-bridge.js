/* arcade-storage-bridge.js — the opaque-frame storage custodian.
 *
 * Games run sandboxed WITHOUT allow-same-origin (see ensureIframe in
 * index.html), so they cannot touch localStorage / IndexedDB / OPFS directly.
 * They postMessage storage requests to the launcher, which this module
 * services. Everything here derives paths from the FRAME's mounted gameId —
 * nothing a frame sends can widen its reach beyond its own arcade.v1.<gameId>
 * tree plus the shared global.* keys.
 *
 * The launcher's single 'message' listener owns the trust boundary (it proves
 * the sender is a frame we mounted and that its origin is opaque 'null'); it
 * hands each already-authenticated storage message here as (gameId, data).
 * This module never re-derives frame identity — callers have proven it.
 *
 * initStorageBridge(host) returns the dispatch handles the launcher's router
 * calls. `host` supplies the launcher-owned glue (see index.html's
 * window.__arcade.storageHost).
 */

import {
    KEY_PREFIX,
    isSafeArcadeKey,
    BRIDGE_VALUE_MAX,
    BRIDGE_STORE_VALUE_MAX,
    BRIDGE_FILE_MAX,
    approxSize,
    SETTINGS_KEY_RE,
    bridgeKeyWritable,
    STORE_NAME_RE,
    BRIDGE_FILE_NAME_RE,
    idbOpen,
    idbAll,
    idbPut,
    idbGet,
    idbDel,
    idbClear
} from './arcade-storage-core.js';

export function initStorageBridge(host) {
    const postToIframe = host.postToIframe;

    function handleBridgedStateWrite(gameId, data) {
        const key = data.key;
        if (!bridgeKeyWritable(gameId, key)) return;
        const value = (data.value === undefined) ? null : data.value;
        if (value !== null && (typeof value !== 'string' || value.length > BRIDGE_VALUE_MAX)) {
            postToIframe(gameId, { type: 'arcade:state.writeError', key: key, error: 'value rejected (must be a string ≤ 2 MB)' });
            return;
        }
        try {
            if (value === null) localStorage.removeItem(key);
            else localStorage.setItem(key, value);
        } catch (e) {
            postToIframe(gameId, { type: 'arcade:state.writeError', key: key, error: 'storage quota exceeded' });
            return;
        }
        // Sync engine hook (arcade-sync.js, wired in index.html): every
        // committed bridged write, synced or not — the engine does its own
        // cheap eligibility gate, so this call is unconditional.
        if (host.onStateWritten) { try { host.onStateWritten(gameId, key, value); } catch (e) {} }
        // Shared keys: other frames' storage events never fire for a
        // launcher-document write — push the change to them explicitly.
        const shared = key.startsWith(KEY_PREFIX + 'global.') || key === KEY_PREFIX + '_meta.dev';
        if (!shared) return;
        for (const gid of host.listMountedGameIds()) {
            if (gid !== gameId) postToIframe(gid, { type: 'arcade:state.changed', key: key, value: value });
        }
        // A game writing a launcher-managed setting (e.g. handedness)
        // must reach every frame's settings stream too.
        if (SETTINGS_KEY_RE.test(key)) host.broadcastSettings();
    }

    function bridgeReply(gameId, id, ok, value, error) {
        const msg = { type: 'arcade:bridge.result', id: id, ok: ok };
        if (ok) msg.value = value === undefined ? null : value;
        else msg.error = String(error || 'operation failed');
        postToIframe(gameId, msg);
    }
    function validRpcId(id) { return typeof id === 'string' && id.length >= 1 && id.length <= 32; }

    async function handleStoreOp(gameId, data) {
        if (!validRpcId(data.id)) return;
        const name = (data.name === undefined || data.name === null) ? 'default' : String(data.name);
        if (!STORE_NAME_RE.test(name)) return bridgeReply(gameId, data.id, false, undefined, 'bad store name');
        const dbName = KEY_PREFIX + gameId + '.store.' + name;
        try {
            const db = await idbOpen(dbName);
            try {
                switch (data.op) {
                    case 'get': {
                        const v = await idbGet(db, String(data.key));
                        return bridgeReply(gameId, data.id, true, v === undefined ? null : v);
                    }
                    case 'set':
                        if (approxSize(data.value) > BRIDGE_STORE_VALUE_MAX) {
                            return bridgeReply(gameId, data.id, false, undefined, 'store value too large (max 16 MB)');
                        }
                        await idbPut(db, String(data.key), data.value);
                        return bridgeReply(gameId, data.id, true, true);
                    case 'del':
                        await idbDel(db, String(data.key));
                        return bridgeReply(gameId, data.id, true, true);
                    case 'keys': {
                        const rows = await idbAll(db);
                        return bridgeReply(gameId, data.id, true, rows.map((r) => r.key));
                    }
                    case 'entries': {
                        const rows = await idbAll(db);
                        return bridgeReply(gameId, data.id, true, rows.map((r) => [r.key, r.value]));
                    }
                    case 'clear':
                        await idbClear(db);
                        return bridgeReply(gameId, data.id, true, true);
                    default:
                        return bridgeReply(gameId, data.id, false, undefined, 'unknown store op');
                }
            } finally { db.close(); }
        } catch (e) {
            return bridgeReply(gameId, data.id, false, undefined, (e && e.message) || 'store op failed');
        }
    }

    async function handleFilesOp(gameId, data) {
        if (!validRpcId(data.id)) return;
        const dir = KEY_PREFIX + gameId;
        const opfs = !!(navigator.storage && navigator.storage.getDirectory);
        try {
            switch (data.op) {
                case 'put': {
                    const n = String(data.name);
                    if (!BRIDGE_FILE_NAME_RE.test(n)) return bridgeReply(gameId, data.id, false, undefined, 'bad file name');
                    if (!(data.blob instanceof Blob)) return bridgeReply(gameId, data.id, false, undefined, 'not a Blob');
                    if (data.blob.size > BRIDGE_FILE_MAX) return bridgeReply(gameId, data.id, false, undefined, 'file too large (max 64 MB)');
                    if (opfs) {
                        const root = await navigator.storage.getDirectory();
                        const d = await root.getDirectoryHandle(dir, { create: true });
                        const fh = await d.getFileHandle(n, { create: true });
                        const w = await fh.createWritable();
                        await w.write(data.blob); await w.close();
                    } else {
                        const db = await idbOpen(dir + '.files');
                        try { await idbPut(db, n, { blob: data.blob, size: data.blob.size, type: data.blob.type }); }
                        finally { db.close(); }
                    }
                    return bridgeReply(gameId, data.id, true, true);
                }
                case 'get': {
                    const n = String(data.name);
                    if (!BRIDGE_FILE_NAME_RE.test(n)) return bridgeReply(gameId, data.id, true, null);
                    if (opfs) {
                        try {
                            const root = await navigator.storage.getDirectory();
                            const d = await root.getDirectoryHandle(dir, { create: false });
                            const fh = await d.getFileHandle(n, { create: false });
                            return bridgeReply(gameId, data.id, true, await fh.getFile());
                        } catch (e) { return bridgeReply(gameId, data.id, true, null); }
                    }
                    try {
                        const db = await idbOpen(dir + '.files');
                        let rec; try { rec = await idbGet(db, n); } finally { db.close(); }
                        return bridgeReply(gameId, data.id, true, (rec && rec.blob instanceof Blob) ? rec.blob : null);
                    } catch (e) { return bridgeReply(gameId, data.id, true, null); }
                }
                case 'list': {
                    const items = [];
                    if (opfs) {
                        try {
                            const root = await navigator.storage.getDirectory();
                            const d = await root.getDirectoryHandle(dir, { create: false });
                            for await (const h of d.values()) {
                                if (h.kind !== 'file') continue;
                                const f = await h.getFile();
                                items.push({ name: h.name, size: f.size });
                            }
                        } catch (e) { /* no dir yet → [] */ }
                        return bridgeReply(gameId, data.id, true, items);
                    }
                    try {
                        const db = await idbOpen(dir + '.files');
                        let rows; try { rows = await idbAll(db); } finally { db.close(); }
                        for (const r of rows) {
                            items.push({ name: String(r.key), size: (r.value && r.value.size) || 0 });
                        }
                    } catch (e) {}
                    return bridgeReply(gameId, data.id, true, items);
                }
                case 'delete': {
                    const n = String(data.name);
                    if (!BRIDGE_FILE_NAME_RE.test(n)) return bridgeReply(gameId, data.id, true, false);
                    if (opfs) {
                        try {
                            const root = await navigator.storage.getDirectory();
                            const d = await root.getDirectoryHandle(dir, { create: false });
                            await d.removeEntry(n);
                            return bridgeReply(gameId, data.id, true, true);
                        } catch (e) { return bridgeReply(gameId, data.id, true, false); }
                    }
                    try {
                        const db = await idbOpen(dir + '.files');
                        try { await idbDel(db, n); } finally { db.close(); }
                        return bridgeReply(gameId, data.id, true, true);
                    } catch (e) { return bridgeReply(gameId, data.id, true, false); }
                }
                default:
                    return bridgeReply(gameId, data.id, false, undefined, 'unknown files op');
            }
        } catch (e) {
            return bridgeReply(gameId, data.id, false, undefined, (e && e.message) || 'files op failed');
        }
    }

    async function handleStorageOp(gameId, data) {
        if (!validRpcId(data.id)) return;
        try {
            switch (data.op) {
                case 'estimate': {
                    if (navigator.storage && navigator.storage.estimate) {
                        const est = await navigator.storage.estimate();
                        return bridgeReply(gameId, data.id, true, { usage: est.usage, quota: est.quota });
                    }
                    return bridgeReply(gameId, data.id, true, { usage: undefined, quota: undefined });
                }
                case 'persisted':
                    return bridgeReply(gameId, data.id, true,
                        (navigator.storage && navigator.storage.persisted) ? await navigator.storage.persisted() : false);
                case 'persist':
                    return bridgeReply(gameId, data.id, true,
                        (navigator.storage && navigator.storage.persist) ? await navigator.storage.persist() : false);
                default:
                    return bridgeReply(gameId, data.id, false, undefined, 'unknown storage op');
            }
        } catch (e) {
            return bridgeReply(gameId, data.id, false, undefined, (e && e.message) || 'storage op failed');
        }
    }

    return {
        stateWrite: handleBridgedStateWrite,
        storeOp: handleStoreOp,
        filesOp: handleFilesOp,
        storageOp: handleStorageOp
    };
}
