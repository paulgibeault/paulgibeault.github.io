#!/usr/bin/env node
//
// tools/share-dialog-acceptance.mjs — the "Share Arcade…" menu item, end to
// end: the dialog opens from the real menu, the code always points at the
// public arcade no matter where the launcher itself is served from, a QR
// really renders from the vendored qrcodejs at a scannable size, Copy puts
// the link on the clipboard, and the panel closes by ✕, backdrop, and Escape.
//
//   node tools/share-dialog-acceptance.mjs
//
// Self-contained: serves the repo on :4809 and drives the real launcher.
// Port 4809 — clear of the other suites.
// Exit code: 0 if all checks pass, 1 otherwise.

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveRepo } from './lib/static-server.mjs';
import { createRecorder } from './lib/check-recorder.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4809;
const BASE = `http://127.0.0.1:${PORT}/`;
// The one address the code is allowed to carry — pinned here as well as in
// index.html, so changing it anywhere else is a test failure rather than a
// silent redirect of every QR already printed on a poster.
const CANONICAL = 'https://paulgibeault.github.io';

const { check, summarize } = createRecorder({ detailStyle: 'paren' });

const server = await serveRepo({ root: ROOT, port: PORT, cors: true });
const browser = await chromium.launch({ headless: true });
try {
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage();
    page.on('pageerror', (e) => check('no launcher page errors', false, e.message));

    // Serve the launcher from 127.0.0.1, at the manifest's own start_url shape
    // (index.html plus the ?v= cache-buster). Both are exactly what the shared
    // code must NOT reproduce: a loopback address nobody else can open, and a
    // query that would pin whoever scans it to today's build.
    await page.goto(BASE + 'index.html?v=9.9.9#some-hash', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__arcade && window.__arcade.openShareDialog, null, { timeout: 30000 });

    // ── 1. the menu item exists and opens the dialog ──
    await page.click('#launcher-menu-toggle');
    check('menu item is visible in the launcher menu', await page.isVisible('#menu-share'));
    await page.click('#menu-share');
    check('dialog opens', await page.isVisible('#share-dialog'));
    check('menu closes behind the dialog',
        await page.getAttribute('#launcher-menu-toggle', 'aria-expanded') === 'false');

    // ── 2. the shared link is the public arcade, whatever this page is ──
    const url = (await page.textContent('#share-dialog-url')).trim();
    check('link is the canonical public arcade', url === CANONICAL, url);
    check('link ignores the serving origin', !url.includes('127.0.0.1'), url);
    check('link drops the ?v= cache-buster', !url.includes('?'), url);
    check('link drops the fragment', !url.includes('#'), url);

    // ── 3. a QR actually renders (qrcodejs paints an <img> or a <canvas>) ──
    await page.waitForFunction(
        () => !!document.querySelector('#share-dialog-qr img, #share-dialog-qr canvas'),
        null, { timeout: 10000 }
    ).catch(() => {});
    // qrcodejs paints a canvas and keeps a hidden <img> beside it (it swaps
    // them only on old Android), so measure the one actually on screen.
    const qr = await page.evaluate(() => {
        const el = Array.from(document.querySelectorAll('#share-dialog-qr img, #share-dialog-qr canvas'))
            .find((n) => n.getBoundingClientRect().width > 0);
        return el ? { tag: el.tagName.toLowerCase(), w: el.getBoundingClientRect().width } : null;
    });
    check('QR code renders', !!qr, qr ? `${qr.tag} ${Math.round(qr.w)}px` : 'nothing painted');
    check('QR is big enough to scan across a room', !!qr && qr.w >= 280,
        qr ? `${Math.round(qr.w)}px` : 'n/a');
    check('fallback notice stays hidden when the QR rendered',
        await page.evaluate(() => document.getElementById('share-dialog-fallback').hidden));

    // ── 4. copy ──
    await page.click('#share-dialog-copy');
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    check('Copy link writes the same URL to the clipboard', clip === url, clip);
    check('status confirms the copy',
        (await page.textContent('#share-dialog-status')).includes('copied'));

    // ── 5. the loader is shared, not duplicated ──
    const scripts = await page.evaluate(() =>
        Array.from(document.querySelectorAll('script[src*="qrcode.min.js"]')).length);
    check('only one qrcodejs <script> is ever injected', scripts === 1, String(scripts));

    // ── 6. every close path ──
    await page.click('#share-dialog-close');
    check('✕ closes the dialog', await page.isHidden('#share-dialog'));
    await page.evaluate(() => window.__arcade.openShareDialog());
    await page.keyboard.press('Escape');
    check('Escape closes the dialog', await page.isHidden('#share-dialog'));
    await page.evaluate(() => window.__arcade.openShareDialog());
    await page.click('#share-dialog', { position: { x: 6, y: 6 } });
    check('backdrop click closes the dialog', await page.isHidden('#share-dialog'));
    check('closing wipes the QR out of the DOM',
        await page.evaluate(() => document.getElementById('share-dialog-qr').children.length === 0));
} finally {
    await browser.close();
    await server.close();
}
process.exit(summarize({ style: 'all-passed', label: 'share dialog' }));
