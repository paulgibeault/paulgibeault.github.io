#!/usr/bin/env node
//
// tools/p2p-multiseat-acceptance.mjs — end-to-end proof of the multi-seat
// peer surface: capability flags (E0), targeted sends with routing privacy
// (E1), the per-peer roster (E2), and message metadata (E3).
//
// THREE real launcher pages — a host and two joiners — form the star
// topology every multi-seat game runs on. This is the first automated
// coverage of the multi-joiner relay path: host fan-out, host-bridge
// forwarding of joiner→joiner targeted frames, noRelay containment, and
// per-link interruption/repair while the rest of the table stays live.
//
//   node tools/p2p-multiseat-acceptance.mjs
//
// Self-contained like tools/p2p-acceptance.mjs: own static server (:4797),
// own dead-drop rendezvous carrier (:4796), empty iceServers (loopback
// candidates only), local Google Chrome.
//
// Exit code: 0 if all checks pass, 1 otherwise.

import { startP2PHarness, makeCheck } from './lib/p2p-test-harness.mjs';

const { check, failed } = makeCheck();
const harness = await startP2PHarness({ port: 4797, dropPort: 4796 });
const { bootBridge, deviceIdOf } = harness;

// One context per simulated device: distinct localStorage/IndexedDB, so
// deviceIds and DTLS certificates genuinely differ.
const contexts = {};
for (const label of ['H', 'A', 'B']) {
    contexts[label] = await harness.newDeviceContext();
}

const launcherPage = (label) => harness.launcherPage(label, contexts[label]);

// Each host-side ceremony mints a fresh link while earlier ones stay live —
// the host tapping Host again for another standalone connection
// (openUI({mode:'host'}) → fresh code). waitHost:false — the host's aggregate
// status isn't what a second link proves.
const connectJoiner = (H, J) => harness.ceremony(H, J, { waitHost: false });

