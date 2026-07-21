#!/usr/bin/env node
//
// tools/records-acceptance.mjs — proves the launcher Records sheet (#9 / #12)
// end to end in the real launcher: the "Records" menu item opens a modal tabbed
// by catalog game; each tab reads that game's arcade.v1.<id>.scores.* /
// .records.* keys straight from launcher-origin localStorage; personal records
// are formatted by their declared `format`; hostile game-written data renders
// inertly (no script execution, no innerHTML); empty tabs stay visible and
// de-emphasized; and the per-game reset wipes exactly the right keys after a
// confirm (and no-ops on cancel).
//
// Self-contained: serves the repo on :4799 with the CI fixture catalog and
// seeds localStorage before the launcher boots.
//
//   node tools/records-acceptance.mjs
//
// Exit code: 0 if all checks pass, 1 otherwise.

import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveRepo } from './lib/static-server.mjs';
import { createRecorder } from './lib/check-recorder.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4799;
const BASE = `http://127.0.0.1:${PORT}`;
const CATALOG = 'tools/fixtures/ci-catalog.json';

const server = await serveRepo({ root: ROOT, port: PORT, catalogOverride: CATALOG });
const catalog = JSON.parse(await readFile(path.join(ROOT, CATALOG), 'utf8'));
const ids = catalog.games.map((g) => g.id);
// A = first game (populated), B = second (empty), C = third (garbage).
const [A, B, C] = ids;

const { check, summarize } = createRecorder({ detailStyle: 'dash' });

