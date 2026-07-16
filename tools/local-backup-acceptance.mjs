#!/usr/bin/env node
//
// tools/local-backup-acceptance.mjs — end-to-end proof of automatic local
// backup (#30): a single real launcher page (no P2P — this feature never
// leaves the device), proving the PRODUCTION path — arcade-save.js
// exportBundleString -> arcade-local-backup.js's rolling IndexedDB snapshot
// -> restoreLatest through the SAME import gates a file load uses -> the
// optional File System Access "backup folder" export + pruning -> the
// feature-detect fallback when the API is absent.
//
//   node tools/local-backup-acceptance.mjs
//
// Self-contained like export-roundtrip-acceptance.mjs: one static file
// server, one Playwright page, no P2P harness. Port 4800.
//
// Exit code: 0 if all checks pass, 1 otherwise.

import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCAL_BACKUP_GENERATIONS } from '../arcade-local-backup-core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4800;
const GID = 'local-backup-test';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer(async (req, res) => {
    try {
        let p = decodeURIComponent(req.url.split('?')[0]);
        if (p.endsWith('/')) p += 'index.html';
        const file = path.join(ROOT, p);
        if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
        const body = await readFile(file);
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(body);
    } catch { res.writeHead(404).end('not found'); }
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));

const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok, detail: detail || '' }); };

async function waitFor(fn, timeoutMs = 10000, stepMs = 100) {
    const start = Date.now();
    for (;;) {
        if (await fn()) return true;
        if (Date.now() - start > timeoutMs) return false;
        await new Promise((r) => setTimeout(r, stepMs));
    }
}

// In-page stub for the File System Access API — a real FileSystemDirectoryHandle
// is structured-cloneable via IndexedDB (a spec'd browser feature); a plain JS
// mock with function properties is NOT, which is exactly why
// arcade-local-backup.js's chooseFolder() treats persisting the handle as
// best-effort (try/catch around idbPut) rather than a hard requirement — the
// in-memory grant still works for the rest of this page session either way.
function installFolderStub() {
    window.__folderFiles = new Map(); // filename -> written string content
    window.__fakeDirHandle = {
        name: 'FakeBackupFolder',
        kind: 'directory',
        getFileHandle: async (name) => ({
            kind: 'file',
            name,
            createWritable: async () => ({
                write: async (data) => { window.__folderFiles.set(name, data); },
                close: async () => {}
            })
        }),
        removeEntry: async (name) => { window.__folderFiles.delete(name); },
        queryPermission: async () => 'granted',
        requestPermission: async () => 'granted',
        values: async function* () {
            for (const name of window.__folderFiles.keys()) yield { kind: 'file', name };
        }
    };
    window.showDirectoryPicker = async () => window.__fakeDirHandle;
}