try {
    console.log('\nP2P multiseat acceptance — host + two joiners (star topology)\n');

    const H = await launcherPage('H');
    const A = await launcherPage('A');
    const B = await launcherPage('B');

    // 1. Boot the bridge on all three, as a real user would.
    for (const [page, label] of [[H, 'host'], [A, 'joiner A'], [B, 'joiner B']]) {
        await page.evaluate(() => document.getElementById('menu-multiplayer').click());
        await page.evaluate(() => document.getElementById('connections-dialog-new').click());
        await page.waitForFunction('!!window.__arcade.p2p && !!window.__arcade.p2p._addon()', null, { timeout: 15000 });
        check(`${label}: bridge + vendored transport loaded`, true);
    }

    // 2. Two ceremonies against the same host — the second link is minted
    //    while the first stays connected (multi-joiner star).
    await connectJoiner(H, A);
    check('joiner A connected (first link)', true);
    await connectJoiner(H, B);
    await H.waitForFunction(
        `window.__arcade.p2p._addon().peerNode.peers.size === 2`, null, { timeout: 20000 });
    check('joiner B connected (second link) — host holds two live links', true);

    const H_dev = await deviceIdOf(H);
    const A_dev = await deviceIdOf(A);
    const B_dev = await deviceIdOf(B);

    // 3. Identity knowledge must become SYMMETRIC: the host binds both
    //    joiners directly; each joiner binds the host directly and learns
    //    the OTHER joiner through the relay (identity gossip covers the
    //    late-joiner case: A announced before B existed, so A re-announces
    //    when it first sights B).
    await H.waitForFunction((devs) => {
        const links = window.__arcade.p2p._identityLinks();
        return devs.every(d => d in links);
    }, [A_dev, B_dev], { timeout: 15000 });
    check('host: direct identity bindings for both joiners', true);
    await A.waitForFunction((d) => d in window.__arcade.p2p._indirectPeers(), B_dev, { timeout: 15000 });
    check('joiner A knows joiner B (relayed identity)', true);
    await B.waitForFunction((d) => d in window.__arcade.p2p._indirectPeers(), A_dev, { timeout: 15000 });
    check('joiner B knows joiner A (identity gossip re-announce)', true);

    // 4. Mount the fixture game in all three launchers.
    for (const page of [H, A, B]) {
        await page.evaluate(() => {
            window.__arcade.showGame('p2p-test-game', 'tools/fixtures/p2p-test-game/index.html', 'P2P Test');
        });
    }
    const fixtureFrame = (page) => harness.fixtureFrame(page, 'p2p-test-game');
    const fH = await fixtureFrame(H), fA = await fixtureFrame(A), fB = await fixtureFrame(B);
    for (const f of [fH, fA, fB]) {
        await f.waitForFunction(`window.__peerStatus && window.__peerStatus() === 'connected'`, null, { timeout: 10000 });
    }
    check('all three games see peer.status connected', true);

    // 5. E0 — capability flags via the welcome.
    const caps = await fA.evaluate(() => window.__caps());
    check('E0: caps include peer.sendTo / peer.roster / peer.meta',
        ['peer.sendTo', 'peer.roster', 'peer.meta'].every(c => caps.includes(c)), caps.join(','));

    // 6. E2 — roster scope: the host sees both joiners; each joiner sees
    //    exactly the host (other joiners are a game-level concern).
    const rosterH = await fH.evaluate(() => window.__peers());
    check('E2: host roster = both joiners, connected, direct',
        rosterH.length === 2
        && [A_dev, B_dev].every(d => rosterH.some(p => p.deviceId === d && p.status === 'connected' && p.direct === true)),
        JSON.stringify(rosterH.map(p => p.status)));
    const rosterA = await fA.evaluate(() => window.__peers());
    const rosterB = await fB.evaluate(() => window.__peers());
    check('E2: each joiner roster = host only (direct)',
        rosterA.length === 1 && rosterA[0].deviceId === H_dev && rosterA[0].direct === true
        && rosterB.length === 1 && rosterB[0].deviceId === H_dev);

    // 7. E1 test 1 — host → A targeted: A receives (meta 'me', not relayed),
    //    B never does. The broadcast canary AFTER the secret proves order:
    //    once B has the canary, the secret would already have arrived.
    await fH.evaluate((to) => window.__sendTo({ secret: 'for-A-only' }, to), A_dev);
    await fH.evaluate(() => window.__send({ canary: 1 }));
    await fB.waitForFunction(`window.__got.some(p => p && p.canary === 1)`, null, { timeout: 10000 });
    const aSecret = await fA.evaluate(() => window.__rx.filter(r => r.payload && r.payload.secret === 'for-A-only'));
    check('E1.1: host → A targeted — A received exactly once',
        aSecret.length === 1, `${aSecret.length} deliveries`);
    check('E1.1: … attributed to the host, meta { to: me, relayed: false }',
        aSecret.length === 1 && aSecret[0].fromPeer === H_dev
        && aSecret[0].meta.to === 'me' && aSecret[0].meta.relayed === false);
    const bSecret = await fB.evaluate(() => window.__rx.some(r => r.payload && r.payload.secret === 'for-A-only'));
    check('E1.1: … B never received it', !bSecret);

    // 8. E1 test 2 — A → host targeted (the noRelay assertion): the host
    //    receives, B does not — even though every ordinary joiner frame is
    //    relayed to B by the transport hub. The canary rides the normal
    //    relay path, which also proves relayed-frame ATTRIBUTION (B must
    //    name A, not the relaying host) and meta.relayed (E3).
    await fA.evaluate((to) => window.__sendTo({ secret: 'for-host-only' }, to), H_dev);
    await fA.evaluate(() => window.__send({ canary: 2 }));
    await fB.waitForFunction(`window.__got.some(p => p && p.canary === 2)`, null, { timeout: 10000 });
    const hSecret = await fH.evaluate(() => window.__rx.filter(r => r.payload && r.payload.secret === 'for-host-only'));
    check('E1.2: A → host targeted — host received exactly once, meta { to: me }',
        hSecret.length === 1 && hSecret[0].fromPeer === A_dev && hSecret[0].meta.to === 'me');
    const bLeak = await fB.evaluate(() => window.__rx.some(r => r.payload && r.payload.secret === 'for-host-only'));
    check('E1.2: … B never received it (noRelay honored by the hub)', !bLeak);
    const bCanary = await fB.evaluate(() => window.__rx.find(r => r.payload && r.payload.canary === 2));
    check('E3: relayed broadcast attributed to its true sender with meta { relayed: true, to: all }',
        !!bCanary && bCanary.fromPeer === A_dev
        && bCanary.meta.relayed === true && bCanary.meta.to === 'all');

    // 9. E1 test 3 — A → B targeted (host-bridge forward): B receives
    //    exactly once, attributed to A, marked relayed (it did NOT come from
    //    B's direct link partner's own device); the host's GAME never sees it.
    await fA.evaluate((to) => window.__sendTo({ secret: 'A-to-B' }, to), B_dev);
    await fB.waitForFunction(`window.__rx.some(r => r.payload && r.payload.secret === 'A-to-B')`, null, { timeout: 10000 });
    const bDirect = await fB.evaluate(() => window.__rx.filter(r => r.payload && r.payload.secret === 'A-to-B'));
    check('E1.3: A → B via host forward — B received exactly once',
        bDirect.length === 1, `${bDirect.length} deliveries`);
    check('E1.3: … attributed to A (host-stamped), meta { to: me, relayed: true }',
        bDirect.length === 1 && bDirect[0].fromPeer === A_dev
        && bDirect[0].meta.to === 'me' && bDirect[0].meta.relayed === true);
    const hLeak = await fH.evaluate(() => window.__rx.some(r => r.payload && r.payload.secret === 'A-to-B'));
    check('E1.3: … host game never saw the forwarded frame', !hLeak);

    // 9b. Symmetry (identity gossip): the LATE joiner can target the early
    //     one — B joined after A announced, so this only works if gossip
    //     made B's knowledge of A symmetric.
    await fB.evaluate((to) => window.__sendTo({ secret: 'B-to-A' }, to), A_dev);
    await fA.waitForFunction(`window.__rx.some(r => r.payload && r.payload.secret === 'B-to-A')`, null, { timeout: 10000 });
    const aFromB = await fA.evaluate(() => window.__rx.filter(r => r.payload && r.payload.secret === 'B-to-A'));
    check('E1.3b: B → A via host forward (late joiner targets early joiner)',
        aFromB.length === 1 && aFromB[0].fromPeer === B_dev && aFromB[0].meta.to === 'me');

    // 10. E1 test 4 — unknown target refuses, never broadcasts.
    const unknownResult = await A.evaluate(() =>
        window.__arcade.p2p.send('p2p-test-game', { z: 1 }, 'dev-nosuchdevice01'));
    check('E1.4: bridge send to unknown deviceId returns false', unknownResult === false);
    const badToResult = await fA.evaluate(() => window.__sendTo({ z: 2 }, 123));
    check('E1.4: SDK send with a non-string target returns false', badToResult === false);
    await new Promise(r => setTimeout(r, 500));
    const zLeak = await Promise.all([fH, fB].map(f =>
        f.evaluate(() => window.__rx.some(r => r.payload && (r.payload.z === 1 || r.payload.z === 2)))));
    check('E1.4: … and nobody received anything', zLeak.every(v => !v));

    // 11. Envelope isolation — targeted routing fields never leak to games.
    const sawEnvelope = await fB.evaluate(() =>
        window.__rx.some(r => r.payload && typeof r.payload === 'object'
            && (r.payload.arcade !== undefined || r.payload.gameId !== undefined
                || r.payload.to !== undefined || r.payload.fromDevice !== undefined)));
    check('games never see envelope/routing fields (to, fromDevice)', !sawEnvelope);

    // 12. E1 test 5a / E2 — soft blip on ONE link: the host's roster flips
    //     that seat to 'interrupted' and back, while the host's AGGREGATE
    //     stays 'connected' (any-connected-link-wins — documented behavior),
    //     and targeted frames sent during the blip arrive exactly once, in
    //     order.
    const aLink = await H.evaluate((dev) => window.__arcade.p2p._identityLinks()[dev], A_dev);
    const hStatusesBefore = await fH.evaluate(() => window.__statuses.length);
    await H.evaluate((peerId) => {
        window.__arcade.p2p._addon().peerNode._onLinkTrouble(peerId, 'disconnected');
    }, aLink);
    await fH.waitForFunction((dev) =>
        window.__rosterEvents.some(ev => ev.some(p => p.deviceId === dev && p.status === 'interrupted')),
        A_dev, { timeout: 10000 });
    check("E2: host roster flips A's seat to 'interrupted' on a link blip", true);
    for (let i = 1; i <= 3; i++) {
        await fH.evaluate(([to, i]) => window.__sendTo({ blipSeq: i }, to), [A_dev, i]);
    }
    await H.waitForFunction((dev) =>
        window.__arcade.p2p.connectionState(dev) === 'connected', A_dev, { timeout: 20000 });
    await fH.waitForFunction((dev) =>
        window.__rosterEvents.some(ev => ev.some(p => p.deviceId === dev && p.status === 'connected')),
        A_dev, { timeout: 10000 });
    check('E2: … and back to connected after self-heal', true);
    const hSawInterrupted = await fH.evaluate((n) =>
        window.__statuses.slice(n).includes('interrupted'), hStatusesBefore);
    check("E2: host aggregate stayed 'connected' throughout (B's link was up)", !hSawInterrupted);
    await fA.waitForFunction(`window.__rx.filter(r => r.payload && r.payload.blipSeq).length >= 3`, null, { timeout: 15000 });
    const blipSeqs = await fA.evaluate(() =>
        window.__rx.filter(r => r.payload && r.payload.blipSeq).map(r => r.payload.blipSeq));
    check('E1.5a: targeted frames sent during the blip arrived exactly once, in order',
        JSON.stringify(blipSeqs) === '[1,2,3]', JSON.stringify(blipSeqs));

    // 13. E1 test 5b — HARD kill + rendezvous repair: the dead link's outbox
    //     is stashed; a targeted send during the repair must ride the stash
    //     (sendTo's sessionStash path) and arrive exactly once after adoption.
    for (const [page, otherDev] of [[H, A_dev], [A, H_dev]]) {
        await page.evaluate(() => {
            window.__rdvEv = [];
            const r = window.__arcade.p2p._rdv();
            for (const t of ['pair-established', 'reconnecting', 'reconnected', 'gave-up']) {
                r.addEventListener(t, () => window.__rdvEv.push(t));
            }
        });
        await page.evaluate((dev) => window.__arcade.p2p.enableAutoReconnect(dev), otherDev);
    }
    await H.waitForFunction(`window.__rdvEv.includes('pair-established')`, null, { timeout: 10000 });
    await A.waitForFunction(`window.__rdvEv.includes('pair-established')`, null, { timeout: 10000 });
    check('host ↔ A paired for auto-reconnect', true);

    await H.evaluate((peerId) => {
        window.__arcade.p2p._addon().peerNode.peers.get(peerId).dataChannel.close();
    }, aLink);
    await H.waitForFunction((peerId) =>
        window.__arcade.p2p._addon().peerNode.sessionStash.has(peerId), aLink, { timeout: 15000 });
    const stashSend = await fH.evaluate((to) => window.__sendTo({ secret: 'stash-ride' }, to), A_dev);
    check('E1.5b: targeted send while the link is DEAD (stashed) is accepted', stashSend === true);
    await H.waitForFunction(`window.__rdvEv.includes('reconnected')`, null, { timeout: 30000 });
    await A.waitForFunction(`window.__rdvEv.includes('reconnected')`, null, { timeout: 30000 });
    check('host ↔ A rendezvous reconnected through the dead-drop', true);
    await fA.waitForFunction(`window.__rx.some(r => r.payload && r.payload.secret === 'stash-ride')`, null, { timeout: 15000 });
    const stashRx = await fA.evaluate(() => window.__rx.filter(r => r.payload && r.payload.secret === 'stash-ride'));
    check('E1.5b: … delivered exactly once after adoption (stash → resync replay)',
        stashRx.length === 1 && stashRx[0].meta.to === 'me', `${stashRx.length} deliveries`);
    const bStashLeak = await fB.evaluate(() => window.__rx.some(r => r.payload && r.payload.secret === 'stash-ride'));
    check('E1.5b: … B never received it', !bStashLeak);

    // 14. E2 leave signal — a deliberate hang-up must REMOVE the seat from
    //     the roster (removal is the documented leave signal), never pin it
    //     'interrupted': the transport stashes the session, but no repair
    //     episode is running and the peer is paused.
    await H.evaluate((dev) => window.__arcade.p2p.hangUpKnownPeer(dev), A_dev);
    await fH.waitForFunction((dev) => {
        const ev = window.__rosterEvents;
        const last = ev[ev.length - 1] || [];
        return ev.length > 0 && !last.some(p => p.deviceId === dev);
    }, A_dev, { timeout: 10000 });
    const finalRoster = await fH.evaluate(() => window.__peers());
    check("E2: hang-up removes A's seat from the roster (leave signal); B's stays connected",
        !finalRoster.some(p => p.deviceId === A_dev)
        && finalRoster.some(p => p.deviceId === B_dev && p.status === 'connected'),
        JSON.stringify(finalRoster.map(p => [p.deviceId === B_dev ? 'B' : 'A', p.status])));

    await H.close(); await A.close(); await B.close();
} catch (e) {
    console.error('\nFATAL:', e.message);
    check('run completed', false, e.message);
} finally {
    await harness.shutdown();
}

console.log(failed() === 0 ? '\nAll multiseat acceptance checks passed.' : `\n${failed()} check(s) FAILED.`);
process.exit(failed() === 0 ? 0 : 1);
