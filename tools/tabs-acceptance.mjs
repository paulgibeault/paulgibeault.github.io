#!/usr/bin/env node
//
// tools/tabs-acceptance.mjs — proves the warm-pool chrome surfaces: the
// launcher grid's LIVE badges (a tile whose game is mounted in the iframe
// pool glows) and the game-view topbar tabs (browser-style: EVERY in-memory
// app is a tab — the current one highlighted and inert, every other one a
// warm switch away — no remount). Both render off arcade-pool.js's
// onPoolChanged seam, so this
// suite is also the behavior contract for that notification: mount, warm
// switch, quit, label change, and cap-shrink eviction each repaint.
//
//   node tools/tabs-acceptance.mjs
//
// Self-contained: serves the repo on :4808 with the CI fixture catalog.
// Exit code: 0 if all checks pass, 1 otherwise.

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveRepo } from './lib/static-server.mjs';
import { createRecorder } from './lib/check-recorder.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4808;
const BASE = `http://127.0.0.1:${PORT}`;

const server = await serveRepo({
    root: ROOT, port: PORT, cors: true,
    catalogOverride: 'tools/fixtures/ci-catalog.json'
});

const { check, summarize } = createRecorder({ detailStyle: 'dash' });

// ci-catalog.json order: store-test (A), bridge-test (B), p2p-test-game (C).
const A = 'store-test', B = 'bridge-test', C = 'p2p-test-game';

function liveState() {
    const tiles = [...document.querySelectorAll('#launcher-grid-container .launcher-btn[data-game-id]')];
    return {
        live: tiles.filter(t => t.classList.contains('launcher-btn--live')).map(t => t.dataset.gameId),
        badges: tiles.filter(t => t.querySelector('.launcher-btn__live-badge')).map(t => t.dataset.gameId)
    };
}
function tabState() {
    // Icon-bearing catalog entries render icon-only tabs (name lives in the
    // title/aria-label); icon-less entries fall back to a text label.
    return [...document.querySelectorAll('#game-topbar-tabs .game-tab')]
        .map(t => ({
            id: t.dataset.gameId, label: t.textContent, title: t.title,
            icon: t.querySelector('.game-tab__icon')?.getAttribute('src') ?? null,
            current: t.classList.contains('game-tab--current')
                && t.getAttribute('aria-current') === 'true'
        }));
}

