#!/usr/bin/env node
//
// tools/export-roundtrip-acceptance.mjs — proves the launcher save/export now
// round-trips per-app IndexedDB (Arcade.store) and blob (Arcade.files) data,
// AND never touches the P2P key stores (qrp2p-identity / qrp2p-rendezvous).
//
// Flow: seed localStorage + a store DB + a file + P2P sentinels → export
// (capture download) → wipe arcade data (leave qrp2p-*) → import the file →
// assert everything came back byte-identical and the P2P sentinels are intact.
//
//   node tools/export-roundtrip-acceptance.mjs
//
// Exit code: 0 if all checks pass, 1 otherwise.

import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveRepo } from './lib/static-server.mjs';
import { createRecorder } from './lib/check-recorder.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4797;
const GID = 'roundtrip-test';

const server = await serveRepo({ root: ROOT, port: PORT });

const { check, summarize } = createRecorder();

// Helpers injected into the page context (raw storage — the launcher itself
// isn't Arcade.init'd, so we seed/read the underlying IndexedDB/OPFS directly).
const HELPERS = (gid) => {
    window.__rt = {
        idbPut: (dbName, store, key, value) => new Promise((res, rej) => {
            const rq = indexedDB.open(dbName, 1);
            rq.onupgradeneeded = () => { const db = rq.result; if (!db.objectStoreNames.contains(store)) db.createObjectStore(store); };
            rq.onsuccess = () => { const db = rq.result; const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(value, key); tx.oncomplete = () => { db.close(); res(); }; tx.onerror = () => rej(tx.error); };
            rq.onerror = () => rej(rq.error);
        }),
        idbGet: (dbName, store, key) => new Promise((res) => {
            const rq = indexedDB.open(dbName, 1);
            rq.onupgradeneeded = () => { const db = rq.result; if (!db.objectStoreNames.contains(store)) db.createObjectStore(store); };
            rq.onsuccess = () => { const db = rq.result; try { const tx = db.transaction(store, 'readonly'); const g = tx.objectStore(store).get(key); g.onsuccess = () => { db.close(); res(g.result === undefined ? null : g.result); }; g.onerror = () => { db.close(); res(null); }; } catch (e) { db.close(); res(null); } };
            rq.onerror = () => res(null);
        }),
        del: (dbName) => new Promise((res) => { const rq = indexedDB.deleteDatabase(dbName); rq.onsuccess = rq.onerror = rq.onblocked = () => res(); }),
        opfsPut: async (dir, name, text) => { const root = await navigator.storage.getDirectory(); const d = await root.getDirectoryHandle(dir, { create: true }); const fh = await d.getFileHandle(name, { create: true }); const w = await fh.createWritable(); await w.write(new Blob([text])); await w.close(); },
        opfsGet: async (dir, name) => { try { const root = await navigator.storage.getDirectory(); const d = await root.getDirectoryHandle(dir, { create: false }); const fh = await d.getFileHandle(name, { create: false }); const f = await fh.getFile(); return await f.text(); } catch (e) { return null; } },
        opfsDel: async (dir) => { try { const root = await navigator.storage.getDirectory(); await root.removeEntry(dir, { recursive: true }); } catch (e) {} },
        filesGet: async (gid, name) => {
            // read whichever backend the SDK/import used
            const opfs = await window.__rt.opfsGet('arcade.v1.' + gid, name);
            if (opfs !== null) return opfs;
            const rec = await window.__rt.idbGet('arcade.v1.' + gid + '.files', 'kv', name);
            return rec && rec.blob ? await rec.blob.text() : null;
        },
    };
};

