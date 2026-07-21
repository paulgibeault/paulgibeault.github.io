#!/usr/bin/env node
//
// tools/configs-p2p-acceptance.mjs — end-to-end proof of the P2P config push
// (#config-exchange, C2): device A sends a game config to paired device B over
// the kind:'config' envelope; B is PROMPTED (not silently accepted) and, on
// accept, opens the target game; on decline nothing happens. Config push is an
// explicit user action, so it is NOT gated on the sync opt-in (unlike sync /
// leaderboards) — only a direct, identity-bound link.
//
//   node tools/configs-p2p-acceptance.mjs
//
// Self-contained: local static server (real catalog), local ICE, loopback drop.
// Ports 4784 (http) / 4785 (drop).
//
// Exit code: 0 if all checks pass, 1 otherwise.

import { startP2PHarness, makeCheck } from './lib/p2p-test-harness.mjs';

const { check, failed } = makeCheck();
const harness = await startP2PHarness({ port: 4784, dropPort: 4785 });
const { launcherPage, ceremony } = harness;

const FAST_RDV = `(() => {
    const r = window.__arcade.p2p._rdv();
    r.options.listenerDelayMs = 800;
    r.options.callerDelayMs = 1600;
    window.__rdvEv = window.__rdvEv || [];
    for (const t of ['pair-established', 'reconnecting', 'reconnected', 'recovered-inband', 'gave-up', 'remote-bye'])
        r.addEventListener(t, () => window.__rdvEv.push(t));
})()`;

async function loadBridge(page) {
    await harness.bootBridge(page, { closeDialog: true });
    await page.evaluate(FAST_RDV);
    await page.waitForFunction('!!window.__arcade.catalog && window.__arcade.catalog.length > 0', null, { timeout: 10000 });
}
async function pairBoth(H, J) {
    for (const page of [H, J]) {
        await page.waitForFunction(`(() => { const raw = localStorage.getItem('arcade.v1._meta.knownPeers'); return raw && Object.keys(JSON.parse(raw)).length > 0; })()`, null, { timeout: 10000 });
    }
    for (const page of [H, J]) {
        await page.evaluate(() => { const known = JSON.parse(localStorage.getItem('arcade.v1._meta.knownPeers')); return window.__arcade.p2p.enableAutoReconnect(Object.keys(known)[0]); });
    }
    for (const page of [H, J]) {
        await page.waitForFunction(`window.__rdvEv.includes('pair-established')`, null, { timeout: 10000 });
    }
}
async function freshPair(tag) {
    const H = await launcherPage(tag + ':host', await harness.newDeviceContext());
    const J = await launcherPage(tag + ':joiner', await harness.newDeviceContext());
    await loadBridge(H); await loadBridge(J);
    await ceremony(H, J);
    await pairBoth(H, J);
    return { H, J };
}

// A game's Arcade.configs.send(...) reaches the launcher as arcade:configs.op;
// drive that engine entry point directly (the game frame isn't needed to prove
// the cross-device push).
const sendConfig = (page, gameId, data) => page.evaluate(({ gameId, data }) =>
    window.__arcade.configs.handleOp(gameId, { id: 'c1', op: 'send', t: 'pack', d: data }),
    { gameId, data });
const mounted = (page, gameId) => page.evaluate((g) => window.__arcade.pool.mountedGameIds().indexOf(g) !== -1, gameId);
// A "Name this connection" prompt from pairing may queue ahead of the config
// prompt (both ride the serialized arcade-dialog chain). Dismiss anything that
// isn't the config prompt, then return the config prompt's text.
async function waitForConfigPrompt(page) {
    for (let i = 0; i < 40; i++) {
        await page.waitForSelector('#arcade-dialog:not(.hidden)', { timeout: 10000 });
        const text = await page.evaluate(() => document.getElementById('arcade-dialog-msg').textContent);
        if (/configuration/i.test(text)) return text;
        await page.click('#arcade-dialog-cancel');
        await page.waitForTimeout(150);
    }
    return null;
}

try {
    const { H, J } = await freshPair('cfg');

    // ── accept path: A sends pi-game config → B prompts → Load → B opens it ──
    const sent = await sendConfig(H, 'pi-game', { name: 'Shared Pack' });
    check('sender reports ok + sent to 1 peer', sent && sent.ok === true && sent.sent === 1, JSON.stringify(sent));
    const promptText = await waitForConfigPrompt(J);
    check('receiver is prompted before anything loads', !!promptText && /configuration/i.test(promptText), promptText);
    await J.click('#arcade-dialog-ok'); // "Load"
    const opened = await J.waitForFunction(() => window.__arcade.pool.mountedGameIds().indexOf('pi-game') !== -1, null, { timeout: 8000 })
        .then(() => true).catch(() => false);
    check('accepting opens the target game on the receiver', opened);

    // ── decline path: A sends moon-lit config → B declines → not opened ──
    await J.waitForTimeout(1500); // clear the per-peer prompt rate limit
    const sent2 = await sendConfig(H, 'moon-lit', { name: 'Nope' });
    check('second send also reports sent', sent2 && sent2.sent === 1);
    const declineText = await waitForConfigPrompt(J);
    check('receiver prompted for the second config', !!declineText);
    await J.click('#arcade-dialog-cancel'); // "No"
    await J.waitForTimeout(1500);
    check('declining does not open the game', (await mounted(J, 'moon-lit')) === false);
} catch (e) {
    check('run completed', false, (e && e.message) || String(e));
} finally {
    await harness.shutdown();
}

process.exit(failed() ? 1 : 0);
