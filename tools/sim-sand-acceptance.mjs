#!/usr/bin/env node
//
// tools/sim-sand-acceptance.mjs — the sand kernel in a real game frame.
//
// sim-sand-unit.mjs proves the kernel; this proves the DELIVERY: the wrapper
// loaded as a classic script at an opaque origin (the pool's exact sandbox
// flags, arcade-pool.js), resolving and fetching its .wasm beside itself as a
// CORS request from origin null, attaching to Arcade.sim, and handing a
// framebuffer to putImageData that draws something. The paint script the
// fixture runs is replayed through the JS reference here in node and the two
// grid hashes must agree — the cross-runtime determinism the whole design
// rests on (plan §2), asserted end to end rather than assumed from the unit
// tier. Both the evergreen and the pinned script paths are exercised, since
// the binary must resolve beside whichever one a game used.
//
// Self-contained: serves the repo on :4805 with CORS (as GitHub Pages and
// dev.sh do) and mounts tools/fixtures/sim-sand/ in a sandboxed iframe.
//
//   node tools/sim-sand-acceptance.mjs
//
// Exit code: 0 if all checks pass, 1 otherwise.

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveRepo } from './lib/static-server.mjs';
import { createRecorder } from './lib/check-recorder.mjs';
import { createSandReference, fnv1a, PALETTE, SAND_BASE, WATER, WALL } from './sim/sand-reference.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4805;
const W = 128, H = 96, SEED = 7;

// The fixture's runScript(), replayed on the reference. Change both or neither.
function expectedHashes() {
    const ref = createSandReference({ width: W, height: H, seed: SEED });
    for (let k = 0; k < 200; k++) {
        if (k % 3 === 0) ref.paint(SAND_BASE + (k % 32), 64, 4, 1);
        if (k >= 100) ref.paint(WATER, 30, 4, 2);
        if (k === 50) ref.paint(WALL, 64, 40, 5);
        if (k === 150) ref.nudge(64, 90, 8, -6, -2);
        ref.step();
    }
    const afterScript = fnv1a(ref.grid);
    let n = 0;
    while (!ref.quiet() && n < 600) { ref.step(); n++; }
    return { afterScript, settled: fnv1a(ref.grid), settleSteps: n };
}

const server = await serveRepo({ root: ROOT, port: PORT, cors: true });
const { check, summarize } = createRecorder({ detailStyle: 'dash' });
const browser = await chromium.launch({ headless: true });
try {
    const want = expectedHashes();

    async function runFrame(page, fixtureUrl, label) {
        // A host page with the pool's real sandbox flags; the fixture is the
        // frame. No allow-same-origin: the frame's origin is null.
        await page.setContent(`<!doctype html><iframe id="g" sandbox="allow-scripts allow-downloads" src="${fixtureUrl}" width="200" height="150"></iframe>`);
        const frame = await (await page.waitForSelector('#g')).contentFrame();
        await frame.waitForFunction(() => typeof window.__run === 'function');
        const r = await frame.evaluate(() => window.__run());
        check(`${label}: ArcadeSimSand global present`, r.globalPresent);
        check(`${label}: attached as Arcade.sim.sand`, r.attachedToArcade);
        check(`${label}: 128×96 sim created`, r.dims[0] === W && r.dims[1] === H);
        check(`${label}: grid after the script matches the node reference`, r.hashAfterScript === want.afterScript,
            `${r.hashAfterScript} vs ${want.afterScript}`);
        check(`${label}: settled grid matches the node reference`, r.hashSettled === want.settled, `${r.hashSettled} vs ${want.settled}`);
        check(`${label}: quiet() after settling (${r.settleSteps} steps, reference ${want.settleSteps})`,
            r.quietAfter && r.settleSteps === want.settleSteps);
        check(`${label}: stays quiet`, r.stillQuiet);
        check(`${label}: activeCells() is 0 when quiet`, r.activeAfter === 0);
        check(`${label}: not quiet at start, not quiet mid-pour`, r.quietAtStart === false && r.quietDuring === false && r.activeDuring > 0);
        check(`${label}: pixels view is stable between reads and full-sized`, r.pixelsStable);
        check(`${label}: putImageData drew a non-uniform canvas (${r.distinctColours} colours)`, r.distinctColours >= 4);
        const palOk = r.samples.every((s) => s.rgb[0] === PALETTE[s.m * 4] && s.rgb[1] === PALETTE[s.m * 4 + 1] && s.rgb[2] === PALETTE[s.m * 4 + 2]);
        check(`${label}: canvas samples show the palette of the material beneath`, palOk, JSON.stringify(r.samples));
        check(`${label}: a paint after quiet wakes the sim and it rests again`, r.wokeOnPaint && r.restedAgain);
        check(`${label}: nudge() wakes a settled pile and it re-settles`, r.nudgeWoke && r.nudgeRested);
        check(`${label}: setPalette() changes pixels`, r.paletteChangedPixels);
        check(`${label}: clear() is instantly quiet, a paint after it wakes`, r.clearQuiet && r.clearThenPaintWakes);
        check(`${label}: two sims have independent memory`, r.independent);
        check(`${label}: tint(5) is SAND_BASE + 5`, r.tint5 === r.materials.SAND_BASE + 5 && r.materials.SAND_COUNT === 32);
        check(`${label}: bad material / bad dims / disposed sim are refused`, r.badMaterialThrows && r.badDimsReject && r.disposedThrows);
        return r;
    }

    const page = await browser.newPage();
    page.on('pageerror', (e) => check('no page errors', false, e.message));

    const origin = `http://127.0.0.1:${PORT}`;
    const evergreen = await runFrame(page, `${origin}/tools/fixtures/sim-sand/`, 'evergreen');
    check('evergreen: binary resolved beside /arcade-sim-sand.js', evergreen.binaryUrl === `${origin}/arcade-sim-sand.wasm`, evergreen.binaryUrl);

    const pinned = await runFrame(page, `${origin}/tools/fixtures/sim-sand/?path=/sdk/v3/arcade-sim-sand.js`, 'pinned');
    check('pinned: binary resolved beside /sdk/v3/arcade-sim-sand.js', pinned.binaryUrl === `${origin}/sdk/v3/arcade-sim-sand.wasm`, pinned.binaryUrl);

    // The server types .wasm as application/wasm, so the frame took the
    // streaming path; assert the header so a future MIME regression in the
    // harness is visible rather than silently downgrading to the bytes path.
    const head = await fetch(`${origin}/arcade-sim-sand.wasm`);
    check('harness serves .wasm as application/wasm (the streaming path)', head.headers.get('content-type') === 'application/wasm');
} finally {
    await browser.close();
    server.close();
}

process.exit(summarize({ style: 'all-passed', label: 'sim-sand acceptance' }));