const browser = await chromium.launch({ headless: true });
try {
    const page = await browser.newPage();
    page.on('pageerror', e => check('no page errors', false, e.message));
    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    await page.waitForSelector('.launcher-btn[data-game-id]', { timeout: 10000 });

    // ── Cold launcher: nothing is live ──
    let s = await page.evaluate(liveState);
    check('cold boot: no tile is marked live', s.live.length === 0 && s.badges.length === 0,
        s.live.join(','));

    // ── One game mounted: one tab — the active game, marked current ──
    await page.click(`.launcher-btn[data-game-id="${A}"]`);
    await page.waitForFunction(() => !document.getElementById('view-game').classList.contains('hidden'), null, { timeout: 10000 });
    let tabs = await page.evaluate(tabState);
    check('single warm game: its own tab shows, marked current',
        tabs.length === 1 && tabs[0].id === A && tabs[0].current,
        JSON.stringify(tabs));

    // ── Quit: the warm tile glows on the launcher ──
    await page.click('#quit-game-btn');
    await page.waitForFunction(() => document.getElementById('view-game').classList.contains('hidden'), null, { timeout: 5000 });
    s = await page.evaluate(liveState);
    check('after quit: exactly the warm game\'s tile is live (class + badge)',
        JSON.stringify(s.live) === JSON.stringify([A]) && JSON.stringify(s.badges) === JSON.stringify([A]),
        `live=${s.live} badges=${s.badges}`);

    // ── Second game: both warm games are tabs, only the active one current ──
    await page.click(`.launcher-btn[data-game-id="${B}"]`);
    await page.waitForFunction(() => !document.getElementById('view-game').classList.contains('hidden'), null, { timeout: 10000 });
    tabs = await page.evaluate(tabState);
    let tabA = tabs.find(t => t.id === A), tabB = tabs.find(t => t.id === B);
    check('two warm games: both are tabs, only the active one current',
        tabs.length === 2 && tabA && !tabA.current && tabB && tabB.current,
        JSON.stringify(tabs));
    check('icon-less game: tab falls back to the catalog name as text',
        !!tabA && tabA.label === 'Store Test' && tabA.icon === null,
        JSON.stringify(tabs));

    // ── Tab click: warm switch, no remount ──
    const framesBefore = await page.evaluate(() => document.querySelectorAll('#iframe-host iframe').length);
    await page.click(`#game-topbar-tabs .game-tab[data-game-id="${A}"]`);
    const switched = await page.waitForFunction((gid) => {
        const frames = [...document.querySelectorAll('#iframe-host iframe')];
        const visible = frames.filter(f => !f.hidden);
        return visible.length === 1 && visible[0].dataset.gameId === gid
            && location.hash === '#app=' + gid;
    }, A, { timeout: 5000 }).then(() => true).catch(() => false);
    check('tab click activates the warm frame (visibility + #app= fragment)', switched);
    const framesAfter = await page.evaluate(() => document.querySelectorAll('#iframe-host iframe').length);
    check('warm switch mounts nothing new', framesBefore === 2 && framesAfter === 2,
        `before=${framesBefore} after=${framesAfter}`);
    const title = await page.evaluate(() => document.getElementById('game-topbar-title').textContent);
    check('topbar title follows the switch', title === 'Store Test', String(title));
    tabs = await page.evaluate(tabState);
    tabA = tabs.find(t => t.id === A); tabB = tabs.find(t => t.id === B);
    check('tabs flip: current moves to the incoming game',
        tabs.length === 2 && tabA && tabA.current && tabB && !tabB.current,
        JSON.stringify(tabs));
    check('icon-bearing game: tab shows the catalog icon, name stays in title',
        !!tabB && tabB.icon === '/images/icon-192.png'
        && tabB.label === '' && tabB.title === 'Switch to Bridge Test',
        JSON.stringify(tabs));

    // ── Current tab is inert: clicking it changes nothing ──
    await page.click(`#game-topbar-tabs .game-tab[data-game-id="${A}"]`);
    const stillA = await page.evaluate((gid) => {
        const visible = [...document.querySelectorAll('#iframe-host iframe')].filter(f => !f.hidden);
        return visible.length === 1 && visible[0].dataset.gameId === gid
            && document.querySelectorAll('#iframe-host iframe').length === 2;
    }, A);
    check('clicking the current tab is a no-op', stillA);

    // ── App-set titles reach tab labels (pool.setGameTitle → onPoolChanged).
    //    B's tab is icon-only, so its label surfaces via title/aria-label. ──
    await page.evaluate((gid) => window.__arcade.pool.setGameTitle(gid, 'Draft 7'), B);
    tabs = await page.evaluate(tabState);
    tabB = tabs.find(t => t.id === B);
    check('a suspended game\'s custom title becomes its tab label',
        !!tabB && tabB.title === 'Switch to Draft 7', JSON.stringify(tabs));
    await page.evaluate((gid) => window.__arcade.pool.setGameTitle(gid, ''), B);
    tabs = await page.evaluate(tabState);
    tabB = tabs.find(t => t.id === B);
    check('clearing the custom title restores the catalog name',
        !!tabB && tabB.title === 'Switch to Bridge Test', JSON.stringify(tabs));

    // ── Quit with two warm games: both tiles live, the third is not ──
    await page.click('#quit-game-btn');
    await page.waitForFunction(() => document.getElementById('view-game').classList.contains('hidden'), null, { timeout: 5000 });
    s = await page.evaluate(liveState);
    check('two warm games: both tiles live, cold tile unmarked',
        s.live.length === 2 && s.live.includes(A) && s.live.includes(B) && !s.live.includes(C),
        `live=${s.live}`);

    // ── Cap shrink evicts: badges follow the pool, not history ──
    await page.evaluate(() => {
        const input = document.getElementById('menu-pool-cap-input');
        input.value = '1';
        input.dispatchEvent(new Event('change'));
    });
    const shrunk = await page.waitForFunction(() =>
        document.querySelectorAll('#launcher-grid-container .launcher-btn--live').length === 1,
        null, { timeout: 5000 }).then(() => true).catch(() => false);
    check('shrinking Open games to 1 un-lights the evicted tile', shrunk);

    // ── Back in game mode with a pool of one: just the current tab ──
    s = await page.evaluate(liveState);
    const survivor = s.live[0];
    await page.click(`.launcher-btn[data-game-id="${survivor}"]`);
    await page.waitForFunction(() => !document.getElementById('view-game').classList.contains('hidden'), null, { timeout: 10000 });
    tabs = await page.evaluate(tabState);
    check('cap=1: only the current game\'s tab shows',
        tabs.length === 1 && tabs[0].id === survivor && tabs[0].current,
        JSON.stringify(tabs));
    await page.close();
} catch (e) {
    check('run completed', false, e.message);
} finally {
    await browser.close();
    server.close();
}

process.exit(summarize({ label: 'tabs acceptance' }));
