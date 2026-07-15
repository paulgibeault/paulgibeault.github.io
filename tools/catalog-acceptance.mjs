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
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4798;
const BASE = `http://127.0.0.1:${PORT}`;
const CATALOG_OVERRIDE = process.env.CATALOG_OVERRIDE || null;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png' };
const server = http.createServer(async (req, res) => {
    try {
        let p = decodeURIComponent(req.url.split('?')[0]);
        if (p.endsWith('/')) p += 'index.html';
        let file = path.join(ROOT, p);
        if (p === '/catalog.json' && CATALOG_OVERRIDE) file = path.resolve(ROOT, CATALOG_OVERRIDE);
        if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
        const body = await readFile(file);
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(body);
    } catch { res.writeHead(404).end('not found'); }
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));

const expected = JSON.parse(await readFile(
    CATALOG_OVERRIDE ? path.resolve(ROOT, CATALOG_OVERRIDE) : path.join(ROOT, 'catalog.json'), 'utf8'));
const expectedGames = expected.games;
const N = expectedGames.length;

const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok, detail: detail || '' }); };

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
    await page.close();

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
                hasPlay: rendered.every(c => !!c.querySelector('.btn--play')),
                hardcoded: ['card-qrcodep2p', 'card-zibaldone', 'card-usai'].map(id => !!document.getElementById(id))
            };
        });
        check(`profile: renders the ${profileGames.length} catalog games with profile blocks`,
            JSON.stringify(cards.ids) === JSON.stringify(profileGames.map(g => 'card-' + g.id)), cards.ids.join(','));
        check('profile: spotlight preserved on the first card', cards.spotlightFirst === !!profileGames[0].spotlight);
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

let failed = 0;
for (const c of checks) {
    console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.detail && !c.ok ? ` — ${c.detail}` : ''}`);
    if (!c.ok) failed++;
}
console.log(failed === 0 ? '\nAll catalog acceptance checks passed.' : `\n${failed} check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
