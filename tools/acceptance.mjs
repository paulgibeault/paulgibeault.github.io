#!/usr/bin/env node
//
// tools/acceptance.mjs — Run the GAME_INTEGRATION §13 acceptance checklist
// against a running staged launcher.
//
//   node tools/acceptance.mjs http://127.0.0.1:4791/si-syn/
//
// Assumes the URL is already reachable — typically by running `./dev.sh
// ../<game-repo>` in another shell. The game must be mounted at
// <origin>/<gameId>/ and the launcher at <origin>/.
//
// Setup (once):
//   npm install
//   npx playwright install chromium
//
// Exit code: 0 if all checks pass, 1 otherwise.

import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

const url = process.argv[2];
if (!url) {
    console.error('usage: node tools/acceptance.mjs <game-url>');
    process.exit(2);
}

let parsed;
try { parsed = new URL(url); } catch { console.error('invalid URL:', url); process.exit(2); }
const origin = parsed.origin;
const segments = parsed.pathname.split('/').filter(Boolean);
if (!segments.length) {
    console.error('URL must include a game path, e.g. /si-syn/');
    process.exit(2);
}
const gameId = segments[0];
const gameUrl = `${origin}/${gameId}/`;
const launcherUrl = `${origin}/`;

const checks = [];
const record = (n, name, ok, detail) => checks.push({ n, name, ok, detail: detail || '' });

const browser = await chromium.launch({ headless: true });

try {
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

        const btnSel = `.launcher-btn[data-game-id="${gameId}"]`;
        if (!(await page.$(btnSel))) {
            record(2, 'framed=true after launching from launcher', false,
                `launcher has no ${btnSel}`);
            await ctx.close();
            await printAndExit();
        }

        await page.click(btnSel);

        // Wait for the iframe to be created and the SDK to be present inside.
        const ready = await page
            .waitForFunction((gid) => {
                const f = document.querySelector(`iframe[data-game-id="${gid}"]`);
                return !!(f && f.contentWindow && f.contentWindow.Arcade?.context);
            }, gameId, { timeout: 10_000 })
            .catch(() => null);

        const gameFrame = page.frames().find((f) => f.url().startsWith(gameUrl));

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

        // 6 — font-scale propagates without reload. Writing the key in the
        // launcher document fires a storage event in the iframe (different
        // document), which the SDK's storage subscriber picks up.
        const beforeScale = (await gameFrame.evaluate(() =>
            getComputedStyle(document.documentElement).getPropertyValue('--font-scale').trim()
        )) || '1';
        const targetScale = '1.4';
        await page.evaluate((v) => {
            localStorage.setItem('arcade.v1.global.fontScale', v);
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
} finally {
    await browser.close();
}

await printAndExit();

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
    process.exit(fail === 0 ? 0 : 1);
}
