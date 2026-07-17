#!/usr/bin/env node
//
// tools/user-identity-acceptance.mjs — exercises the user-identity layer
// (#32) against a real browser: Ed25519 keygen/persistence in IndexedDB,
// recovery-code round-trip through the REAL Chromium WebCrypto (the Node
// unit test can't rule out an engine-specific PKCS8 quirk), and the
// Multiplayer dialog's Identity panel (create → code revealed → restore
// round-trips the same userPub). Self-contained: serves the repo on :4797.
//
//   node tools/user-identity-acceptance.mjs
//
// Exit code: 0 if all checks pass, 1 otherwise.

import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4797;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
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

const browser = await chromium.launch({ headless: true });
try {
    const page = await browser.newPage();
    page.on('pageerror', e => check('no page errors', false, e.message));
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });

    // ── module API in a real browser ──
    const api = await page.evaluate(async () => {
        const m = await import('./arcade-user-identity.js');
        const supported = await m.userIdentitySupported();
        if (!supported) return { supported };
        const created = await m.ensureUserIdentity();
        const meta = m.readUserIdentityMeta();
        const again = await m.ensureUserIdentity();
        const code = await m.exportRecoveryCode();
        const cert = await m.signDeviceCert('f47ac10b-58cc-4372-a567-0e02b2c3d479',
            'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89');
        const certOk = await m.verifyDeviceCert(meta.userPub, cert);
        const certTampered = await m.verifyDeviceCert(meta.userPub, { ...cert, fingerprint: cert.fingerprint.replace('AB', 'AC') });
        // Restore the SAME code over itself: userPub must survive.
        const restored = await m.importRecoveryCode(code.toLowerCase());
        const metaAfter = m.readUserIdentityMeta();
        // A garbled code must fail closed without touching the stored identity.
        const bad = await m.importRecoveryCode(code.slice(0, -6));
        const metaAfterBad = m.readUserIdentityMeta();
        return {
            supported, createdNew: created && created.created === true,
            metaPub: meta && meta.userPub, idempotent: again && again.created === false,
            codeShape: typeof code === 'string' && /^([0-9A-HJKMNP-TV-Z]{5}-){10}[0-9A-HJKMNP-TV-Z]{5}$/.test(code),
            certOk, certTampered,
            restoredOk: restored && restored.ok === true,
            pubSurvives: metaAfter && meta && metaAfter.userPub === meta.userPub,
            badRejected: bad && bad.ok === false && bad.reason === 'bad-code',
            pubIntactAfterBad: metaAfterBad && meta && metaAfterBad.userPub === meta.userPub
        };
    });
    check('Ed25519 supported in Chromium', api.supported === true);
    if (api.supported) {
        check('ensureUserIdentity mints on first call', api.createdNew === true);
        check('meta carries a userPub', typeof api.metaPub === 'string' && api.metaPub.length === 43);
        check('second ensure is a no-op load', api.idempotent === true);
        check('recovery code has the display shape', api.codeShape === true);
        check('device cert signs and verifies in-browser', api.certOk === true);
        check('tampered cert is rejected', api.certTampered === false);
        check('restore from own code succeeds (case-insensitive)', api.restoredOk === true);
        check('userPub survives the restore round-trip', api.pubSurvives === true);
        check('garbled code fails closed', api.badRejected === true);
        check('stored identity intact after a failed restore', api.pubIntactAfterBad === true);
    }

    // ── Identity panel UI (fresh profile: no identity yet) ──
    const page2 = await (await browser.newContext()).newPage();
    page2.on('pageerror', e => check('no page errors (UI page)', false, e.message));
    await page2.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
    await page2.click('#menu-toggle').catch(() => {});
    // The dialog opens via the Multiplayer menu item; drive it directly to
    // stay independent of menu markup.
    await page2.evaluate(() => document.getElementById('menu-multiplayer').click());
    await page2.waitForSelector('#connections-dialog:not([hidden])');
    await page2.evaluate(() => { document.getElementById('connections-dialog-identity').open = true; });
    await page2.waitForSelector('#connections-dialog-identity-create:not([hidden])');
    check('identity panel offers setup on a fresh profile', true);
    await page2.click('#connections-dialog-identity-create');
    await page2.waitForSelector('#connections-dialog-identity-reveal:not([hidden])');
    const ui = await page2.evaluate(() => ({
        code: document.getElementById('connections-dialog-identity-code').textContent,
        qrChildren: document.getElementById('connections-dialog-identity-qr').children.length,
        showVisible: !document.getElementById('connections-dialog-identity-show').hidden,
        createHidden: document.getElementById('connections-dialog-identity-create').hidden
    }));
    check('create reveals a recovery code', /^([0-9A-HJKMNP-TV-Z]{5}-){10}[0-9A-HJKMNP-TV-Z]{5}$/.test(ui.code), ui.code.slice(0, 12) + '…');
    check('QR renders alongside the code', ui.qrChildren > 0);
    check('panel flips to the has-identity state', ui.showVisible && ui.createHidden);
    // Closing the dialog must wipe the secret from the DOM.
    await page2.evaluate(() => document.getElementById('connections-dialog-close').click());
    const wiped = await page2.evaluate(() =>
        document.getElementById('connections-dialog-identity-code').textContent === ''
        && document.getElementById('connections-dialog-identity-qr').children.length === 0);
    check('closing the dialog wipes the revealed code', wiped === true);

    if (checks.length === 0) check('ran', false, 'no checks executed');
} finally {
    await browser.close();
    server.close();
}

let failed = 0;
for (const c of checks) {
    console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? '   (' + c.detail + ')' : ''}`);
    if (!c.ok) failed++;
}
console.log('');
if (failed) { console.log(`${failed} check(s) FAILED.`); process.exit(1); }
console.log('All user-identity acceptance checks passed.');