const browser = await chromium.launch({ headless: true });
try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    page.on('dialog', d => d.accept());          // confirm() during import
    page.on('download', () => {});               // absorb the auto-backup download

    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
    await page.waitForTimeout(500);
    check('launcher loads without page errors', pageErrors.length === 0, pageErrors[0] || '');

    // ── Seed ──
    await page.evaluate(HELPERS, GID);
    await page.evaluate(async (gid) => {
        localStorage.setItem('arcade.v1.' + gid + '.state.progress', JSON.stringify({ level: 7 }));
        await window.__rt.idbPut('arcade.v1.' + gid + '.store.notes', 'kv', 'note1', { text: 'hello', n: 42 });
        await window.__rt.opfsPut('arcade.v1.' + gid, 'pic.txt', 'BINARY-CONTENT-😀');
        // P2P sentinels that MUST survive untouched
        await window.__rt.idbPut('qrp2p-identity', 'identity', 'certificate', { sentinel: 'IDENTITY' });
        await window.__rt.idbPut('qrp2p-rendezvous', 'pairs', 'peerX', { sentinel: 'RENDEZVOUS' });
    }, GID);

    // ── Export (capture download) ──
    const [dl] = await Promise.all([
        page.waitForEvent('download'),
        page.evaluate(() => document.getElementById('btn-save').click()),
    ]);
    const bundle = JSON.parse(await readFile(await dl.path(), 'utf8'));
    check('export bundle is schema v2', bundle.schemaVersion === 2, 'got ' + bundle.schemaVersion);
    check('export includes the localStorage key', !!bundle.data['arcade.v1.' + GID + '.state.progress']);
    check('export includes the Arcade.store DB', !!(bundle.stores && bundle.stores['arcade.v1.' + GID + '.store.notes']), Object.keys(bundle.stores || {}).join(','));
    const filesArr = (bundle.files || {})['arcade.v1.' + GID] || [];
    check('export includes the Arcade.files blob', filesArr.some(f => f.name === 'pic.txt'));
    const bundleStr = JSON.stringify(bundle);
    check('export contains NO qrp2p data', !/qrp2p|IDENTITY|RENDEZVOUS/.test(bundleStr));

    // ── Wipe arcade data (leave qrp2p-* intact) ──
    await page.evaluate(async (gid) => {
        localStorage.removeItem('arcade.v1.' + gid + '.state.progress');
        await window.__rt.del('arcade.v1.' + gid + '.store.notes');
        await window.__rt.del('arcade.v1.' + gid + '.files');
        await window.__rt.opfsDel('arcade.v1.' + gid);
    }, GID);
    const wiped = await page.evaluate(async (gid) => ({
        ls: localStorage.getItem('arcade.v1.' + gid + '.state.progress'),
        note: await window.__rt.idbGet('arcade.v1.' + gid + '.store.notes', 'kv', 'note1'),
        file: await window.__rt.filesGet(gid, 'pic.txt'),
    }), GID);
    check('wipe cleared arcade data', wiped.ls === null && wiped.note === null && wiped.file === null);

    // ── Import the captured file ──
    await page.setInputFiles('#file-load', await dl.path());
    await page.waitForTimeout(1200);

    const after = await page.evaluate(async (gid) => ({
        ls: localStorage.getItem('arcade.v1.' + gid + '.state.progress'),
        note: await window.__rt.idbGet('arcade.v1.' + gid + '.store.notes', 'kv', 'note1'),
        file: await window.__rt.filesGet(gid, 'pic.txt'),
        idn: await window.__rt.idbGet('qrp2p-identity', 'identity', 'certificate'),
        rdv: await window.__rt.idbGet('qrp2p-rendezvous', 'pairs', 'peerX'),
    }), GID);
    check('import restored the localStorage key', after.ls === JSON.stringify({ level: 7 }), String(after.ls));
    check('import restored the Arcade.store value', !!after.note && after.note.text === 'hello' && after.note.n === 42, JSON.stringify(after.note));
    check('import restored the Arcade.files blob (bytes intact)', after.file === 'BINARY-CONTENT-😀', String(after.file));
    check('P2P identity store untouched', !!after.idn && after.idn.sentinel === 'IDENTITY');
    check('P2P rendezvous store untouched', !!after.rdv && after.rdv.sentinel === 'RENDEZVOUS');
} finally {
    await browser.close();
    server.close();
}

process.exit(summarize({ label: 'export-roundtrip acceptance' }));
