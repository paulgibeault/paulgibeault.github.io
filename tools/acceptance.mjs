#!/usr/bin/env node
//
// tools/acceptance.mjs — Run the GAME_INTEGRATION §13 acceptance checklist
// against a running staged launcher.
//
//   node tools/acceptance.mjs http://127.0.0.1:4791/si-syn/
//   node tools/acceptance.mjs --pool http://127.0.0.1:4791/
//   node tools/acceptance.mjs --pool --serve --catalog tools/fixtures/ci-catalog.json
//
// Per-game mode (default): GAME_INTEGRATION §13 checks against the given game.
// --pool mode: launcher-only test of the bounded LRU iframe pool (issue #7).
//   Requires at least 3 games in the served catalog (e.g. `./dev.sh ../si-syn
//   ../hecknsic ../pi-game`, or --serve with the committed CI fixture catalog).
//
// Without --serve, assumes the URL is already reachable — typically by running
// `./dev.sh ../<game-repo> [...]` in another shell, with the launcher at
// <origin>/ and (for per-game mode) the game at <origin>/<gameId>/.
//
// --serve: spin up a hermetic static server over the repo root (no dev.sh
//   needed). --port <n> picks the port (default 4799). --catalog <path>
//   serves that file at /catalog.json, so the launcher grid renders committed
//   fixture games — this is how CI runs --pool on a bare checkout.
//
// Setup (once):
//   npm install
//   npx playwright install chromium
//
// Exit code: 0 if all checks pass, 1 otherwise.

import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
let poolMode = false, serve = false, port = 4799, catalogOverride = null;
const mounts = {}; // gameId -> repo-relative dir, so --serve can host a fixture game at /<gameId>/
const positional = [];
for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--pool') poolMode = true;
    else if (argv[i] === '--serve') serve = true;
    else if (argv[i] === '--port') port = parseInt(argv[++i], 10);
    else if (argv[i] === '--catalog') catalogOverride = argv[++i];
    else if (argv[i] === '--mount') { const [id, rel] = String(argv[++i]).split('='); mounts[id] = rel; }
    else positional.push(argv[i]);
}
const url = positional[0] || (serve ? `http://127.0.0.1:${port}/` : null);
if (!url) {
    console.error('usage: node tools/acceptance.mjs <game-url>');
    console.error('       node tools/acceptance.mjs --pool <launcher-url>');
    console.error('       node tools/acceptance.mjs --pool --serve [--port <n>] [--catalog <path>]');
    process.exit(2);
}

let server = null;
if (serve) {
    const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png' };
    server = http.createServer(async (req, res) => {
        try {
            let p = decodeURIComponent(req.url.split('?')[0]);
            if (p.endsWith('/')) p += 'index.html';
            // A --mount maps /<gameId>/* onto a repo-relative fixture dir, so a
            // template game can be tested per-game under --serve without living
            // at the repo root (segments[0] must be the gameId for the runner).
            const seg = p.split('/').filter(Boolean);
            let file = (seg.length && mounts[seg[0]])
                ? path.resolve(ROOT, mounts[seg[0]], ...seg.slice(1))
                : path.join(ROOT, p);
            if (p === '/catalog.json' && catalogOverride) file = path.resolve(ROOT, catalogOverride);
            if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
            const body = await readFile(file);
            res.writeHead(200, {
                'content-type': MIME[path.extname(file)] || 'application/octet-stream',
                // Opaque-origin game frames load their ES modules as CORS
                // requests (Origin: null) — mirror dev.sh and GitHub Pages so
                // module scripts aren't blocked inside a framed game.
                'access-control-allow-origin': '*',
            });
            res.end(body);
        } catch { res.writeHead(404).end('not found'); }
    });
    await new Promise((r) => server.listen(port, '127.0.0.1', r));
}

