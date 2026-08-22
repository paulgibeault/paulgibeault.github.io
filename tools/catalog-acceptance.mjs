#!/usr/bin/env node
//
// tools/catalog-acceptance.mjs — proves the data-driven catalog (issue #34):
// the launcher grid and the profile page's game cards both render from
// catalog.json, the delegated click wiring launches a game, and the pool-cap
// control re-clamps to the rendered game count. Self-contained: serves the
// repo on :4798.
//
//   node tools/catalog-acceptance.mjs
//
// The server honors a CATALOG_OVERRIDE env var (path to an alternate catalog
// served at /catalog.json) so CI fixture catalogs can reuse this suite.
//
// Exit code: 0 if all checks pass, 1 otherwise.

import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveRepo } from './lib/static-server.mjs';
import { createRecorder } from './lib/check-recorder.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4798;
const BASE = `http://127.0.0.1:${PORT}`;
const CATALOG_OVERRIDE = process.env.CATALOG_OVERRIDE || null;

const server = await serveRepo({ root: ROOT, port: PORT, catalogOverride: CATALOG_OVERRIDE });

const expected = JSON.parse(await readFile(
    CATALOG_OVERRIDE ? path.resolve(ROOT, CATALOG_OVERRIDE) : path.join(ROOT, 'catalog.json'), 'utf8'));
const expectedGames = expected.games;
const N = expectedGames.length;

const { check, summarize } = createRecorder({ detailStyle: 'dash' });

