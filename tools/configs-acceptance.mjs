#!/usr/bin/env node
//
// tools/configs-acceptance.mjs — end-to-end proof of the config-exchange
// deep-link path (#config-exchange, C1): boot the real launcher at
// `#app=<game>&cfg=<code>`, get the attributed receive prompt, and on accept
// see the config delivered into the game frame (arcade:config post-welcome via
// the pool.onHelloed seam). Also proves the decline path delivers nothing and
// an undecodable code shows no prompt.
//
//   node tools/configs-acceptance.mjs
//
// Self-contained: serves the repo on :4788 with a one-game fixture catalog.
//
// Exit code: 0 if all checks pass, 1 otherwise.

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveRepo } from './lib/static-server.mjs';
import { createRecorder } from './lib/check-recorder.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4788;
const BASE = `http://127.0.0.1:${PORT}`;
const GAME_PATH = '/tools/fixtures/config-test/';

// Reproduces the SDK's shareApi.encode so the link carries a real share code.
function shareEncode(obj, v) {
    const json = JSON.stringify({ v: v >>> 0, d: obj === undefined ? null : obj });
    const bytes = new TextEncoder().encode(json);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const CODE = shareEncode({ g: 'config-test', t: 'pack', d: { name: 'Weekend', note: 'hi' } }, 1);

const server = await serveRepo({ root: ROOT, port: PORT, catalogOverride: 'tools/fixtures/config-catalog.json' });
const { check, summarize } = createRecorder({ detailStyle: 'dash' });

async function frameFor(page) {
    let frame = null;
    for (let i = 0; i < 120 && !frame; i++) {
        frame = page.frames().find((f) => f.url().includes(GAME_PATH));
        if (!frame) await page.waitForTimeout(50);
    }
    return frame;
}

const browser = await chromium.launch({ headless: true });
async function freshPage(label) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on('pageerror', (e) => check('no page errors (' + label + ')', false, e.message));
    return { ctx, page };
}
try {
    // ── accept path ──
    {
        // Dialog waits are a 60s CEILING, not an expectation (locally the
        // dialog shows in ~2s). Each path boots a whole fresh launcher in a
        // fresh browser context, and on loaded 2-core CI runners that boot
        // blew a 10s budget and then a 20s one — 4 of 6 runs in one evening,
        // both attempts on the last. The suite asserts the consent prompt's
        // attribution and delivery semantics, not boot latency, so the only
        // thing a tight budget measured was runner contention. If this ever
        // fails at 60s, stop raising it: that is a genuine intermittent
        // no-show — a race in the deep-link path — and it needs a debugger,
        // not more headroom.
        //
        // It did fail at 60s, and there was: __arcade.configs wired up after
        // openDeepLink read it. Found, fixed in index.html (pendingConfigLink),
        // and pinned by the boot-order check at the bottom of this file. The
        // ceiling stays a ceiling; the race no longer hides behind it.
        const { ctx, page } = await freshPage('accept');
        await page.goto(`${BASE}/#app=config-test&cfg=${CODE}`, { waitUntil: 'load' });
        await page.waitForSelector('#arcade-dialog:not(.hidden)', { timeout: 60000 });
        const promptText = await page.evaluate(() => document.getElementById('arcade-dialog-msg').textContent);
        check('receive prompt appears and names the game', /Config Test/.test(promptText), promptText);
        await page.click('#arcade-dialog-ok'); // "Load"
        const frame = await frameFor(page);
        check('game frame mounted from the link', !!frame);
        const received = frame
            ? await frame.waitForFunction(() => window.__configReceived, null, { timeout: 60000 })
                .then((h) => h.jsonValue()).catch(() => null)
            : null;
        check('game handler received the config post-welcome',
            !!received && received.type === 'pack' && received.data && received.data.name === 'Weekend',
            JSON.stringify(received));
        await ctx.close();
    }

    // ── decline path ──
    {
        const { ctx, page } = await freshPage('decline');
        await page.goto(`${BASE}/#app=config-test&cfg=${CODE}`, { waitUntil: 'load' });
        await page.waitForSelector('#arcade-dialog:not(.hidden)', { timeout: 60000 });
        await page.click('#arcade-dialog-cancel'); // "Ignore"
        const frame = await frameFor(page);
        check('game still opens after declining the config', !!frame);
        await page.waitForTimeout(1500);
        const afterDecline = frame ? await frame.evaluate(() => window.__configReceived) : 'no-frame';
        check('declined config is never delivered', afterDecline === null);
        await ctx.close();
    }

    // ── undecodable code: no prompt, no delivery ──
    {
        const { ctx, page } = await freshPage('bad-code');
        await page.goto(`${BASE}/#app=config-test&cfg=AAAA`, { waitUntil: 'load' }); // valid charset, not a real code
        await page.waitForTimeout(1500);
        const noPrompt = await page.evaluate(() => document.getElementById('arcade-dialog').classList.contains('hidden'));
        check('an undecodable config code shows no receive prompt', noPrompt);
        await ctx.close();
    }

    // ── boot-order regression: the late-wired configs module ──
    // window.__arcade.configs is wired in the LAST module script (it needs
    // pool/dialog/catalog). openDeepLink runs from bootCatalog's await
    // continuation, and module scripts are separate execution units with a
    // microtask checkpoint between them — so when the catalog fetch resolved
    // before that last script's imports did, the config was silently swallowed:
    // game opens, no prompt, no error. That is the intermittent no-show this
    // suite kept hitting on loaded CI runners and never locally.
    //
    // Delaying only the last script's own imports flips the race
    // deterministically, on any machine, in about a second. Without the
    // pendingConfigLink handoff in index.html this check fails 100% of the time.
    {
        const { ctx, page } = await freshPage('late-configs-module');
        for (const mod of ['**/arcade-records.js', '**/arcade-configs.js']) {
            await page.route(mod, async (route) => {
                await new Promise((r) => setTimeout(r, 300));
                route.continue();
            });
        }
        await page.goto(`${BASE}/#app=config-test&cfg=${CODE}`, { waitUntil: 'load' });
        let prompted = true;
        try {
            await page.waitForSelector('#arcade-dialog:not(.hidden)', { timeout: 20000 });
        } catch (e) { prompted = false; }
        check('a config link survives the configs module wiring up late', prompted,
            prompted ? '' : 'no receive prompt — openDeepLink ran before __arcade.configs existed');
        await ctx.close();
    }
} catch (e) {
    check('run completed', false, (e && e.message) || String(e));
} finally {
    await browser.close();
    server.close();
}

process.exit(summarize({ label: 'Configs acceptance' }));