const browser = await chromium.launch({ headless: true });
try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => check('no page errors', false, e.message));

    // Seed launcher-origin localStorage before any page script runs. Game A is
    // populated (a leaderboard whose 2nd entry name is an XSS payload, plus a
    // duration record and an untouchable state key); C is pure garbage.
    await page.addInitScript(({ A, C }) => {
        const set = (k, v) => localStorage.setItem(k, JSON.stringify(v));
        set(`arcade.v1.${A}.scores.high`, [
            { score: 100, name: 'Ada', ts: 1700000000000 },
            { score: 300, name: '<img src=x onerror="window.__pwned=1">', ts: 1700000100000 },
            { score: 200, name: 'Cy', ts: 1700000200000 }
        ]);
        set(`arcade.v1.${A}._scoreOrders`, { high: 'desc' });
        set(`arcade.v1.${A}.records.klondike_draw1`, { value: 102130, direction: 'lower', format: 'duration-ms', label: 'Best Time', ts: 1700000300000 });
        set(`arcade.v1.${A}.state`, { slot: 1 });                 // must survive a reset
        localStorage.setItem(`arcade.v1.${C}.scores.x`, '{not json');
        localStorage.setItem(`arcade.v1.${C}.records.bad`, JSON.stringify({ value: 'x', direction: 'higher' }));
    }, { A, C });

    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    await page.waitForSelector('.launcher-btn[data-game-id]', { timeout: 10000 });

    // ── open via the real menu item (wiring check) ──
    check('Records menu item exists', await page.$('#menu-records') !== null);
    await page.click('#launcher-menu-toggle');
    await page.click('#menu-records');
    await page.waitForSelector('#records-dialog:not([hidden])', { timeout: 5000 });

    const view = await page.evaluate(() => {
        const tabs = [...document.querySelectorAll('#records-dialog-tabs .records-tab')];
        const body = document.getElementById('records-dialog-body');
        const firstScore = (body.querySelector('.records-board__score') || {}).textContent || '';
        const recVal = (body.querySelector('.records-list__value') || {}).textContent || '';
        return {
            tabCount: tabs.length,
            tabIds: tabs.map((t) => t.dataset.gameId),
            badges: tabs.map((t) => (t.querySelector('.records-tab__badge') || {}).textContent || ''),
            emptyFlags: tabs.map((t) => t.classList.contains('records-tab--empty')),
            activeId: (document.querySelector('.records-tab--active') || {}).dataset.gameId,
            bodyImgCount: body.querySelectorAll('img').length,
            boardRows: body.querySelectorAll('.records-board__row').length,
            firstScore, recVal,
            bodyText: body.textContent
        };
    });

    check('one tab per catalog game', view.tabCount === ids.length, `${view.tabCount} vs ${ids.length}`);
    check('tabs in catalog order', JSON.stringify(view.tabIds) === JSON.stringify(ids), view.tabIds.join(','));
    check('first populated game is auto-selected', view.activeId === A, view.activeId);
    check('populated game badges its category count', view.badges[0] === '2', view.badges[0]);
    check('empty game tab is flagged --empty with no badge',
        view.emptyFlags[1] === true && view.badges[1] === '', `empty=${view.emptyFlags[1]} badge="${view.badges[1]}"`);
    check('garbage game tab is --empty (nothing valid parsed)', view.emptyFlags[2] === true, String(view.emptyFlags[2]));
    check('leaderboard shows the top entry first (desc)', view.firstScore.replace(/[,\s]/g, '') === '300', view.firstScore);
    check('leaderboard renders all valid rows', view.boardRows === 3, String(view.boardRows));
    check('duration-ms record formatted as m:ss.cc', view.recVal === '1:42.13', view.recVal);
    check('record label surfaced in body', view.bodyText.includes('Best Time'));

    // ── hostile data renders inertly ──
    const pwned = await page.evaluate(() => window.__pwned);
    check('XSS payload in a score name never executes', pwned === undefined, String(pwned));
    check('no <img> element injected from stored data', view.bodyImgCount === 0, String(view.bodyImgCount));
    check('hostile name shown as inert text', view.bodyText.includes('onerror'));

    // ── empty tab: message + Play button, reset hidden ──
    await page.click(`#records-dialog-tabs .records-tab[data-game-id="${B}"]`);
    const emptyTab = await page.evaluate(() => ({
        hasPlay: !!document.querySelector('#records-dialog-body .records-empty__play'),
        resetHidden: document.getElementById('records-dialog-reset').hidden
    }));
    check('empty tab offers a Play button', emptyTab.hasPlay);
    check('reset button hidden on an empty tab', emptyTab.resetHidden === true);

    // ── reset: cancel is a no-op, confirm wipes exactly the right keys ──
    await page.evaluate((A) => window.__arcade.records.open(), A); // reselects A (first populated)
    await page.waitForSelector('#records-dialog-reset:not([hidden])');
    await page.click('#records-dialog-reset');
    await page.waitForSelector('#arcade-dialog:not(.hidden)');
    await page.click('#arcade-dialog-cancel');
    const afterCancel = await page.evaluate((A) => localStorage.getItem(`arcade.v1.${A}.scores.high`) !== null, A);
    check('reset cancelled leaves data intact', afterCancel);

    await page.click('#records-dialog-reset');
    await page.waitForSelector('#arcade-dialog:not(.hidden)');
    await page.click('#arcade-dialog-ok');
    await page.waitForFunction((A) => localStorage.getItem(`arcade.v1.${A}.scores.high`) === null, A, { timeout: 3000 });
    const afterReset = await page.evaluate((A) => ({
        scores: localStorage.getItem(`arcade.v1.${A}.scores.high`),
        orders: localStorage.getItem(`arcade.v1.${A}._scoreOrders`),
        records: localStorage.getItem(`arcade.v1.${A}.records.klondike_draw1`),
        state: localStorage.getItem(`arcade.v1.${A}.state`),
        activeEmpty: document.querySelector('.records-tab--active').classList.contains('records-tab--empty')
    }), A);
    check('reset wiped scores / _scoreOrders / records', afterReset.scores === null && afterReset.orders === null && afterReset.records === null);
    check('reset spared the game’s state key', afterReset.state !== null);
    check('active tab flips to empty after reset', afterReset.activeEmpty === true);
} catch (e) {
    check('run completed', false, e.message);
} finally {
    await browser.close();
    server.close();
}

process.exit(summarize({ label: 'Records acceptance' }));
