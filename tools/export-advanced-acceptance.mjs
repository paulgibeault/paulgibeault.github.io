#!/usr/bin/env node
//
// tools/export-advanced-acceptance.mjs — end-to-end proof of the per-app +
// passphrase-encrypted export flow (#29): a single real launcher page (no
// P2P), driving the "Export App / Encrypted…" button through its two
// window.__arcade.dialog prompts (scope, then passphrase), proving the
// downloaded file is a real encrypted envelope, that decrypting it restores
// ONLY the chosen app's data, that a wrong passphrase fails closed, and that
// a checksum-mismatched plaintext file is a hard reject unless the user
// explicitly confirms the override warning.
//
//   node tools/export-advanced-acceptance.mjs
//
// Self-contained like export-roundtrip-acceptance.mjs: one static file
// server, one Playwright page, no P2P harness. Port 4801.
//
// Exit code: 0 if all checks pass, 1 otherwise.

import { chromium } from 'playwright';
import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4801;
const GID_A = 'exportadv-a';
const GID_B = 'exportadv-b';
const PASSPHRASE = 'correct horse battery staple';

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
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok, detail: detail || '' }); };

// window.__arcade.dialog is a custom overlay (#arcade-dialog), not a native
// confirm/prompt — Playwright's page.on('dialog') never sees it. Drive it
// directly through its DOM.
async function waitDialogMessage(page, timeout = 8000) {
    await page.waitForSelector('#arcade-dialog:not(.hidden)', { timeout });
    return page.$eval('#arcade-dialog-msg', (el) => el.textContent);
}
async function answerDialog(page, value) {
    await page.fill('#arcade-dialog-input', value);
    await page.click('#arcade-dialog-ok');
}