const browser = await chromium.launch({ headless: true });
try {
    // ── Scenario A: fresh install accrues a boot snapshot; forced staleness
    //    re-snapshots; restore recovers cleared state; folder grant exports
    //    + prunes. All on one page — each step's precondition is set by the
    //    step before it, matching how a real session evolves. ──
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    page.on('dialog', (d) => d.accept()); // native confirm() during restore
    page.on('download', () => {});        // absorb the auto-backup download the import gate takes

    await page.addInitScript(installFolderStub);
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
    await page.waitForTimeout(300);
    check('launcher loads without page errors', pageErrors.length === 0, pageErrors[0] || '');

    const setState = (level) => page.evaluate(
        ({ gid, level }) => localStorage.setItem('arcade.v1.' + gid + '.state.progress', JSON.stringify({ level })),
        { gid: GID, level }
    );
    const getState = () => page.evaluate((gid) => localStorage.getItem('arcade.v1.' + gid + '.state.progress'), GID);
    const status = () => page.evaluate(() => window.__arcade.localBackup._debugStatus());
    const forceSnapshot = () => page.evaluate(() => window.__arcade.localBackup.maybeSnapshot(true));

    // The in-memory generation index is only ever populated once, at boot
    // (ensureDb()'s IDB read) — so proving BOTH the fresh-install snapshot
    // AND the >24h staleness gate for real (not via the maybeSnapshot(true)
    // escape hatch) means seeding state BEFORE a real navigation/boot, not
    // patching IDB out from under an already-running engine instance.
    check('nothing importable yet — no snapshot on the very first boot',
        (await status()).count === 0, JSON.stringify(await status()));

    await setState(1);
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(300);
    check('fresh state accrues exactly one IDB snapshot on the next boot',
        await waitFor(async () => (await status()).count === 1, 10000),
        JSON.stringify(await status()));
    const firstNewest = (await status()).newest;

    // Force staleness: rewrite the stored generation's meta row directly via
    // raw IndexedDB (mirrors the split-row 'm|' layout arcade-local-backup.js
    // writes) so the row on disk is >24h old, change the state (so the
    // "identical to newest" dedupe in planGenerationStore doesn't swallow
    // an unchanged bundle), then reload — a REAL boot, reading the patched
    // row fresh, is what proves the >24h staleness gate itself rather than
    // the maybeSnapshot(true) manual-override escape hatch.
    await page.evaluate(() => new Promise((resolve, reject) => {
        const rq = indexedDB.open('arcade-local-backup', 1);
        rq.onsuccess = () => {
            const db = rq.result;
            const tx = db.transaction('kv', 'readwrite');
            const store = tx.objectStore('kv');
            const getKeys = store.getAllKeys();
            getKeys.onsuccess = () => {
                const metaKey = getKeys.result.find((k) => typeof k === 'string' && k.startsWith('m|'));
                const g = store.get(metaKey);
                g.onsuccess = () => {
                    const meta = g.result;
                    meta.receivedAt = Date.now() - 25 * 60 * 60 * 1000; // 25h ago: over the 24h window
                    store.put(meta, metaKey);
                };
            };
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror = () => reject(tx.error);
        };
        rq.onerror = () => reject(rq.error);
    }));
    await setState(2);
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(300);

    check('a backdated (>24h stale) snapshot triggers a fresh one on boot, keeping 2 generations',
        await waitFor(async () => (await status()).count === 2, 10000),
        JSON.stringify(await status()));
    const secondStatus = await status();
    check('the fresh snapshot is newer than the backdated one and has a different checksum',
        secondStatus.newest.receivedAt > firstNewest.receivedAt && secondStatus.newest.checksum !== firstNewest.checksum,
        JSON.stringify({ firstNewest, secondStatus }));

    // Corrupt/clear the seeded key, then restore — must ride the full import
    // gate chain (native confirm accepted above) and recover it.
    await page.evaluate((gid) => localStorage.removeItem('arcade.v1.' + gid + '.state.progress'), GID);
    check('seeded key is cleared before restore', (await getState()) === null);

    const restored = await page.evaluate(() => window.__arcade.localBackup.restoreLatest());
    check('restoreLatest() reports a successful commit', restored === true);
    check('restore recovered the exact seeded state (level 2, the newest generation)',
        (await getState()) === JSON.stringify({ level: 2 }), String(await getState()));

    // ── Folder grant: click, assert a dated file lands in the stub with the
    //    current bundle's content, then force enough cycles to prove pruning. ──
    await page.evaluate(() => document.getElementById('btn-choose-backup-folder').click());
    check('folder grant completes and the label updates',
        await waitFor(async () => (await page.evaluate(() =>
            document.getElementById('btn-choose-backup-folder-label').textContent)).includes('FakeBackupFolder')));

    let folderFiles = await page.evaluate(() => Array.from(window.__folderFiles.keys()));
    check('granting the folder immediately exports one dated file',
        folderFiles.length === 1 && /^pauls-arcade-local-backup-.+\.json$/.test(folderFiles[0]),
        JSON.stringify(folderFiles));
    const exportedContent = await page.evaluate((name) => window.__folderFiles.get(name), folderFiles[0]);
    check('the exported file content matches the current bundle checksum',
        JSON.parse(exportedContent).checksum === secondStatus.newest.checksum);

    // Force enough additional distinct-content snapshots to exceed the
    // retention cap in BOTH the IDB index and the folder, proving both
    // prune to LOCAL_BACKUP_GENERATIONS. A short pause between cycles keeps
    // each dated filename's millisecond-resolution timestamp distinct.
    for (let level = 3; level <= LOCAL_BACKUP_GENERATIONS + 2; level++) {
        await setState(level);
        await forceSnapshot();
        await page.waitForTimeout(20);
    }

    const finalStatus = await status();
    check(`IDB snapshot index is pruned to exactly ${LOCAL_BACKUP_GENERATIONS} generations`,
        finalStatus.count === LOCAL_BACKUP_GENERATIONS, JSON.stringify(finalStatus));

    folderFiles = await page.evaluate(() => Array.from(window.__folderFiles.keys()));
    check(`backup folder is pruned to exactly ${LOCAL_BACKUP_GENERATIONS} dated files`,
        folderFiles.length === LOCAL_BACKUP_GENERATIONS, JSON.stringify(folderFiles));

    // ── Scenario B: feature-detection fallback — a separate context with no
    //    File System Access API must hide the folder button entirely. ──
    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();
    await page2.addInitScript(() => { delete window.showDirectoryPicker; });
    await page2.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
    await page2.waitForTimeout(300);
    const folderBtnHidden = await page2.evaluate(() => document.getElementById('btn-choose-backup-folder').hidden);
    check('folder button is hidden when showDirectoryPicker is unavailable', folderBtnHidden === true);
    const restoreBtnStillWorks = await page2.evaluate(() => typeof window.__arcade.localBackup.restoreLatest === 'function');
    check('the rest of the engine still initializes normally without the FS Access API', restoreBtnStillWorks);
    await ctx2.close();
} finally {
    await browser.close();
    server.close();
}

let failed = 0;
for (const c of checks) {
    console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.detail && !c.ok ? '   (' + c.detail + ')' : ''}`);
    if (!c.ok) failed++;
}
console.log('');
if (failed) { console.log(`${failed} check(s) FAILED.`); process.exit(1); }
console.log('All local-backup acceptance checks passed.');
