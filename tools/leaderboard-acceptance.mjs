#!/usr/bin/env node
//
// tools/leaderboard-acceptance.mjs — end-to-end proof of shared leaderboards
// (#leaderboards): two real launcher pages, paired over real WebRTC, converge
// each other's score BOARDS by union-merge over the kind:'leaderboard' p2p
// envelope (arcade-p2p.js's onLeaderboardEnvelope/sendLeaderboardEnvelope +
// arcade-leaderboard.js). Unlike Arcade.sync (LWW, whole-key clobber), both
// devices end up holding EVERY entry. Also proves the sync carve-out (scores
// keys never enter the LWW sync record store) and the reset watermark.
//
//   node tools/leaderboard-acceptance.mjs
//
// Self-contained: local static server, local ICE, injected loopback dead-drop.
// Ports 4786 (http) / 4787 (drop) — distinct from the other p2p suites.
//
// Exit code: 0 if all checks pass, 1 otherwise.

import { startP2PHarness, makeCheck } from './lib/p2p-test-harness.mjs';

const { check, failed } = makeCheck();
const harness = await startP2PHarness({ port: 4786, dropPort: 4787 });
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
}
async function pairBoth(H, J) {
    for (const page of [H, J]) {
        await page.waitForFunction(`(() => {
            const raw = localStorage.getItem('arcade.v1._meta.knownPeers');
            return raw && Object.keys(JSON.parse(raw)).length > 0;
        })()`, null, { timeout: 10000 });
    }
    for (const page of [H, J]) {
        await page.evaluate(() => {
            const known = JSON.parse(localStorage.getItem('arcade.v1._meta.knownPeers'));
            return window.__arcade.p2p.enableAutoReconnect(Object.keys(known)[0]);
        });
    }
    for (const page of [H, J]) {
        await page.waitForFunction(`window.__rdvEv.includes('pair-established')`, null, { timeout: 10000 });
    }
}
async function freshPair(tag) {
    const ctxH = await harness.newDeviceContext();
    const ctxJ = await harness.newDeviceContext();
    const H = await launcherPage(tag + ':host', ctxH);
    const J = await launcherPage(tag + ':joiner', ctxJ);
    await loadBridge(H); await loadBridge(J);
    await ceremony(H, J);
    await pairBoth(H, J);
    return { H, J };
}
async function waitFor(fn, timeoutMs = 15000, intervalMs = 150) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await fn()) return true;
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    return false;
}

// Enable the per-peer sync opt-in on both sides (the leaderboard engine's gate).
const enable = (page) => page.evaluate(async () => {
    const { setKnownPeerSyncEnabled, readKnownPeers } = await import('./arcade-known-peers.js');
    const id = Object.keys(readKnownPeers())[0];
    setKnownPeerSyncEnabled(id, true);
    return id;
});
// Write a board through the production bridge path (like a real Arcade.scores.add
// landing): stateWrite -> handleBridgedStateWrite -> host.onStateWritten.
const stateWrite = (page, gameId, key, value) => page.evaluate(({ gameId, key, value }) =>
    window.__arcade.storage.stateWrite(gameId, { key, value }), { gameId, key, value });
const writeBoard = (page, gameId, cat, entries) =>
    stateWrite(page, gameId, `arcade.v1.${gameId}.scores.${cat}`, JSON.stringify(entries));
const boardOf = (page, gameId, cat) => page.evaluate(({ gameId, cat }) => {
    const raw = localStorage.getItem(`arcade.v1.${gameId}.scores.${cat}`);
    return raw ? JSON.parse(raw) : null;
}, { gameId, cat });
const deviceIdOf = (page) => page.evaluate(() => localStorage.getItem('arcade.v1._meta.deviceId'));
const kickLb = (page, peerId) => page.evaluate((id) => window.__arcade.leaderboard.kick(id), peerId);
const syncRecordKeys = (page) => page.evaluate(() => Object.keys(window.__arcade.sync._records()));

const GAME = 'moon-lit', CAT = 'high';
const KEY = `arcade.v1.${GAME}.scores.${CAT}`;

try {
    const { H, J } = await freshPair('lb');
    const [devOnH, devOnJ] = await Promise.all([enable(H), enable(J)]); // devOnH = J's id as H sees it
    const [dH, dJ] = await Promise.all([deviceIdOf(H), deviceIdOf(J)]);

    // Each device sets two distinct, attributed entries.
    await writeBoard(H, GAME, CAT, [
        { score: 100, ts: 1700000000001, name: 'Ada', dev: dH, eid: 'h1' },
        { score: 80, ts: 1700000000002, name: 'Ada', dev: dH, eid: 'h2' }
    ]);
    await writeBoard(J, GAME, CAT, [
        { score: 90, ts: 1700000000003, name: 'Cy', dev: dJ, eid: 'j1' },
        { score: 70, ts: 1700000000004, name: 'Cy', dev: dJ, eid: 'j2' }
    ]);

    // Force a push both ways (also exercises the sync-toggle kick path).
    await kickLb(H, devOnH);
    await kickLb(J, devOnJ);

    const converged = await waitFor(async () => {
        const [bh, bj] = await Promise.all([boardOf(H, GAME, CAT), boardOf(J, GAME, CAT)]);
        return bh && bj && bh.length === 4 && bj.length === 4
            && JSON.stringify(bh) === JSON.stringify(bj);
    }, 20000);
    check('boards converge to all 4 entries, byte-identical on both devices', converged);

    const bh = await boardOf(H, GAME, CAT);
    check('merged board is score-sorted desc', bh && JSON.stringify(bh.map(e => e.score)) === JSON.stringify([100, 90, 80, 70]));
    check('every device’s entries survive (union, not LWW clobber)',
        bh && bh.some(e => e.dev === dH) && bh.some(e => e.dev === dJ));

    // Carve-out: scores keys must NOT be in the LWW sync record store on either side.
    const [rkH, rkJ] = await Promise.all([syncRecordKeys(H), syncRecordKeys(J)]);
    check('sync engine holds NO scores keys (carve-out)',
        !rkH.some(k => k.includes('.scores.')) && !rkJ.some(k => k.includes('.scores.')));

    // Reset watermark: H resets the game, then J pushes again — H must NOT
    // resurrect the pre-reset entries (peers keep their own copies).
    await H.evaluate((key) => {
        localStorage.removeItem(key);
        window.__arcade.leaderboard.noteReset('moon-lit');
    }, KEY);
    await kickLb(J, devOnH);
    const held = await waitFor(async () => {
        const bj = await boardOf(J, GAME, CAT);
        return bj && bj.length === 4; // J still holds its copy
    }, 5000);
    // Give the (debounced) exchange time to (not) resurrect on H.
    await new Promise(r => setTimeout(r, 2500));
    const afterReset = await boardOf(H, GAME, CAT);
    check('J keeps its copy after H’s reset', held);
    check('H does not resurrect pre-reset entries (watermark holds)', afterReset === null || afterReset.length === 0);
} catch (e) {
    check('run completed', false, (e && e.message) || String(e));
} finally {
    await harness.shutdown();
}

process.exit(failed() ? 1 : 0);