const HELPERS = () => {
    window.__ea = {
        idbPut: (dbName, key, value) => new Promise((res, rej) => {
            const rq = indexedDB.open(dbName, 1);
            rq.onupgradeneeded = () => { const db = rq.result; if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv'); };
            rq.onsuccess = () => { const db = rq.result; const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(value, key); tx.oncomplete = () => { db.close(); res(); }; tx.onerror = () => rej(tx.error); };
            rq.onerror = () => rej(rq.error);
        }),
        idbGet: (dbName, key) => new Promise((res) => {
            const rq = indexedDB.open(dbName, 1);
            rq.onupgradeneeded = () => { const db = rq.result; if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv'); };
            rq.onsuccess = () => { const db = rq.result; try { const tx = db.transaction('kv', 'readonly'); const g = tx.objectStore('kv').get(key); g.onsuccess = () => { db.close(); res(g.result === undefined ? null : g.result); }; g.onerror = () => { db.close(); res(null); }; } catch (e) { db.close(); res(null); } };
            rq.onerror = () => res(null);
        })
    };
};

const browser = await chromium.launch({ headless: true });
try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    page.on('dialog', (d) => d.accept()); // native window.confirm (gate 7 + override warning)
    page.on('download', () => {});        // absorb the auto-backup download every successful import gate 8 takes

    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
    await page.waitForTimeout(300);
    check('launcher loads without page errors', pageErrors.length === 0, pageErrors[0] || '');

    // ── Seed two apps' data + one shared/global key ──
    await page.evaluate(HELPERS);
    await page.evaluate(async ({ gidA, gidB }) => {
        localStorage.setItem('arcade.v1.' + gidA + '.state.progress', JSON.stringify({ level: 5 }));
        localStorage.setItem('arcade.v1.' + gidB + '.state.progress', JSON.stringify({ level: 9 }));
        localStorage.setItem('arcade.v1.global.theme', '"dark"');
        await window.__ea.idbPut('arcade.v1.' + gidA + '.store.notes', 'note1', { text: 'hello-a' });
    }, { gidA: GID_A, gidB: GID_B });

    // ── 1. Scoped + encrypted export via "Export App / Encrypted…" ──
    const [dl1] = await Promise.all([
        page.waitForEvent('download'),
        (async () => {
            await page.evaluate(() => document.getElementById('btn-save-advanced').click());
            const scopeMsg = await waitDialogMessage(page);
            check('scope prompt lists both seeded apps', scopeMsg.includes(GID_A) && scopeMsg.includes(GID_B), scopeMsg);
            await answerDialog(page, GID_A);
            const passMsg = await waitDialogMessage(page);
            check('passphrase prompt follows the scope prompt', passMsg.toLowerCase().includes('passphrase'), passMsg);
            await answerDialog(page, PASSPHRASE);
        })()
    ]);
    const encPath = await dl1.path();
    const encBundle = JSON.parse(await readFile(encPath, 'utf8'));
    check('exported file is a real encrypted envelope', encBundle.format === 'pauls-arcade-save-enc' && encBundle.v === 1, JSON.stringify(Object.keys(encBundle)));
    check('encrypted envelope has no plaintext trace of the seeded values', !JSON.stringify(encBundle).includes('level'));

    // ── 2. Wipe everything, restore via decrypt import — proves per-app scoping ──
    await page.evaluate(({ gidA, gidB }) => {
        localStorage.removeItem('arcade.v1.' + gidA + '.state.progress');
        localStorage.removeItem('arcade.v1.' + gidB + '.state.progress');
    }, { gidA: GID_A, gidB: GID_B });

    await page.setInputFiles('#file-load', encPath);
    const decMsg = await waitDialogMessage(page);
    check('import detects the encrypted format and asks for a passphrase', decMsg.toLowerCase().includes('encrypted'), decMsg);
    await answerDialog(page, PASSPHRASE);
    await page.waitForTimeout(1000);

    const afterRestore = await page.evaluate(async ({ gidA, gidB }) => ({
        a: localStorage.getItem('arcade.v1.' + gidA + '.state.progress'),
        b: localStorage.getItem('arcade.v1.' + gidB + '.state.progress'),
        note: await window.__ea.idbGet('arcade.v1.' + gidA + '.store.notes', 'note1')
    }), { gidA: GID_A, gidB: GID_B });
    check('scoped restore recovers app A\'s localStorage key', afterRestore.a === JSON.stringify({ level: 5 }), String(afterRestore.a));
    check('scoped restore recovers app A\'s store record', !!afterRestore.note && afterRestore.note.text === 'hello-a', JSON.stringify(afterRestore.note));
    check('scoped restore does NOT bring back app B\'s data (per-app export excluded it)', afterRestore.b === null, String(afterRestore.b));

    // ── 3. Wrong passphrase — single attempt, fails closed, no retry loop ──
    await page.setInputFiles('#file-load', encPath);
    const decMsg2 = await waitDialogMessage(page);
    check('second load re-shows the passphrase prompt', decMsg2.toLowerCase().includes('encrypted'));
    await answerDialog(page, 'definitely the wrong passphrase');
    await page.waitForTimeout(500);
    const dialogStillUp = await page.evaluate(() => !document.getElementById('arcade-dialog').classList.contains('hidden'));
    check('wrong passphrase does not re-prompt (single attempt, no retry loop)', dialogStillUp === false);

    // ── 4. Checksum-override: plain export, hand-edit, re-import ──
    const [dl2] = await Promise.all([
        page.waitForEvent('download'),
        (async () => {
            await page.evaluate(() => document.getElementById('btn-save-advanced').click());
            await waitDialogMessage(page);
            await answerDialog(page, ''); // blank scope = everything
            await waitDialogMessage(page);
            await answerDialog(page, ''); // blank passphrase = plaintext
        })()
    ]);
    const plainPath = await dl2.path();
    const plainBundle = JSON.parse(await readFile(plainPath, 'utf8'));
    check('blank scope + blank passphrase exports a plain, unscoped bundle',
        plainBundle.format !== 'pauls-arcade-save-enc' && !!plainBundle.data['arcade.v1.' + GID_A + '.state.progress']);

    const tamperedKey = 'arcade.v1.' + GID_A + '.state.progress';
    const beforeAttempt = await page.evaluate((k) => localStorage.getItem(k), tamperedKey);
    plainBundle.data[tamperedKey] = JSON.stringify({ level: 999999 }); // breaks the checksum, deliberately
    const tamperedPath = path.join(os.tmpdir(), 'export-advanced-tampered.json');
    await writeFile(tamperedPath, JSON.stringify(plainBundle));

    // The global auto-accept listener registered at the top of this test
    // would silently accept the override warning below (defeating the
    // "decline" case) — remove it and drive both outcomes with their own
    // one-shot listeners instead.
    page.removeAllListeners('dialog');

    // Decline the override — must NOT import.
    let sawOverridePrompt = false;
    page.once('dialog', (d) => { sawOverridePrompt = /checksum/i.test(d.message()); d.dismiss(); });
    await page.setInputFiles('#file-load', tamperedPath);
    await page.waitForTimeout(600);
    check('a checksum-mismatched file raises the override warning', sawOverridePrompt);
    const afterDecline = await page.evaluate((k) => localStorage.getItem(k), tamperedKey);
    check('declining the override leaves state untouched', afterDecline === beforeAttempt, JSON.stringify({ beforeAttempt, afterDecline }));

    // Accept the override — must import despite the mismatch. Chained
    // (not two once() calls registered up front): Node's EventEmitter fires
    // ALL currently-registered listeners for an event, so two once()s
    // registered before the fact would both fire on the SAME first dialog.
    // The second listener must only start listening once the first dialog
    // (the override warning) has actually been handled.
    page.once('dialog', (d1) => {
        d1.accept(); // the override-warning confirm
        page.once('dialog', (d2) => { d2.accept(); }); // gate 7's own confirm right after
    });
    await page.setInputFiles('#file-load', tamperedPath);
    await page.waitForTimeout(1000);
    const afterAccept = await page.evaluate((k) => localStorage.getItem(k), tamperedKey);
    check('accepting the override commits the mismatched data anyway',
        afterAccept === JSON.stringify({ level: 999999 }), String(afterAccept));
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
console.log('All export-advanced acceptance checks passed.');
