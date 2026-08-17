#!/usr/bin/env node
//
// tools/p2p-multiseat-acceptance.mjs — end-to-end proof of the multi-seat
// peer surface: capability flags (E0), targeted sends with routing privacy
// (E1), the per-peer roster (E2), and message metadata (E3).
//
// THREE real launcher pages — a host and two joiners — form the shape every
// multi-seat game runs on: two joiners adjacent to the host and NOT to each
// other. Since the relay was removed (plans/tables-2026-08.md) the sharp
// half of this suite is what the host does NOT do — it forwards nothing, so
// each joiner's world is exactly its own link — alongside targeted-send
// privacy and per-link interruption/repair while the rest of the table stays
// live. Routing between joiners is the GAME's job now, host-authoritatively,
// which is what every game here was already doing.
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

    // 3. Identity knowledge is PER LINK, and stops there. The host binds
    //    both joiners directly; each joiner binds only the host. The v1.13
    //    suite asserted the opposite here — that gossip through the hub made
    //    A and B know each other — and that knowledge was the problem: it
    //    named devices a joiner could never actually reach except through a
    //    forwarding path that no game wanted (and that the flagship game
    //    rejected as spoofed). It is a NEGATION now.
    await H.waitForFunction((devs) => {
        const links = window.__arcade.p2p._identityLinks();
        return devs.every(d => d in links);
    }, [A_dev, B_dev], { timeout: 15000 });
    check('host: direct identity bindings for both joiners', true);
    await A.waitForFunction((d) => d in window.__arcade.p2p._identityLinks(), H_dev, { timeout: 15000 });
    await B.waitForFunction((d) => d in window.__arcade.p2p._identityLinks(), H_dev, { timeout: 15000 });
    check('each joiner bound the host directly', true);
    await new Promise(r => setTimeout(r, 1500)); // give any (wrong) gossip time to land
    const aLinks = await A.evaluate(() => Object.keys(window.__arcade.p2p._identityLinks()));
    const bLinks = await B.evaluate(() => Object.keys(window.__arcade.p2p._identityLinks()));
    check('joiner A never learns joiner B, and vice versa (no gossip through the host)',
        aLinks.length === 1 && aLinks[0] === H_dev && bLinks.length === 1 && bLinks[0] === H_dev,
        JSON.stringify([aLinks, bLinks]));

    // 4. Mount the fixture game in all three launchers, then OPEN it on both
    //    of the host's links — one invite per connection, each accepted by
    //    the joiner. A connection is not permission to play (D4), so this is
    //    what turns two live links into one three-seat table.
    for (const page of [H, A, B]) {
        await page.evaluate(() => {
            window.__arcade.showGame('p2p-test-game', 'tools/fixtures/p2p-test-game/index.html', 'P2P Test');
        });
    }
    const fixtureFrame = (page) => harness.fixtureFrame(page, 'p2p-test-game');
    const fH = await fixtureFrame(H), fA = await fixtureFrame(A), fB = await fixtureFrame(B);
    await fH.waitForFunction(`window.__peerStatus && typeof window.__peers === 'function'`, null, { timeout: 10000 });
    check("the host's game is 'idle' with two live links and no open scope",
        (await fH.evaluate(() => window.__peerStatus())) === 'idle');
    const invited = await H.evaluate(() => window.__arcade.p2p.inviteGame('p2p-test-game'));
    check('one inviteGame proposed to BOTH live connections', invited === 2, String(invited));
    for (const J of [A, B]) {
        await J.evaluate((d) => window.__arcade.p2p.acceptGameInvite(d, 'p2p-test-game'), H_dev);
    }
    for (const f of [fH, fA, fB]) {
        await f.waitForFunction(`window.__peerStatus && window.__peerStatus() === 'connected'`, null, { timeout: 10000 });
    }
    check('all three games see peer.status connected once both scopes are open', true);
    const scopes = await H.evaluate(() => window.__arcade.p2p._gameScopes()['p2p-test-game']);
    check("the host's scope holds both joiners",
        scopes.length === 2 && [A_dev, B_dev].every(d => scopes.includes(d)), JSON.stringify(scopes));

    // 5. E0 — capability flags via the welcome.
    const caps = await fA.evaluate(() => window.__caps());
    check('E0: caps include peer.sendTo / peer.roster / peer.meta',
        ['peer.sendTo', 'peer.roster', 'peer.meta'].every(c => caps.includes(c)), caps.join(','));

    // 6. E2 — the roster contract: EVERY entry is direct, and there may be
    //    more than one. The host's two entries are the "more than one" case a
    //    multi-seat game must be written for; each joiner's single entry is
    //    the host, which is why a joiner needs no lobby frame to identify it.
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
    check('E2: every roster entry everywhere is direct:true',
        [...rosterH, ...rosterA, ...rosterB].every(p => p.direct === true));

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

    // 8. E1 test 2 / E3 — a joiner's BROADCAST reaches its one direct link
    //    and stops there. The v1.13 suite used B as an ordering canary here,
    //    because a joiner broadcast was fanned out to every other joiner by
    //    the hub. Nothing is fanned out any more, so B is the assertion
    //    instead of the clock: the host is the only receiver, and the frame
    //    arrives marked NOT relayed, which is what a game's spoof check reads.
    await fA.evaluate((to) => window.__sendTo({ secret: 'for-host-only' }, to), H_dev);
    await fA.evaluate(() => window.__send({ canary: 2 }));
    await fH.waitForFunction(`window.__got.some(p => p && p.canary === 2)`, null, { timeout: 10000 });
    const hSecret = await fH.evaluate(() => window.__rx.filter(r => r.payload && r.payload.secret === 'for-host-only'));
    check('E1.2: A → host targeted — host received exactly once, meta { to: me }',
        hSecret.length === 1 && hSecret[0].fromPeer === A_dev && hSecret[0].meta.to === 'me');
    const bLeak = await fB.evaluate(() => window.__rx.some(r => r.payload && r.payload.secret === 'for-host-only'));
    check('E1.2: … B never received it', !bLeak);
    const hCanary = await fH.evaluate(() => window.__rx.find(r => r.payload && r.payload.canary === 2));
    check('E3: the broadcast reached the host, attributed to A, meta { relayed: false, to: all }',
        !!hCanary && hCanary.fromPeer === A_dev
        && hCanary.meta.relayed === false && hCanary.meta.to === 'all');
    check("E3: … and never reached B — a joiner's broadcast is not fanned out",
        !(await fB.evaluate(() => window.__rx.some(r => r.payload && r.payload.canary === 2))));

    // 9. E1 test 3 — A → B targeted REFUSES. A holds no link to B and never
    //    learns of B at all, so there is no way to name it and nothing that
    //    would carry the frame. This is the D2 dead end, and it is meant to
    //    surface as copy at the game layer ("ask the host to connect with
    //    that device"), never as a transport that quietly bridges it.
    const aToB = await A.evaluate((to) =>
        window.__arcade.p2p.send('p2p-test-game', { secret: 'A-to-B' }, to), B_dev);
    check('E1.3: A → B targeted is refused by the bridge (no link, nothing forwards)', aToB === false);
    // The SDK still answers true — postMessage is one-way, so a game learns
    // "handed to the launcher", never "delivered". Send it that way too and
    // prove the launcher drops it rather than fanning it out.
    await fA.evaluate((to) => window.__sendTo({ secret: 'A-to-B' }, to), B_dev);
    await new Promise(r => setTimeout(r, 800));
    check('E1.3: … and nobody received it — not B, not the host',
        !(await fB.evaluate(() => window.__rx.some(r => r.payload && r.payload.secret === 'A-to-B')))
        && !(await fH.evaluate(() => window.__rx.some(r => r.payload && r.payload.secret === 'A-to-B'))));

    // 9b. The host CAN reach both, because it holds both links — which is
    //     why a multi-seat game is host-authoritative: the host is the only
    //     device that can route, so routing is its job, in game code.
    for (const [dev, tag] of [[A_dev, 'to-A'], [B_dev, 'to-B']]) {
        await fH.evaluate(([to, t]) => window.__sendTo({ relayJob: t }, to), [dev, tag]);
    }
    await fA.waitForFunction(`window.__rx.some(r => r.payload && r.payload.relayJob === 'to-A')`, null, { timeout: 10000 });
    await fB.waitForFunction(`window.__rx.some(r => r.payload && r.payload.relayJob === 'to-B')`, null, { timeout: 10000 });
    check('E1.3b: the host reaches each seat on its own link (game-layer routing works)', true);
    check('E1.3b: … and neither joiner saw the other seat\'s frame',
        !(await fA.evaluate(() => window.__rx.some(r => r.payload && r.payload.relayJob === 'to-B')))
        && !(await fB.evaluate(() => window.__rx.some(r => r.payload && r.payload.relayJob === 'to-A'))));

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