let parsed;
try { parsed = new URL(url); } catch { console.error('invalid URL:', url); process.exit(2); }
const origin = parsed.origin;
const segments = parsed.pathname.split('/').filter(Boolean);
const gameId = poolMode ? null : segments[0];
if (!poolMode && !gameId) {
    console.error('URL must include a game path, e.g. /si-syn/');
    process.exit(2);
}
const gameUrl = gameId ? `${origin}/${gameId}/` : null;
const launcherUrl = `${origin}/`;

const checks = [];
const record = (n, name, ok, detail) => checks.push({ n, name, ok, detail: detail || '' });

const browser = await chromium.launch({ headless: true });

// Game frames are sandboxed WITHOUT allow-same-origin (opaque origin), so
// page-context probes into f.contentWindow.* throw SecurityError. Playwright
// frame handles evaluate INSIDE the frame via CDP regardless of origin — poll
// for the frame by URL prefix (skipping the main frame: #app= deep links put
// the gameId into the launcher URL too).
async function frameFor(page, urlPrefix, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const f = page.frames().find((fr) => fr !== page.mainFrame() && fr.url().startsWith(urlPrefix));
        if (f) return f;
        await new Promise((r) => setTimeout(r, 100));
    }
    return null;
}

try {
    if (poolMode) {
        await runPoolMode();
    } else {
        await runPerGame();
    }
} finally {
    await browser.close();
}

await printAndExit();

