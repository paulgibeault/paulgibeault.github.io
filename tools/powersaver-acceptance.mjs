// powersaver-acceptance.mjs — the powerSaver setting, end to end.
//
// Drives the real launcher menu toggle, then boots the SDK standalone on the
// same origin to prove the setting round-trips into the game-facing surface:
// data-power-saver, Arcade.settings.powerSaver(), and the --arcade-pulse-count
// ladder (3 → 1 under power saver → 0 under reduced motion) from the SDK's
// injected base style. Port 4783 — clear of the other suites' 4784-4799.
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveRepo } from './lib/static-server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4783;
const BASE = `http://127.0.0.1:${PORT}/`;
let failures = 0;
const ok = (cond, label) => { console.log(`  ${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };

const server = await serveRepo({ root: ROOT, port: PORT, cors: true });
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(500);

// -- launcher toggle --
await page.click('#launcher-menu-toggle');
await page.click('#menu-power-saver');
ok(await page.getAttribute('html', 'data-power-saver') === 'true', 'launcher html gets data-power-saver=true');
ok(await page.evaluate(() => localStorage.getItem('arcade.v1.global.powerSaver')) === 'true', 'arcade.v1.global.powerSaver persisted as true');
ok(await page.textContent('#menu-power-saver-label') === 'Power Saver On', 'menu label flips to On');
ok(await page.getAttribute('#menu-power-saver', 'aria-pressed') === 'true', 'aria-pressed true');
ok(await page.evaluate(() => getComputedStyle(document.getElementById('starfield')).display) === 'none', 'starfield display:none under power saver');

// -- SDK standalone on the same origin: hydrates the setting pre-welcome --
await page.evaluate(() => new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = '/arcade-sdk.js'; s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
}));
await page.evaluate(() => window.Arcade.init({ gameId: 'ps-smoke' }));
ok(await page.evaluate(() => window.Arcade.settings.powerSaver()) === true, 'Arcade.settings.powerSaver() reads true from storage');
ok(await page.evaluate(() => 'powerSaver' in window.Arcade.settings.snapshot()), 'snapshot() carries powerSaver');
const pulse = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--arcade-pulse-count').trim());
ok(pulse === '1', `--arcade-pulse-count is 1 under power saver (got '${pulse}')`);

// -- ladder: reduced motion wins with 0 --
await page.evaluate(() => document.documentElement.setAttribute('data-reduced-motion', 'true'));
const pulseRM = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--arcade-pulse-count').trim());
ok(pulseRM === '0', `--arcade-pulse-count is 0 under reduced motion (got '${pulseRM}')`);
await page.evaluate(() => document.documentElement.setAttribute('data-reduced-motion', 'false'));

// -- toggle off restores everything --
await page.evaluate(() => document.getElementById('menu-power-saver').click());
ok(await page.getAttribute('html', 'data-power-saver') === 'false', 'toggle off: data-power-saver=false');
const pulseOff = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--arcade-pulse-count').trim());
ok(pulseOff === '3', `--arcade-pulse-count back to 3 (got '${pulseOff}')`);
ok(await page.evaluate(() => getComputedStyle(document.getElementById('starfield')).display) !== 'none', 'starfield visible again');

await browser.close();
if (server && server.close) server.close();
console.log(failures === 0 ? '\n✓ all power-saver acceptance checks passed' : `\n✗ ${failures} failures`);
process.exit(failures === 0 ? 0 : 1);
