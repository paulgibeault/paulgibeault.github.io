// powersaver-acceptance.mjs — the powerSaver setting, end to end.
//
// Drives the real launcher menu toggle, then boots the SDK standalone on the
// same origin to prove the setting round-trips into the game-facing surface:
// data-power-saver, Arcade.settings.powerSaver(), and the --arcade-pulse-count
// ladder from the SDK's injected base style — asserted both as the token and as
// the animation-iteration-count a real element actually resolves to, which are
// not the same statement under reduced motion. Also covers the bridged path a
// real (opaque-origin) game uses, and the iframe-pool pinning.
// Port 4783 — clear of the other suites.
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
try {
    const page = await browser.newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    // The launcher's wiring lives in deferred ES modules. Wait for the seam this
    // suite actually dereferences rather than sleeping a flat 500ms and hoping —
    // on a loaded runner that sleep can lapse first, and the pool checks below
    // would then throw an unhandled TypeError instead of reporting a clean ✗.
    await page.waitForFunction(() => window.__arcade && window.__arcade.pool, null, { timeout: 30000 });

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
    // Statement body: init() returns the whole api object, and handing that to
    // Playwright to serialize would break the day it gains a cycle.
    await page.evaluate(() => { window.Arcade.init({ gameId: 'ps-smoke' }); });
    ok(await page.evaluate(() => window.Arcade.settings.powerSaver()) === true, 'Arcade.settings.powerSaver() reads true from storage');
    ok(await page.evaluate(() => window.Arcade.settings.snapshot().powerSaver) === true,
        'snapshot() carries powerSaver as true, not merely present');
    const pulse = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--arcade-pulse-count').trim());
    ok(pulse === '1', `--arcade-pulse-count is 1 under power saver (got '${pulse}')`);

    // -- ladder: reduced motion wins with 0 --
    await page.evaluate(() => document.documentElement.setAttribute('data-reduced-motion', 'true'));
    const pulseRM = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--arcade-pulse-count').trim());
    ok(pulseRM === '0', `--arcade-pulse-count is 0 under reduced motion (got '${pulseRM}')`);
    await page.evaluate(() => document.documentElement.setAttribute('data-reduced-motion', 'false'));

    // -- the token is only half the contract: assert what a game OBSERVES --
    // The rule above sets a custom property; what actually governs a game is the
    // resolved animation-iteration-count on a real element declaring exactly what
    // §5 tells games to write. These differ: the pre-existing reduced-motion kill
    // switch sets `animation-iteration-count: 1 !important` on `*`, so under
    // reduced motion a conforming game gets one instantaneous frame (duration
    // ~0) rather than the token's literal 0. That is the correct outcome — but it
    // is a different statement from the token's value, and only this check would
    // notice if the kill switch were dropped and infinite pulses came back.
    await page.evaluate(() => {
        const s = document.createElement('style');
        s.textContent = '@keyframes ps-probe-ring{from{opacity:.3}to{opacity:1}}'
            + '#ps-probe{animation:ps-probe-ring 1s ease-in-out infinite;'
            + 'animation-iteration-count:var(--arcade-pulse-count,3);}';
        document.head.appendChild(s);
        const d = document.createElement('div');
        d.id = 'ps-probe';
        document.body.appendChild(d);
    });
    // The last two rows pin the deliberate design decision that the ladder rule is
    // NOT gated on data-arcade-keep-motion: that opt-out escapes a blanket `*`
    // selector a game never asked for, whereas this token is opt-in per effect. So
    // a keep-motion game that still consumes the token gets the literal 0 — the
    // only combination where the token's value and the effective count agree under
    // reduced motion.
    const LADDER = [
        { keep: false, ps: false, rm: false, count: '3', instant: false, why: 'unconstrained: 3 pulses, then settles' },
        { keep: false, ps: true, rm: false, count: '1', instant: false, why: 'power saver: a single pulse' },
        { keep: false, ps: false, rm: true, count: '1', instant: true, why: 'reduced motion: one instantaneous frame (kill switch)' },
        { keep: false, ps: true, rm: true, count: '1', instant: true, why: 'both: reduced motion wins' },
        { keep: true, ps: false, rm: true, count: '0', instant: false, why: 'keep-motion + reduced motion: the token is honoured literally' },
        { keep: true, ps: true, rm: false, count: '1', instant: false, why: 'keep-motion does not exempt a game from the battery lever' },
    ];
    for (const c of LADDER) {
        const got = await page.evaluate(([keep, ps, rm]) => {
            const d = document.documentElement;
            if (keep) d.setAttribute('data-arcade-keep-motion', ''); else d.removeAttribute('data-arcade-keep-motion');
            d.setAttribute('data-power-saver', ps ? 'true' : 'false');
            d.setAttribute('data-reduced-motion', rm ? 'true' : 'false');
            const cs = getComputedStyle(document.getElementById('ps-probe'));
            return { count: cs.animationIterationCount, dur: parseFloat(cs.animationDuration) };
        }, [c.keep, c.ps, c.rm]);
        const instant = got.dur < 0.01;
        const label = `keepMotion=${c.keep} powerSaver=${c.ps} reducedMotion=${c.rm}`;
        ok(got.count === c.count && instant === c.instant,
            `${label} → ${c.why} (got count=${got.count}, duration=${got.dur}s)`);
        // Whatever the ladder resolves to, it must never be an endless loop —
        // that is the whole point of §6d.
        ok(got.count !== 'infinite', `${label}: never infinite`);
    }
    await page.evaluate(() => {
        document.documentElement.removeAttribute('data-arcade-keep-motion');
        document.documentElement.setAttribute('data-reduced-motion', 'false');
        document.documentElement.setAttribute('data-power-saver', 'true');
        document.getElementById('ps-probe').remove();
    });

    // -- pool pinning: power saver caps the pool at 1 without eating the setting --
    // Driven through the real pool, not a re-derivation of its arithmetic: mount
    // two games with a roomy stored cap, flip the toggle, and count what survives.
    // Nothing else in CI covers arcade-pool's readPoolCap branch. Both ids point at
    // the same hermetic fixture — this asserts cap math and eviction, not loading.
    const FIXTURE = '/tools/fixtures/config-test/';
    await page.evaluate(() => {
        localStorage.setItem('arcade.v1.global.poolCap', '3');
        localStorage.setItem('arcade.v1.global.powerSaver', 'false');
    });
    const mountedBefore = await page.evaluate((src) => {
        const pool = window.__arcade.pool;
        pool.showGame('ps-pool-a', src, 'Pool A');
        pool.showGame('ps-pool-b', src, 'Pool B');
        return pool.mountedGameIds();
    }, FIXTURE);
    ok(mountedBefore.length === 2,
        `stored cap of 3 keeps both games mounted (got ${mountedBefore.length}: ${mountedBefore.join(', ')})`);

    // The toggle itself must evict — not the next launch.
    await page.evaluate(() => document.getElementById('menu-power-saver').click());
    const mountedAfter = await page.evaluate(() => window.__arcade.pool.mountedGameIds());
    ok(mountedAfter.length === 1,
        `power saver evicts down to the active game on toggle (got ${mountedAfter.length}: ${mountedAfter.join(', ')})`);
    ok(mountedAfter[0] === 'ps-pool-b',
        `the surviving frame is the active one, not an arbitrary LRU pick (got ${mountedAfter[0]})`);
    ok(await page.evaluate(() => JSON.parse(localStorage.getItem('arcade.v1.global.poolCap'))) === 3,
        "the user's stored poolCap is untouched at 3");

    // ...and turning it back off restores the roomier cap rather than sticking at 1.
    // Mount up to the full stored cap of 3: settling at 2 would pass a "cap is at
    // least 2" check while the real cap was still wrong.
    await page.evaluate(() => document.getElementById('menu-power-saver').click());
    const mountedRestored = await page.evaluate((src) => {
        const pool = window.__arcade.pool;
        pool.showGame('ps-pool-c', src, 'Pool C');
        pool.showGame('ps-pool-d', src, 'Pool D');
        return pool.mountedGameIds();
    }, FIXTURE);
    ok(mountedRestored.length === 3,
        `the full stored cap of 3 is back in force after toggling off (got ${mountedRestored.length}: ${mountedRestored.join(', ')})`);
    // Leave power saver ON for the restore checks that follow.
    await page.evaluate(() => {
        window.__arcade.pool.hideGameView && window.__arcade.pool.hideGameView();
        document.getElementById('menu-power-saver').click();
    });

    // -- toggle off restores everything --
    await page.evaluate(() => document.getElementById('menu-power-saver').click());
    ok(await page.getAttribute('html', 'data-power-saver') === 'false', 'toggle off: data-power-saver=false');
    const pulseOff = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--arcade-pulse-count').trim());
    ok(pulseOff === '3', `--arcade-pulse-count back to 3 (got '${pulseOff}')`);
    ok(await page.evaluate(() => getComputedStyle(document.getElementById('starfield')).display) !== 'none', 'starfield visible again');

    // -- the bridged path, which is the one real games actually take --
    // Everything above inits the SDK inside the launcher's own document, so
    // inIframe() is false and the arcade:hello/welcome handshake never runs. Real
    // games are opaque-origin (sandbox without allow-same-origin): they cannot read
    // arcade.v1.global.powerSaver at all and receive it ONLY over the wire, in
    // welcome.settings and then arcade:settings.changed. Untested, that leg could
    // break without a single check going red. A fresh context also keeps this clear
    // of the launcher document the standalone Arcade.init() above mutated.
    {
        const ctx = await browser.newContext();
        const bridged = await ctx.newPage();
        await bridged.goto(BASE, { waitUntil: 'domcontentloaded' });
        await bridged.waitForFunction(() => window.__arcade && window.__arcade.pool, null, { timeout: 30000 });
        await bridged.evaluate(() => localStorage.setItem('arcade.v1.global.powerSaver', 'true'));
        await bridged.reload({ waitUntil: 'domcontentloaded' });
        await bridged.waitForFunction(() => window.__arcade && window.__arcade.pool, null, { timeout: 30000 });

        const GAME = '/tools/fixtures/bridge-test/';
        await bridged.evaluate((src) => window.__arcade.pool.showGame('bridge-test', src, 'Bridge Test'), GAME);
        let frame = null;
        for (let i = 0; i < 200 && !frame; i++) {
            frame = bridged.frames().find((f) => f.url().includes(GAME));
            if (!frame) await bridged.waitForTimeout(50);
        }
        ok(!!frame, 'bridged fixture frame mounted');
        if (frame) {
            await frame.evaluate(() => window.Arcade.ready);
            ok(await frame.evaluate(() => window.Arcade.settings.powerSaver()) === true,
                'an opaque-origin game receives powerSaver=true in welcome.settings');
            ok(await frame.evaluate(() => document.documentElement.getAttribute('data-power-saver')) === 'true',
                'the bridged frame stamps data-power-saver on its own <html>');

            // Now flip it from the launcher menu and prove settings.changed carries
            // it across the boundary — this is what a running game reacts to.
            await bridged.evaluate(() => { document.getElementById('menu-power-saver').click(); });
            const flipped = await frame.waitForFunction(
                () => window.Arcade.settings.powerSaver() === false, null, { timeout: 10000 }
            ).then(() => true).catch(() => false);
            ok(flipped, 'toggling the launcher menu pushes powerSaver=false to the live frame');
            ok(await frame.evaluate(() => document.documentElement.getAttribute('data-power-saver')) === 'false',
                "the frame's data-power-saver follows the change");
        }
        await ctx.close();
    }

} catch (e) {
    ok(false, `run completed — ${(e && e.stack) || e}`);
} finally {
    await browser.close();
    if (server && server.close) server.close();
}

console.log(failures === 0 ? '\n✓ all power-saver acceptance checks passed' : `\n✗ ${failures} failures`);
process.exit(failures === 0 ? 0 : 1);