const browser = await chromium.launch({ headless: true });
try {
    // ── Launcher grid ──
    const page = await browser.newPage();
    page.on('pageerror', e => check('launcher: no page errors', false, e.message));
    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    await page.waitForSelector('.launcher-btn[data-game-id]', { timeout: 10000 });

    const grid = await page.evaluate(() => {
        const btns = [...document.querySelectorAll('#launcher-grid-container .launcher-btn[data-game-id]')];
        return {
            ids: btns.map(b => b.dataset.gameId),
            hrefs: btns.map(b => b.href),
            names: btns.map(b => (b.querySelector('.launcher-btn__name') || {}).textContent || ''),
            spotlightFirst: btns.length > 0 && btns[0].classList.contains('spotlight-card'),
            spotlightCount: btns.filter(b => b.classList.contains('spotlight-card')).length,
            delays: btns.map(b => b.style.animationDelay),
            inDevIds: btns.filter(b => b.querySelector('.launcher-btn__image-wrap.in-dev-wrap .in-dev-banner'))
                .map(b => b.dataset.gameId),
            poolMax: (document.getElementById('menu-pool-cap-input') || {}).max
        };
    });
    check(`launcher: grid renders all ${N} catalog games in order`,
        JSON.stringify(grid.ids) === JSON.stringify(expectedGames.map(g => g.id)), grid.ids.join(','));
    check('launcher: hrefs resolve against this origin',
        grid.hrefs.every((h, i) => h === new URL(expectedGames[i].url, BASE).href),
        grid.hrefs[0]);
    check('launcher: names come from the catalog',
        grid.names.every((n, i) => n.trim() === expectedGames[i].name));
    check('launcher: spotlight-card on the flagged entry only',
        grid.spotlightFirst === !!expectedGames[0].spotlight
        && grid.spotlightCount === expectedGames.filter(g => g.spotlight).length,
        `first=${grid.spotlightFirst} count=${grid.spotlightCount}`);
    check('launcher: in-development banner on the flagged entries only',
        JSON.stringify(grid.inDevIds) === JSON.stringify(expectedGames.filter(g => g.inDevelopment).map(g => g.id)),
        grid.inDevIds.join(',') || '(none)');
    // Note: the CSSOM normalizes '0.0s' to '0s' on read-back.
    check('launcher: entrance stagger preserved (inline animation-delay)',
        parseFloat(grid.delays[0]) === 0 && (N < 2 || parseFloat(grid.delays[1]) === 0.1), grid.delays.slice(0, 2).join(','));
    check(`launcher: pool-cap input re-clamped to game count`, grid.poolMax === String(N), `max=${grid.poolMax}`);

    // Delegated click launches the game (view flips, iframe mounts with the
    // catalog URL — the game itself 404s on this bare server, which is fine:
    // mounting is the launcher's job under test here).
    await page.click(`.launcher-btn[data-game-id="${expectedGames[0].id}"]`);
    const launched = await page.waitForFunction((gid) => {
        const view = document.getElementById('view-game');
        const frame = document.querySelector(`#iframe-host iframe[title]`);
        return !!(view && !view.classList.contains('hidden') && frame && frame.src.includes(gid))
    }, expectedGames[0].id, { timeout: 10000 }).then(() => true).catch(() => false);
    check('launcher: delegated click mounts the game view + iframe', launched);

    // ── Deep links (#36) ──
    const hashAfterLaunch = await page.evaluate(() => location.hash);
    check('deep links: launch reflects #app=<id> into the URL',
        hashAfterLaunch === `#app=${expectedGames[0].id}`, hashAfterLaunch);
    await page.click('#quit-game-btn');
    const afterQuit = await page.waitForFunction(() =>
        document.getElementById('view-game').classList.contains('hidden') && location.hash === '',
        null, { timeout: 5000 }).then(() => true).catch(() => false);
    check('deep links: quit clears the fragment and returns to the launcher', afterQuit);
    await page.close();

    // ── MRU sort order (arcade-recents.js) ──
    // The grid is catalog-ordered until something has been played; after that
    // the launcher leads with the most recently used game and keeps catalog
    // order for the rest. Re-sorting happens on the way OUT of a game, so the
    // check is: launch the LAST catalog entry, quit, and watch it lead.
    if (N >= 2) {
        const mru = await browser.newPage();
        mru.on('pageerror', e => check('mru: no page errors', false, e.message));
        await mru.goto(`${BASE}/`, { waitUntil: 'load' });
        await mru.waitForSelector('.launcher-btn[data-game-id]', { timeout: 10000 });
        const readIds = () => mru.evaluate(() =>
            [...document.querySelectorAll('#launcher-grid-container .launcher-btn[data-game-id]')]
                .map(b => b.dataset.gameId));
        check('mru: a device with no history renders plain catalog order',
            JSON.stringify(await readIds()) === JSON.stringify(expectedGames.map(g => g.id)));

        const last = expectedGames[N - 1];
        await mru.click(`.launcher-btn[data-game-id="${last.id}"]`);
        await mru.waitForFunction(() =>
            !document.getElementById('view-game').classList.contains('hidden'),
            null, { timeout: 10000 });
        const orderDuringGame = await readIds();
        check('mru: the grid does NOT reorder while the game is open',
            JSON.stringify(orderDuringGame) === JSON.stringify(expectedGames.map(g => g.id)));

        await mru.click('#quit-game-btn');
        const promoted = await mru.waitForFunction((gid) => {
            const btns = [...document.querySelectorAll('#launcher-grid-container .launcher-btn[data-game-id]')];
            return btns.length > 0 && btns[0].dataset.gameId === gid;
        }, last.id, { timeout: 5000 }).then(() => true).catch(() => false);
        check('mru: the game just quit leads the grid', promoted);
        const expectedOrder = [last.id, ...expectedGames.slice(0, N - 1).map(g => g.id)];
        check('mru: the never-played games keep catalog order behind it',
            JSON.stringify(await readIds()) === JSON.stringify(expectedOrder),
            (await readIds()).join(','));
        check('mru: the re-sorted tile keeps its LIVE badge (frame still warm)',
            await mru.evaluate((gid) => {
                const tile = document.querySelector(`.launcher-btn[data-game-id="${gid}"]`);
                return !!(tile && tile.classList.contains('launcher-btn--live')
                    && tile.querySelector('.launcher-btn__live-badge'));
            }, last.id));
        check('mru: stack persisted under the launcher-private _meta key',
            await mru.evaluate((gid) =>
                localStorage.getItem('arcade.v1._meta.recentGames') === JSON.stringify([gid])
                && localStorage.getItem('arcade.v1.global.recentGames') === null, last.id));

        await mru.reload({ waitUntil: 'load' });
        await mru.waitForSelector('.launcher-btn[data-game-id]', { timeout: 10000 });
        check('mru: the order survives a reload',
            JSON.stringify(await readIds()) === JSON.stringify(expectedOrder),
            (await readIds()).join(','));
        await mru.close();
    }

    // Fresh navigation with a fragment boots straight into the game.
    const deep = await browser.newPage();
    deep.on('pageerror', e => check('deep links: no page errors', false, e.message));
    const target = expectedGames[Math.min(1, N - 1)];
    await deep.goto(`${BASE}/#app=${target.id}`, { waitUntil: 'load' });
    const deepOpened = await deep.waitForFunction((gid) => {
        const view = document.getElementById('view-game');
        const frame = document.querySelector('#iframe-host iframe[title]');
        return !!(view && !view.classList.contains('hidden') && frame && frame.src.includes(gid));
    }, target.id, { timeout: 10000 }).then(() => true).catch(() => false);
    check(`deep links: /#app=${target.id} opens the game directly`, deepOpened);
    await deep.close();

    // Unknown id: launcher stays up, toast shows, fragment cleared, no errors.
    const bogus = await browser.newPage();
    bogus.on('pageerror', e => check('deep links: unknown id — no page errors', false, e.message));
    await bogus.goto(`${BASE}/#app=not-a-game`, { waitUntil: 'load' });
    const graceful = await bogus.waitForFunction(() =>
        location.hash === ''
        && !document.getElementById('view-game') || document.getElementById('view-game').classList.contains('hidden'),
        null, { timeout: 10000 }).then(() => true).catch(() => false);
    const toastShown = await bogus.waitForFunction(() =>
        (document.getElementById('launcher-toast') || {}).textContent.includes('doesn’t match'),
        null, { timeout: 5000 }).then(() => true).catch(() => false);
    check('deep links: unknown id stays on the launcher with the fragment cleared', graceful);
    check('deep links: unknown id shows a toast', toastShown);
    await bogus.close();

    // ── Profile page (skip under an override catalog whose games carry no profile blocks) ──
    const profileGames = expectedGames.filter(g => g.profile);
    if (profileGames.length) {
        const prof = await browser.newPage();
        prof.on('pageerror', e => check('profile: no page errors', false, e.message));
        await prof.goto(`${BASE}/profile.html`, { waitUntil: 'load' });
        await prof.waitForSelector('#games .card-grid .project-card', { timeout: 10000 });

        const cards = await prof.evaluate(() => {
            const rendered = [...document.querySelectorAll('#games .card-grid .project-card')];
            return {
                ids: rendered.map(c => c.id),
                spotlightFirst: rendered.length > 0 && rendered[0].classList.contains('spotlight-card'),
                hasBody: rendered.every(c => !!c.querySelector('.project-card__body')),
                inDevIds: rendered.filter(c => c.querySelector('.project-card__image-wrap.in-dev-wrap .in-dev-banner'))
                    .map(c => c.id),
                hasPlay: rendered.every(c => !!c.querySelector('.btn--play')),
                hardcoded: ['card-qrcodep2p', 'card-zibaldone', 'card-usai'].map(id => !!document.getElementById(id))
            };
        });
        check(`profile: renders the ${profileGames.length} catalog games with profile blocks`,
            JSON.stringify(cards.ids) === JSON.stringify(profileGames.map(g => 'card-' + g.id)), cards.ids.join(','));
        check('profile: spotlight preserved on the first card', cards.spotlightFirst === !!profileGames[0].spotlight);
        check('profile: in-development banner on the flagged cards only',
            JSON.stringify(cards.inDevIds) === JSON.stringify(profileGames.filter(g => g.inDevelopment).map(g => 'card-' + g.id)),
            cards.inDevIds.join(',') || '(none)');
        check('profile: every card has a __body wrapper (zoom modal clones it)', cards.hasBody);
        check('profile: every card has a Play action', cards.hasPlay);
        check('profile: hardcoded non-arcade project cards intact', cards.hardcoded.every(Boolean), cards.hardcoded.join(','));

        // Scroll-reveal must reach catalog-rendered cards (the re-observe on
        // arcade:catalog-rendered) — scroll the grid into view and wait for
        // the first card to gain .visible.
        await prof.evaluate(() => document.querySelector('#games .card-grid .project-card').scrollIntoView());
        const revealed = await prof.waitForFunction(() =>
            document.querySelector('#games .card-grid .project-card').classList.contains('visible'),
            null, { timeout: 10000 }).then(() => true).catch(() => false);
        check('profile: scroll-reveal reaches rendered cards', revealed);

        // Zoom-modal delegation covers rendered cards: click a card (not a
        // button) → overlay activates.
        await prof.evaluate(() => document.querySelector('#games .card-grid .project-card .project-card__name').click());
        const zoomed = await prof.waitForFunction(() =>
            document.getElementById('zoom-overlay').classList.contains('active'),
            null, { timeout: 5000 }).then(() => true).catch(() => false);
        check('profile: zoom modal opens from a rendered card (delegation)', zoomed);
        await prof.close();
    }
} catch (e) {
    check('run completed', false, e.message);
} finally {
    await browser.close();
    server.close();
}

process.exit(summarize({ label: 'catalog acceptance' }));
