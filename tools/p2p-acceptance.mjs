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

import { startP2PHarness, makeCheck } from './lib/p2p-test-harness.mjs';

const { check, failed } = makeCheck();
const harness = await startP2PHarness({ port: 4799, dropPort: 4798 });
const { launcherPage, bootBridge, ceremony, fixtureFrame } = harness;

// SEPARATE contexts per simulated device: distinct localStorage + IndexedDB,
// so deviceIds and identity certificates genuinely differ like real devices.
const contextH = await harness.newDeviceContext();
const contextJ = await harness.newDeviceContext();

try {
    console.log('\nP2P acceptance — launcher-owned multiplayer\n');

    const H = await launcherPage('host', contextH);
    const J = await launcherPage('joiner', contextJ);

    // 1. Load the bridge on both, as a real user would (harness clicks the
    //    Multiplayer menu → "New connection", which runs ensureAddon()).
    for (const [page, label] of [[H, 'host'], [J, 'joiner']]) {
        await bootBridge(page);
        check(`${label}: bridge + vendored transport loaded (no CDN)`, true);
    }

    // 2. Signaling ceremony at the transport level (stands in for QR / link
    //    tennis — see p2p/PROTOCOL.md §4). This suite also asserts the
    //    packed-payload shape the human-carried exchange depends on.
    const { packedOffer, packedAnswer } = await ceremony(H, J);
    check('host: packed offer produced', /^1\.[A-Za-z0-9_-]+$/.test(packedOffer), `${packedOffer.length} chars`);
    check('joiner: packed answer produced', /^1\.[A-Za-z0-9_-]+$/.test(packedAnswer), `${packedAnswer.length} chars`);

    // 3. Bridge must report SDK-vocabulary 'connected' on both sides
    //    (ceremony() already awaited both).
    check('both launchers report status connected (data channel open)', true);

    // 4. Mount the fixture game in both launchers — AFTER connecting, so the
    //    welcome handshake must deliver peerStatus 'connected'.
    for (const page of [H, J]) {
        await page.evaluate(() => {
            window.__arcade.showGame('p2p-test-game', 'tools/fixtures/p2p-test-game/index.html', 'P2P Test');
        });
    }
    const fH = await fixtureFrame(H, 'p2p-test-game'), fJ = await fixtureFrame(J, 'p2p-test-game');
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

    // 7. Resilience (transport v1.7): a link blip must surface to games as
    //    'interrupted' — never 'idle' — sends must keep working (queued), and
    //    the link must heal itself without any ceremony.
    await H.evaluate(() => {
        const pm = window.__arcade.p2p._addon().peerNode;
        const peerId = Array.from(pm.peers.keys())[0];
        pm._onLinkTrouble(peerId, 'disconnected'); // what a real ICE blip reports
    });
    await fH.waitForFunction(`window.__statuses.includes('interrupted')`, null, { timeout: 10000 });
    check('game sees SDK status interrupted during a link blip', true);

    const sentDuring = await fH.evaluate(() => window.__send({ hello: 'sent-during-blip' }));
    check('game send during interruption is accepted', sentDuring === true);

    await fJ.waitForFunction(
        `window.__got.some(p => p && p.hello === 'sent-during-blip')`,
        null, { timeout: 10000 }
    );
    check('message sent during interruption is delivered', true);

    // Heartbeat/ack traffic proves the path — the link must recover on its own.
    await fH.waitForFunction(`window.__peerStatus() === 'connected'`, null, { timeout: 15000 });
    check('link self-heals back to connected without a new ceremony', true);

    const sawIdle = await fH.evaluate(() => window.__statuses.includes('idle'));
    check("game never saw 'idle' during the blip", !sawIdle);

    // 8. Identity pinning (transport v1.8): the host must have recorded the
    //    joiner's device with the DTLS fingerprint of the direct link.
    const FP_RE = /^[0-9A-F]{2}(:[0-9A-F]{2}){19,63}$/;
    await H.waitForFunction(`(() => {
        const raw = localStorage.getItem('arcade.v1._meta.knownPeers');
        if (!raw) return false;
        const known = JSON.parse(raw);
        return Object.values(known).some(p => typeof p.fingerprint === 'string' && p.fingerprint.includes(':'));
    })()`, null, { timeout: 10000 });
    const hostView = await H.evaluate(() => {
        const known = JSON.parse(localStorage.getItem('arcade.v1._meta.knownPeers'));
        const myId = localStorage.getItem('arcade.v1._meta.deviceId');
        const entries = Object.entries(known);
        return { entries, myId };
    });
    const [peerDeviceId, peerRecord] = hostView.entries[0];
    check('host recorded the joiner with a well-formed fingerprint',
        FP_RE.test(peerRecord.fingerprint || ''), (peerRecord.fingerprint || 'none').slice(0, 12) + '…');
    check('recorded deviceId differs from own (distinct devices)', peerDeviceId !== hostView.myId);

    // 9. Pinning policy: a DIFFERENT fingerprint later must raise the change
    //    NOTICE, but must NOT overwrite the trusted pin — the new fingerprint is
    //    held as `pinPendingFingerprint` until the user explicitly re-trusts.
    //    This is what stops an imposter's *declined* fingerprint from being
    //    laundered into the pin across a reload: the suspicion is persisted on
    //    the record, not held only in the RAM fingerprintSuspects set.
    const policy = await H.evaluate(() => {
        const rec = window.__arcade.p2p._recordPeerIdentity;
        const fpA = 'AA:' + Array(31).fill('11').join(':');
        const fpB = 'BB:' + Array(31).fill('22').join(':');
        const first = rec('dev-policytest01', 'Pin Tester', fpA);
        const same = rec('dev-policytest01', 'Pin Tester', fpA);
        const changed = rec('dev-policytest01', 'Pin Tester', fpB);
        const stored = JSON.parse(localStorage.getItem('arcade.v1._meta.knownPeers'))['dev-policytest01'];
        return { first: first.fingerprintChanged, same: same.fingerprintChanged,
                 changed: changed.fingerprintChanged, storedFp: stored.fingerprint,
                 pendingFp: stored.pinPendingFingerprint, changedAt: stored.fingerprintChangedAt };
    });
    check('first sighting records without a change flag', policy.first === false);
    check('re-announce with the same fingerprint stays quiet', policy.same === false);
    check('changed fingerprint flagged, trusted pin kept, new fp held pending (secure TOFU)',
        policy.changed === true && policy.storedFp.startsWith('AA:')
        && (policy.pendingFp || '').startsWith('BB:') && !!policy.changedAt);

    // 9b. Malformed deviceIds must be rejected before touching knownPeers —
    //     ids are peer-chosen, so only machine-generated shapes are trusted.
    const malformed = await H.evaluate(() => {
        const rec = window.__arcade.p2p._recordPeerIdentity;
        const fp = 'CC:' + Array(31).fill('33').join(':');
        const results = [
            rec('<img src=x onerror=alert(1)>', 'Evil', fp),
            rec('not a uuid at all', 'Evil', fp),
            rec('x'.repeat(200), 'Evil', fp),
            rec(12345, 'Evil', fp)
        ];
        const known = JSON.parse(localStorage.getItem('arcade.v1._meta.knownPeers') || '{}');
        const leaked = Object.keys(known).some(id =>
            id.includes('<') || id.includes(' ') || id.length > 64);
        return { allRejected: results.every(r => r === null), leaked };
    });
    check('malformed deviceIds are rejected (validation gate)',
        malformed.allRejected && !malformed.leaked);

    // 10. Rendezvous auto-reconnect (PROTOCOL.md §7): both sides opt in,
    //     the connection is killed COMPLETELY, and the session must come
    //     back through the dead-drop with zero interaction — games seeing
    //     only interrupted → connected, with mid-repair sends delivered.
    for (const page of [H, J]) {
        await page.evaluate(() => {
            window.__rdvEv = [];
            const r = window.__arcade.p2p._rdv();
            for (const t of ['pair-established', 'reconnecting', 'reconnected', 'gave-up']) {
                r.addEventListener(t, () => window.__rdvEv.push(t));
            }
        });
        await page.evaluate(() => {
            const known = JSON.parse(localStorage.getItem('arcade.v1._meta.knownPeers'));
            const peerDeviceId = Object.keys(known).find(id => id !== 'dev-policytest01');
            return window.__arcade.p2p.enableAutoReconnect(peerDeviceId);
        });
    }
    await H.waitForFunction(`window.__rdvEv.includes('pair-established')`, null, { timeout: 10000 });
    await J.waitForFunction(`window.__rdvEv.includes('pair-established')`, null, { timeout: 10000 });
    check('both sides paired for auto-reconnect (secrets derived over the live channel)', true);

    const statusCountH = await fH.evaluate(() => window.__statuses.length);
    await H.evaluate(() => {
        const entry = Array.from(window.__arcade.p2p._addon().peerNode.peers.values())
            .find(p => p.status === 'connected');
        entry.dataChannel.close(); // hard kill: both sides go terminal
    });
    await fH.waitForFunction(`window.__peerStatus() === 'interrupted'`, null, { timeout: 10000 });
    const sentDuringRepair = await fH.evaluate(() => window.__send({ hello: 'during-dead-link-repair' }));
    check('game send while the link is DEAD (repairing) is accepted', sentDuringRepair === true);

    for (const [page, label] of [[H, 'host'], [J, 'joiner']]) {
        await page.waitForFunction(`window.__rdvEv.includes('reconnected')`, null, { timeout: 30000 });
        check(`${label}: rendezvous reconnected through the dead-drop`, true);
    }
    await fH.waitForFunction(`window.__peerStatus() === 'connected'`, null, { timeout: 15000 });
    await fJ.waitForFunction(
        `window.__got.some(p => p && p.hello === 'during-dead-link-repair')`,
        null, { timeout: 15000 }
    );
    check('message sent during the dead-link repair was delivered after adoption', true);

    const sawIdleDuringRepair = await fH.evaluate(
        (n) => window.__statuses.slice(n).includes('idle'), statusCountH);
    check("game never saw 'idle' across the total connection loss", !sawIdleDuringRepair);

    // 11. One-tap reconnect entry: openUI({mode:'host'}) must land on a fresh
    //     invite code — no Host/Join choice screen in between.
    await H.evaluate(() => window.__arcade.openMultiplayerPanel({ mode: 'host' }));
    await H.waitForFunction(`(() => {
        const qr = document.getElementById('p2p-qr-container');
        const choice = document.getElementById('p2p-choice-buttons') || { style: {} };
        return qr && qr.style.display === 'block';
    })()`, null, { timeout: 15000 });
    const choiceHidden = await H.evaluate(() => {
        const overlay = document.getElementById('p2p-modal-overlay');
        const host = document.getElementById('p2p-btn-host');
        return overlay.style.display === 'flex' && (!host || host.offsetParent === null);
    });
    check('mode:host opens straight to a fresh invite code (no choice screen)', choiceHidden);

    await H.close(); await J.close();
} catch (e) {
    console.error('\nFATAL:', e.message);
    check('run completed', false, e.message);
} finally {
    await harness.shutdown();
}

console.log(failed() === 0 ? '\nAll P2P acceptance checks passed.' : `\n${failed()} check(s) FAILED.`);
process.exit(failed() === 0 ? 0 : 1);