async function runPerGame() {
    // ─── Standalone phase ────────────────────────────────────────────
    {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        const errors = [];
        const swWarnings = [];
        page.on('pageerror', (err) => errors.push(err.message));
        page.on('console', (m) => {
            if (m.type() === 'error') errors.push(m.text());
            const t = m.text();
            if (t.includes('[Arcade SDK]') && t.includes('service worker')) swWarnings.push(t);
        });

        try {
            await page.goto(gameUrl, { waitUntil: 'load', timeout: 10_000 });
        } catch (e) {
            record(1, 'loads standalone with no console errors', false, `goto failed: ${e.message}`);
            await ctx.close();
            // Without standalone load, framed phase isn't useful either.
            await printAndExit();
        }
        // Let deferred init / late console output settle.
        await page.waitForTimeout(500);

        record(1, 'loads standalone with no console errors',
            errors.length === 0,
            errors.length ? errors.slice(0, 2).join(' | ') : '');

        record(8, 'standalone URL works (Arcade global, framed=false)',
            await page.evaluate(() =>
                typeof window.Arcade === 'object' &&
                window.Arcade?.context?.framed === false
            ),
            '');

        record(9, 'no SW interception of /arcade-sdk.js',
            swWarnings.length === 0,
            swWarnings[0] || '');

        await ctx.close();
    }

    // ─── Framed phase ────────────────────────────────────────────────
    {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        const errors = [];
        page.on('pageerror', (err) => errors.push(err.message));
        page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

        await page.goto(launcherUrl, { waitUntil: 'load', timeout: 10_000 });
        // The grid is fetch-rendered from catalog.json — wait for it.
        await page.waitForSelector('.launcher-btn[data-game-id]', { timeout: 10_000 }).catch(() => {});

        const btnSel = `.launcher-btn[data-game-id="${gameId}"]`;
        if (!(await page.$(btnSel))) {
            record(2, 'framed=true after launching from launcher', false,
                `launcher has no ${btnSel}`);
            await ctx.close();
            await printAndExit();
        }

        await page.click(btnSel);

        // Wait for the frame and the SDK inside it (frame handle — the frame
        // is opaque-origin, so contentWindow probes from the page throw).
        const gameFrame = await frameFor(page, gameUrl);
        const ready = gameFrame && await gameFrame
            .waitForFunction(() => !!(window.Arcade && window.Arcade.context), null, { timeout: 10_000 })
            .then(() => true).catch(() => false);

        if (!ready || !gameFrame) {
            record(2, 'framed=true after launching from launcher', false,
                'iframe never produced window.Arcade');
            await ctx.close();
            await printAndExit();
        }

        // Let the welcome handshake settle.
        await page.waitForTimeout(400);

        // 2 — framed flag
        record(2, 'Arcade.context.framed === true when launched from launcher',
            await gameFrame.evaluate(() => window.Arcade?.context?.framed === true),
            '');

        // Install lifecycle probes inside the frame BEFORE we drive quit/relaunch.
        await gameFrame.evaluate(() => {
            window.__suspendCount = 0;
            window.__resumeCount = 0;
            window.Arcade?.onSuspend?.(() => window.__suspendCount++);
            window.Arcade?.onResume?.(() => window.__resumeCount++);
        });

        // 3 — at least one arcade.v1.<gameId>.* key. Give the game time to write.
        await page.waitForTimeout(800);
        const allKeys = await page.evaluate(() => {
            const out = [];
            for (let i = 0; i < localStorage.length; i++) out.push(localStorage.key(i));
            return out;
        });
        const gameKeys = allKeys.filter((k) => k && k.startsWith(`arcade.v1.${gameId}.`));
        record(3, `writes at least one arcade.v1.${gameId}.* key`,
            gameKeys.length > 0,
            gameKeys.length ? '' : `keys: ${allKeys.slice(0, 6).join(', ')}`);

        // 4 — no legacy non-namespaced keys
        // Allowlist: launcher's pre-migration fontScale fallback.
        const ALLOW = new Set(['fontScale']);
        const stragglers = allKeys.filter(
            (k) => k && !k.startsWith('arcade.v1.') && !ALLOW.has(k)
        );
        record(4, 'no legacy non-namespaced keys remain',
            stragglers.length === 0,
            stragglers.length ? `stragglers: ${stragglers.join(', ')}` : '');

        // 5 — launcher save → exported JSON contains game keys.
        // #btn-save lives inside a collapsed menu; click via evaluate so we
        // don't depend on Playwright's actionability checks for a button that
        // becomes visible only after the user opens the menu.
        const dlPromise = page.waitForEvent('download', { timeout: 5_000 }).catch(() => null);
        await page.evaluate(() => document.getElementById('btn-save')?.click());
        const dl = await dlPromise;
        if (!dl) {
            record(5, 'launcher save → exported JSON contains game keys', false,
                'save did not produce a download');
        } else {
            const path = await dl.path();
            let bundle;
            try { bundle = JSON.parse(await readFile(path, 'utf8')); } catch { bundle = null; }
            const ok = !!bundle?.data &&
                Object.keys(bundle.data).some((k) => k.startsWith(`arcade.v1.${gameId}.`));
            record(5, 'launcher save → exported JSON contains game keys', ok,
                ok ? '' : 'no matching keys in exported file');
        }

        // 6 — font-scale propagates without reload. Game frames are opaque-origin
        // (since #50), so a launcher-doc storage event never reaches them — the
        // launcher pushes settings over the bridge instead. Drive that exactly
        // as the launcher's own font control does: write the key, then
        // broadcastSettings(). The SDK applies the change to --font-scale.
        const beforeScale = (await gameFrame.evaluate(() =>
            getComputedStyle(document.documentElement).getPropertyValue('--font-scale').trim()
        )) || '1';
        const targetScale = '1.4';
        await page.evaluate((v) => {
            localStorage.setItem('arcade.v1.global.fontScale', JSON.stringify(parseFloat(v)));
            window.__arcade?.broadcastSettings?.();
        }, targetScale);
        await page.waitForTimeout(400);
        const afterScale = (await gameFrame.evaluate(() =>
            getComputedStyle(document.documentElement).getPropertyValue('--font-scale').trim()
        )) || '';
        record(6, 'font-scale propagates without reload',
            !!afterScale && Math.abs(parseFloat(afterScale) - parseFloat(targetScale)) < 0.01,
            `before=${beforeScale} after=${afterScale} target=${targetScale}`);

        // 7 — onSuspend / onResume on quit + relaunch
        await page.click('#quit-game-btn').catch(() => {});
        await page.waitForTimeout(250);
        await page.click(btnSel).catch(() => {});
        await page.waitForTimeout(250);
        const sCount = await gameFrame.evaluate(() => window.__suspendCount).catch(() => 0);
        const rCount = await gameFrame.evaluate(() => window.__resumeCount).catch(() => 0);
        record(7, 'onSuspend / onResume fire on quit + relaunch',
            sCount > 0 && rCount > 0,
            `suspend=${sCount} resume=${rCount}`);

        await ctx.close();
    }

    // ─── Offline phase (game's own SW, if it registers one) ─────────
    // GAME_INTEGRATION §10: a game that ships a service worker must cache its
    // own assets so an offline reload still boots. Games without a SW (or
    // that skip SW registration on loopback, like the launcher does) are
    // recorded as skipped, not failed.
    {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        try {
            await page.goto(gameUrl, { waitUntil: 'load', timeout: 10_000 });
            // Give install/activate + precache time to settle.
            await page.waitForTimeout(1500);
            const regCount = await page.evaluate(async () => {
                if (!('serviceWorker' in navigator)) return 0;
                const regs = await navigator.serviceWorker.getRegistrations();
                return regs.length;
            });
            if (regCount === 0) {
                record(10, 'offline reload via game SW', true, 'no SW registered — skipped');
            } else {
                await ctx.setOffline(true);
                let ok = false, detail = '';
                try {
                    await page.reload({ waitUntil: 'load', timeout: 10_000 });
                    ok = await page.evaluate(() =>
                        !!(document.body && document.body.children.length > 0));
                    detail = ok ? '' : 'offline page loaded but rendered nothing';
                } catch (e) {
                    detail = `offline reload failed: ${e.message.split('\n')[0]}`;
                }
                record(10, 'offline reload via game SW serves cached assets', ok, detail);
                await ctx.setOffline(false);
            }
        } catch (e) {
            record(10, 'offline reload via game SW', false, `setup failed: ${e.message}`);
        }
        await ctx.close();
    }
}

