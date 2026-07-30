#!/usr/bin/env node
//
// tools/backup-dialog-acceptance.mjs — end-to-end proof of the Game Data
// dialog (arcade-backup-ui.js): menu entry opens it, the status line reflects
// the automatic-local-backup state, the export scope select lists apps with
// data, the data viewer renders per-app collapsible groups, and — the big
// one — a trusted-peer backup stored on this device is restorable from the
// dialog WITHOUT the P2P bridge ever loading. Also proves the DB-creation
// guard: merely opening the dialog on a device that never engaged peer
// backup must not create the 'arcade-backup' IndexedDB.
//
//   node tools/backup-dialog-acceptance.mjs
//
// Self-contained like export-roundtrip-acceptance.mjs: one static file
// server, Playwright pages, no P2P harness. Port 4807.
//
// Exit code: 0 if all checks pass, 1 otherwise.

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveRepo } from './lib/static-server.mjs';
import { createRecorder } from './lib/check-recorder.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4807;
const GID_A = 'bkdlg-a';
const GID_B = 'bkdlg-b';
const PEER_ID = 'peer-device-xyz';

const server = await serveRepo({ root: ROOT, port: PORT });
const { check, summarize } = createRecorder();

// Raw-IDB helpers — the suite seeds/reads engine databases directly.
const HELPERS = () => {
    window.__bd = {
        idbPut: (dbName, key, value) => new Promise((res, rej) => {
            const rq = indexedDB.open(dbName, 1);
            rq.onupgradeneeded = () => { const db = rq.result; if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv'); };
            rq.onsuccess = () => { const db = rq.result; const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(value, key); tx.oncomplete = () => { db.close(); res(); }; tx.onerror = () => rej(tx.error); };
            rq.onerror = () => rej(rq.error);
        }),
        dbNames: async () => (await indexedDB.databases()).map((d) => d.name)
    };
};

const browser = await chromium.launch({ headless: true });
try {
    // ──────────────────────────────────────────────────────────────────
    // Page 1: fresh profile — dialog opens, empty-state status line, and
    // the no-backupTarget guard (no 'arcade-backup' DB creation).
    // ──────────────────────────────────────────────────────────────────
    {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        const pageErrors = [];
        page.on('pageerror', (e) => pageErrors.push(e.message));
        await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
        await page.evaluate(HELPERS);

        await page.evaluate(() => document.getElementById('menu-backup').click());
        const dialogVisible = await page.evaluate(() => !document.getElementById('backup-dialog').hidden);
        check('#menu-backup opens the Game Data dialog', dialogVisible);

        // Status line settles async after open.
        await page.waitForFunction(() =>
            !document.getElementById('backup-dialog-status').textContent.startsWith('Checking'), null, { timeout: 5000 });
        const emptyStatus = await page.$eval('#backup-dialog-status', (el) => el.textContent);
        check('fresh profile shows the "no automatic backup yet" status', /no automatic backup yet/i.test(emptyStatus), emptyStatus);

        const peerRows = await page.$eval('#backup-restore-peers', (el) => el.children.length);
        check('fresh profile renders zero peer restore rows', peerRows === 0, String(peerRows));

        // The guard: opening the dialog (which calls listStoredSenders) on a
        // profile whose knownPeers never engaged backup must not create the
        // 'arcade-backup' DB. (The local-backup engine's own DB is fine.)
        await page.waitForTimeout(400);
        const names = await page.evaluate(() => window.__bd.dbNames());
        check("opening the dialog does not create the 'arcade-backup' DB", !names.includes('arcade-backup'), names.join(','));

        check('no page errors on the fresh profile', pageErrors.length === 0, pageErrors[0] || '');
        await ctx.close();
    }

    // ──────────────────────────────────────────────────────────────────
    // Page 2: seeded profile — status after a forced snapshot, scope
    // select options, data viewer rendering, export button state, and
    // peer-backup restore without the P2P bridge.
    // ──────────────────────────────────────────────────────────────────
    {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        const pageErrors = [];
        page.on('pageerror', (e) => pageErrors.push(e.message));
        page.on('dialog', (d) => d.accept()); // import confirm (gate 7)
        page.on('download', () => {});        // absorb exports + gate-8 auto-backups

        await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
        await page.evaluate(HELPERS);

        // Seed two apps: JSON + non-JSON localStorage values, one store DB.
        await page.evaluate(async ({ gidA, gidB }) => {
            localStorage.setItem('arcade.v1.' + gidA + '.state.progress', JSON.stringify({ level: 5, name: 'aria' }));
            localStorage.setItem('arcade.v1.' + gidA + '.state.rawnote', 'not json at all');
            localStorage.setItem('arcade.v1.' + gidB + '.state.progress', JSON.stringify({ level: 9 }));
            await window.__bd.idbPut('arcade.v1.' + gidA + '.store.notes', 'note1', { text: 'hello-a' });
        }, { gidA: GID_A, gidB: GID_B });

        // Force an automatic snapshot, then open the dialog: status line and
        // the local-restore row meta must show a timestamp.
        await page.evaluate(() => window.__arcade.localBackup.maybeSnapshot(true));
        await page.evaluate(() => window.__arcade.backupDialog.open());
        await page.waitForFunction(() =>
            /Last automatic backup:/.test(document.getElementById('backup-dialog-status').textContent), null, { timeout: 5000 });
        const status = await page.$eval('#backup-dialog-status', (el) => el.textContent);
        check('status line shows the automatic-backup timestamp and count', /Last automatic backup: .+ · 1 kept/.test(status), status);
        const localWhen = await page.$eval('#backup-local-when', (el) => el.textContent);
        check('local-restore row carries the snapshot timestamp', localWhen.length > 4 && localWhen !== 'none yet', localWhen);

        // Scope select: Everything first, then the seeded apps.
        await page.waitForFunction(({ gidA, gidB }) => {
            const opts = [...document.getElementById('backup-export-scope').options].map((o) => o.value);
            return opts.includes(gidA) && opts.includes(gidB);
        }, { gidA: GID_A, gidB: GID_B }, { timeout: 5000 });
        const firstOpt = await page.$eval('#backup-export-scope', (el) => ({ v: el.options[0].value, t: el.options[0].textContent }));
        check('scope select lists "Everything" first', firstOpt.v === '' && /everything/i.test(firstOpt.t), JSON.stringify(firstOpt));

        // Data viewer: expand, assert per-app groups, counts, JSON pretty-
        // print, and raw-string rendering.
        await page.evaluate(() => { document.getElementById('backup-view-data').open = true; });
        await page.waitForFunction((gidA) =>
            [...document.querySelectorAll('#backup-view-data-body .backup-dialog__app > summary')]
                .some((s) => s.textContent.includes(gidA)), GID_A, { timeout: 5000 });
        const viewer = await page.evaluate(({ gidA, gidB }) => {
            const apps = [...document.querySelectorAll('#backup-view-data-body .backup-dialog__app')];
            const findApp = (gid) => apps.find((a) => a.querySelector('summary').textContent.includes(gid));
            const a = findApp(gidA), b = findApp(gidB);
            const aSummary = a ? a.querySelector('summary').textContent : '';
            const aValues = a ? [...a.querySelectorAll('.backup-dialog__value')].map((p) => p.textContent) : [];
            return {
                appCount: apps.length,
                aSummary,
                bFound: !!b,
                aValues,
                aStoreRows: a ? [...a.querySelectorAll('.backup-dialog__meta-row')].map((r) => r.textContent) : []
            };
        }, { gidA: GID_A, gidB: GID_B });
        check('viewer renders a group per seeded app (plus launcher/shared)', viewer.appCount >= 2 && viewer.bFound, String(viewer.appCount));
        check('app summary reports its key and store counts', /2 keys/.test(viewer.aSummary) && /1 store/.test(viewer.aSummary), viewer.aSummary);
        check('a JSON value renders pretty-printed', viewer.aValues.some((v) => v.includes('\n') && v.includes('"level": 5')), JSON.stringify(viewer.aValues));
        check('a non-JSON value renders raw', viewer.aValues.some((v) => v === 'not json at all'));
        check('a store row shows its record count', viewer.aStoreRows.some((r) => /notes.*1 record/.test(r)), viewer.aStoreRows.join(' | '));

        // Export button disables while running, passphrase clears after.
        await page.fill('#backup-export-passphrase', 'hunter2');
        const [dl] = await Promise.all([
            page.waitForEvent('download'),
            page.click('#backup-export-run')
        ]);
        check('export produced a download', !!dl);
        await page.waitForFunction(() => !document.getElementById('backup-export-run').disabled, null, { timeout: 5000 });
        const passAfter = await page.$eval('#backup-export-passphrase', (el) => el.value);
        check('passphrase field cleared after export', passAfter === '');

        // ── Peer restore without P2P ──
        // Capture a real bundle, wipe a key, store the bundle as a stored
        // generation from a fake peer (plaintext {json} row — the documented
        // no-pair-secret fallback), flag the peer, reopen the dialog.
        const bundle = await page.evaluate(() => window.__arcade.save.exportBundleString());
        check('exportBundleString produced a bundle to seed with', !!bundle && typeof bundle.json === 'string');
        await page.evaluate(({ gidA, peerId, bundle }) => {
            localStorage.removeItem('arcade.v1.' + gidA + '.state.progress');
            const peers = JSON.parse(localStorage.getItem('arcade.v1._meta.knownPeers') || '{}');
            peers[peerId] = { name: 'Kitchen Tablet', backupTarget: true };
            localStorage.setItem('arcade.v1._meta.knownPeers', JSON.stringify(peers));
            const ms = String(Date.now()).padStart(13, '0');
            const meta = { checksum: bundle.checksum, chars: bundle.json.length, exportedAt: bundle.exportedAt, receivedAt: Date.now() };
            return Promise.all([
                window.__bd.idbPut('arcade-backup', 'g|' + peerId + '|' + ms, { json: bundle.json }),
                window.__bd.idbPut('arcade-backup', 'm|' + peerId + '|' + ms, meta)
            ]);
        }, { gidA: GID_A, peerId: PEER_ID, bundle });

        await page.evaluate(() => { window.__arcade.backupDialog.close(); window.__arcade.backupDialog.open(); });
        await page.waitForFunction(() =>
            document.getElementById('backup-restore-peers').children.length > 0, null, { timeout: 5000 });
        const rowText = await page.$eval('#backup-restore-peers', (el) => el.textContent);
        check('peer restore row renders with name and received date', rowText.includes('Kitchen Tablet') && /received/.test(rowText), rowText);
        const p2pLoaded = await page.evaluate(() => window.__arcade.p2p != null);
        check('the P2P bridge never loaded (restore list is bridge-free)', p2pLoaded === false);

        // Click the row; the native import confirm auto-accepts; the wiped
        // key must come back (merge import of the seeded generation).
        await page.click('#backup-restore-peers .backup-dialog__row');
        await page.waitForFunction((gidA) =>
            localStorage.getItem('arcade.v1.' + gidA + '.state.progress') !== null, GID_A, { timeout: 8000 });
        const restored = await page.evaluate((gidA) => localStorage.getItem('arcade.v1.' + gidA + '.state.progress'), GID_A);
        check('clicking the peer row restores the wiped key', restored === JSON.stringify({ level: 5, name: 'aria' }), String(restored));

        check('no page errors on the seeded profile', pageErrors.length === 0, pageErrors[0] || '');
        await ctx.close();
    }
} finally {
    await browser.close();
    server.close();
}

process.exit(summarize({ label: 'backup-dialog acceptance' }));
