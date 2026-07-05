#!/usr/bin/env node
//
// tools/p2p-acceptance.mjs — end-to-end proof that the LAUNCHER owns the
// multiplayer connection and games integrate only with the framework.
//
// Two real launcher pages (simulating two devices) connect over a real
// RTCPeerConnection using the vendored packed-payload signaling. Then a
// fixture game — which talks ONLY to Arcade.peer.* — is mounted in each
// launcher and must exchange messages both ways.
//
//   node tools/p2p-acceptance.mjs
//
// Self-contained: starts its own static server on :4799, uses the locally
// installed Google Chrome (channel 'chrome'), forces empty iceServers so no
// external STUN is contacted.
//
// Exit code: 0 if all checks pass, 1 otherwise.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4799;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(name, ok, detail) {
    const mark = ok ? '✓' : '✗';
    console.log(`  ${mark} ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures++;
}

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', ROOT], {
    stdio: 'ignore'
});
for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/index.html`)).ok) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 100));
}

const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--disable-features=WebRtcHideLocalIpsWithMdns']
});
const context = await browser.newContext();
// Hermetic: never touch external STUN; loopback host candidates suffice.
await context.addInitScript(`
    const OrigRTC = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends OrigRTC {
        constructor(cfg = {}) { super({ ...cfg, iceServers: [] }); }
    };
`);

async function launcherPage(label) {
    const page = await context.newPage();
    page.on('pageerror', err => console.error(`  [${label} pageerror]`, err.message));
    await page.goto(`${BASE}/`);
    await page.waitForFunction('!!window.__arcade && !!window.__arcade.showGame');
    return page;
}

try {
    console.log('\nP2P acceptance — launcher-owned multiplayer\n');

    const H = await launcherPage('host');
    const J = await launcherPage('joiner');

    // 1. Load the bridge on both (as the Multiplayer menu item would).
    for (const [page, label] of [[H, 'host'], [J, 'joiner']]) {
        await page.evaluate(() => document.getElementById('menu-multiplayer').click());
        await page.waitForFunction('!!window.__arcade.p2p && !!window.__arcade.p2p._addon()', null, { timeout: 15000 });
        check(`${label}: bridge + vendored transport loaded (no CDN)`, true);
    }

    // 2. Signaling ceremony at the transport level (stands in for QR / link
    //    tennis, which the QRCodeP2P suite covers end-to-end).
    const packedOffer = await H.evaluate(async () => {
        const { ConnectionUtils } = await import('./p2p/p2p-core.js');
        const addon = window.__arcade.p2p._addon();
        return await ConnectionUtils.encodePayload(await addon.peerNode.createOffer());
    });
    check('host: packed offer produced', /^1\.[A-Za-z0-9_-]+$/.test(packedOffer), `${packedOffer.length} chars`);

    const packedAnswer = await J.evaluate(async (packed) => {
        const { ConnectionUtils } = await import('./p2p/p2p-core.js');
        const addon = window.__arcade.p2p._addon();
        const offer = await ConnectionUtils.decodePayload(packed);
        return await ConnectionUtils.encodePayload(await addon.peerNode.createAnswer(offer));
    }, packedOffer);
    check('joiner: packed answer produced', /^1\.[A-Za-z0-9_-]+$/.test(packedAnswer), `${packedAnswer.length} chars`);

    await H.evaluate(async (packed) => {
        const { ConnectionUtils } = await import('./p2p/p2p-core.js');
        await window.__arcade.p2p._addon().peerNode.acceptAnswer(await ConnectionUtils.decodePayload(packed));
    }, packedAnswer);

    // 3. Bridge must report SDK-vocabulary 'connected' on both sides.
    await H.waitForFunction(`window.__arcade.p2p.status() === 'connected'`, null, { timeout: 20000 });
    await J.waitForFunction(`window.__arcade.p2p.status() === 'connected'`, null, { timeout: 20000 });
    check('both launchers report status connected (data channel open)', true);

    // 4. Mount the fixture game in both launchers — AFTER connecting, so the
    //    welcome handshake must deliver peerStatus 'connected'.
    for (const page of [H, J]) {
        await page.evaluate(() => {
            window.__arcade.showGame('p2p-test-game', 'tools/fixtures/p2p-test-game/index.html', 'P2P Test');
        });
    }
    const frameOf = (page) => page.frames().find(f => f.url().includes('p2p-test-game'));
    await H.waitForFunction(`window.frames.length > 0`);
    const fH = frameOf(H), fJ = frameOf(J);
    await fH.waitForFunction(`window.__peerStatus && window.__peerStatus() === 'connected'`, null, { timeout: 10000 });
    await fJ.waitForFunction(`window.__peerStatus && window.__peerStatus() === 'connected'`, null, { timeout: 10000 });
    check('game sees peer.status connected via SDK handshake alone', true);

    // 5. Game-to-game messages through the full stack, both directions.
    await fH.evaluate(() => window.__send({ hello: 'from-host', n: 42 }));
    await fJ.waitForFunction(
        `window.__got.length > 0 && window.__got[0].hello === 'from-host' && window.__got[0].n === 42`,
        null, { timeout: 10000 }
    );
    check('host game → joiner game (envelope stripped, payload intact)', true);

    await fJ.evaluate(() => window.__send({ hello: 'from-joiner' }));
    await fH.waitForFunction(
        `window.__got.length > 0 && window.__got[0].hello === 'from-joiner'`,
        null, { timeout: 10000 }
    );
    check('joiner game → host game', true);

    // 6. The fixture must never have seen transport internals.
    const sawEnvelope = await fJ.evaluate(() =>
        window.__got.some(p => p && (p.arcade !== undefined || p.gameId !== undefined)));
    check('games never see the launcher envelope', !sawEnvelope);

    await H.close(); await J.close();
} catch (e) {
    console.error('\nFATAL:', e.message);
    failures++;
} finally {
    await browser.close();
    server.kill();
}

console.log(failures === 0 ? '\nAll P2P acceptance checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