// ─── Pool-mode (issue #7): bounded LRU iframe pool ───────────────────
async function runPoolMode() {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    try {
        await page.goto(launcherUrl, { waitUntil: 'load', timeout: 10_000 });
        // The grid is fetch-rendered from catalog.json — wait for it.
        await page.waitForSelector('.launcher-btn[data-game-id]', { timeout: 10_000 });
    } catch (e) {
        record(1, 'launcher loads', false, `goto failed: ${e.message}`);
        await ctx.close();
        return;
    }

    // Set cap=2 explicitly so the test is deterministic regardless of any
    // user setting bleed-through.
    await page.evaluate(() => {
        localStorage.setItem('arcade.v1.global.poolCap', JSON.stringify(2));
    });

    const games = await page.$$eval('.launcher-btn[data-game-id]', (nodes) =>
        nodes.map((n) => ({
            gameId: n.dataset.gameId,
            href: n.getAttribute('href'),
        }))
    );

    if (games.length < 3) {
        record(1, 'launcher has at least 3 games staged', false,
            `found ${games.length}; pool eviction needs ≥3 — re-run ./dev.sh with more repos`);
        await ctx.close();
        return;
    }
    record(1, 'launcher has at least 3 games staged', true, `${games.length} games`);

    const [a, b, c] = games;

    async function poolSnapshot() {
        // Evicted frames stay in the DOM for RETIRE_GRACE_MS (250 ms, #41's
        // suspend-flush window) before teardown — settle past the grace so the
        // snapshot reflects the pool, not frames mid-retirement.
        await page.waitForTimeout(400);
        return page.evaluate(() => {
            const ids = [...document.querySelectorAll('#iframe-host iframe')]
                .map((f) => f.dataset.gameId);
            return ids;
        });
    }

    async function launch(g) {
        await page.evaluate(() => document.getElementById('quit-game-btn')?.click());
        await page.waitForTimeout(50);
        await page.click(`.launcher-btn[data-game-id="${g.gameId}"]`);
        // Wait for the SDK in the iframe to come up so we know it's a real,
        // settled launch (not just an attached <iframe>). Frame handle, not a
        // page-context contentWindow probe — the frame is opaque-origin.
        const fr = await frameFor(page, new URL(g.href, origin).href);
        if (fr) {
            await fr.waitForFunction(() => !!(window.Arcade && window.Arcade.context), null, { timeout: 10_000 })
                .catch(() => {});
        }
        await page.waitForTimeout(200);
    }

    // Plant a probe before A is evicted: write a known marker into A's
    // localStorage (via the launcher origin — same origin) and confirm it
    // survives eviction + relaunch.
    await launch(a);
    await page.evaluate((gid) => {
        localStorage.setItem(`arcade.v1.${gid}.acceptance.probe`, JSON.stringify('preserved'));
    }, a.gameId);

    await launch(b);

    const after2 = await poolSnapshot();
    record(2, 'pool size = 2 after launching 2 games at cap=2',
        after2.length === 2,
        `iframes: [${after2.join(', ')}]`);

    // Launch C — should evict A (LRU).
    await launch(c);
    const after3 = await poolSnapshot();
    record(3, 'launching 3rd game evicts LRU iframe (cap=2)',
        after3.length === 2,
        `iframes: [${after3.join(', ')}]`);
    record(4, 'evicted iframe is the LRU (game A), not the active or MRU',
        !after3.includes(a.gameId) &&
        after3.includes(b.gameId) &&
        after3.includes(c.gameId),
        `iframes: [${after3.join(', ')}]`);

    // Verify localStorage for evicted game is intact.
    const probe = await page.evaluate((gid) =>
        localStorage.getItem(`arcade.v1.${gid}.acceptance.probe`), a.gameId);
    record(5, 'evicted game\'s arcade.v1.<gameId>.* localStorage survives',
        probe === JSON.stringify('preserved'),
        `probe=${probe}`);

    // Re-launch A — should be a fresh load, and B (now LRU) should be evicted.
    await launch(a);
    const after4 = await poolSnapshot();
    record(6, 'relaunching evicted game restores it; new LRU is evicted',
        after4.length === 2 &&
        after4.includes(a.gameId) &&
        !after4.includes(b.gameId),
        `iframes: [${after4.join(', ')}]`);

    // Helper: drive the numeric input the same way a user would (set value,
    // dispatch change). The launcher persists on change, not input.
    async function setCap(n) {
        await page.evaluate((v) => {
            const el = document.getElementById('menu-pool-cap-input');
            if (!el) return;
            el.value = String(v);
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }, n);
        await page.waitForTimeout(100);
    }

    // Test cap = gameCount (effectively "all") — pool should grow.
    const gameCount = await page.$$eval('.launcher-btn[data-game-id]', (n) => n.length);
    await setCap(gameCount);
    await launch(b);  // pool now has [a, c, b]; cap=gameCount so no eviction
    const afterAll = await poolSnapshot();
    record(7, 'cap=gameCount allows pool to grow beyond 2',
        afterAll.length >= 3,
        `cap=${gameCount} iframes: [${afterAll.join(', ')}]`);

    // Test cap=1 immediate trim — should evict back to active only.
    await setCap(1);
    const afterTrim = await poolSnapshot();
    record(8, 'lowering cap to 1 immediately trims pool to active game',
        afterTrim.length === 1 && afterTrim.includes(b.gameId),
        `iframes: [${afterTrim.join(', ')}]`);

    // Test out-of-range input is clamped (e.g. 999 → gameCount; 0 → 1).
    await setCap(999);
    const clampedHigh = await page.evaluate(() =>
        Number(JSON.parse(localStorage.getItem('arcade.v1.global.poolCap'))));
    await setCap(0);
    const clampedLow = await page.evaluate(() =>
        Number(JSON.parse(localStorage.getItem('arcade.v1.global.poolCap'))));
    record(9, 'cap input clamps out-of-range values to [1, gameCount]',
        clampedHigh === gameCount && clampedLow === 1,
        `999 → ${clampedHigh}, 0 → ${clampedLow} (gameCount=${gameCount})`);

    // With cap=1, sequential launches must hold pool.size at exactly 1 — the
    // outgoing active game must be evicted to make room for the incoming one.
    await setCap(1);
    await launch(a);
    let snap = await poolSnapshot();
    record(10, 'cap=1: pool stays at 1 after sequential launches (1)',
        snap.length === 1 && snap.includes(a.gameId),
        `iframes: [${snap.join(', ')}]`);
    await launch(b);
    snap = await poolSnapshot();
    record(11, 'cap=1: outgoing active is evicted on next launch',
        snap.length === 1 && snap.includes(b.gameId),
        `iframes: [${snap.join(', ')}]`);

    // After cap-decrease eviction, relaunching an evicted game must produce a
    // working iframe (not an orphan stuck on about:blank). This is the user
    // bug report: "Apps that were unloaded due to being past the limit,
    // because I decreased it, do not reload."
    await setCap(gameCount);
    await launch(a);
    await launch(b);
    await launch(c);
    await page.evaluate(() => document.getElementById('quit-game-btn')?.click());
    await page.waitForTimeout(80);
    await setCap(1);
    snap = await poolSnapshot();
    const trimmedTo = snap[0];
    // Pick an evicted game (not the one that survived the trim) to relaunch.
    const evicted = [a, b, c].find((g) => g.gameId !== trimmedTo);
    await page.click(`.launcher-btn[data-game-id="${evicted.gameId}"]`);
    // Real load, proven in two halves: page-side, the iframe element points at
    // the game URL (src is a parent-document attribute — readable regardless
    // of frame origin, unlike contentWindow.document, which the opaque-origin
    // sandbox blocks); frame-side, the document completed and the SDK booted.
    const srcOk = await page
        .waitForFunction((gid) => {
            const f = document.querySelector(`iframe[data-game-id="${gid}"]`);
            return !!(f && f.src && !f.src.endsWith('about:blank'));
        }, evicted.gameId, { timeout: 10_000 })
        .then(() => true).catch(() => false);
    const evictedFrame = srcOk ? await frameFor(page, new URL(evicted.href, origin).href) : null;
    const reloaded = !!evictedFrame && await evictedFrame
        .waitForFunction(() => document.readyState === 'complete' && !!(window.Arcade && window.Arcade.context),
            null, { timeout: 10_000 })
        .then(() => true).catch(() => false);
    record(12, 'evicted-by-cap-decrease game reloads on relaunch',
        reloaded, `relaunched=${evicted.gameId}, trimmedTo=${trimmedTo}`);

    record(13, 'no console errors during pool exercise',
        errors.length === 0,
        errors.slice(0, 2).join(' | '));

    await ctx.close();
}

async function printAndExit() {
    checks.sort((a, b) => a.n - b.n);
    let pass = 0, fail = 0;
    console.log('');
    for (const c of checks) {
        const mark = c.ok ? '✓' : '✗';
        const detail = c.detail ? `   (${c.detail})` : '';
        console.log(` ${mark} ${c.n}.  ${c.name}${detail}`);
        c.ok ? pass++ : fail++;
    }
    console.log(`\n ${pass} passed, ${fail} failed`);
    await browser.close().catch(() => {});
    if (server) server.close();
    process.exit(fail === 0 ? 0 : 1);
}
