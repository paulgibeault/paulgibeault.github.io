#!/usr/bin/env node
//
// tools/p2p-multiparty-acceptance.mjs — end-to-end proof of OPEN-GAME SCOPES
// (plans/tables-2026-08.md), the model that replaced parties.
//
// This suite used to prove the opposite thing. It proved that one device
// could lead one party while a member of another, that identity gossip never
// crossed a party boundary, and that a game bound to exactly one party — a
// pre-declared, RAM-only, user-invisible object that decided which devices a
// game could see. The 2026-08-16 field test is what that object cost: a
// device paired through the wrong door was healthy, reachable, and
// structurally invisible to the game, with no error and no way to repair it.
// The party is deleted; this file is the proof of what took its place.
//
// The model under test, in one line: a CONNECTION is durable and symmetric,
// and game g is OPEN on connection L when both ends agreed to play it.
//
// Topology (the field-test shape, which is also the shape that used to fail):
//
//        B ──── A ──── C          A is paired with both. B and C are NOT
//                                 paired with each other, and never will be.
//
// Proven here, end to end through real launchers + the SDK:
//   S1  a game is 'idle' with an empty roster on live links until a scope
//       opens — a connection is not permission to play
//   S2  invite → accept opens it per connection; B and C each see ONLY A,
//       and A sees both (the multi-direct roster contract)
//   S3  D1 inbound: a frame from B reaches A's iframe and is NEVER re-emitted
//       to C, whatever it claims; a frame for a game that is not open on the
//       arrival link is dropped and diag-logged
//   S4  D1 outbound: send() fans only to links with the game open; a targeted
//       send to a device the game is not open with is refused
//   S5  two games open CONCURRENTLY on one connection, each with its own
//       roster, status and traffic — the thing a single-party attachment
//       could not express
//   S6  scope death on link death, and the pairing left untouched by it
//   S7  the retired peer.party trio still answers null / [] / null, which is
//       what lets every shipped game keep running unmodified
//
//   node tools/p2p-multiparty-acceptance.mjs
//
// Self-contained like the other p2p suites: own static server (:4805), own
// dead-drop (:4806), local ICE only, local Google Chrome.
//
// Exit code: 0 if all checks pass, 1 otherwise.

import { startP2PHarness, makeCheck, waitFor } from './lib/p2p-test-harness.mjs';

const { check, failed } = makeCheck();
const harness = await startP2PHarness({ port: 4805, dropPort: 4806 });
const { launcherPage, deviceIdOf, ceremony, openScope, fixtureFrame } = harness;

const GAME = 'p2p-test-game';
const GAME_SRC = 'tools/fixtures/p2p-test-game/index.html';
// A second gameId served by the same fixture: S5 needs two games open at once
// on one connection, and what makes them different is only their id.
const GAME2 = 'p2p-test-game-2';

const contexts = {};
for (const label of ['A', 'B', 'C']) contexts[label] = await harness.newDeviceContext();

try {
    console.log('\nP2P scope acceptance — open games, not parties\n');

    const A = await launcherPage('A', contexts.A);
    const B = await launcherPage('B', contexts.B);
    const C = await launcherPage('C', contexts.C);
    for (const page of [A, B, C]) await harness.bootBridge(page, { closeDialog: true });

    // ── Two independent ceremonies, in the order the field test used ──────
    // A ↔ B, then A ↔ C. Under the party model these two doors produced two
    // disjoint stars and the second guest could not see the first's game.
    // There is no door to get wrong any more: a ceremony makes a connection.
    await ceremony(A, B, { waitHost: true });
    await ceremony(A, C, { waitHost: false });
    await A.waitForFunction(
        `window.__arcade.p2p._addon().peerNode.statusSummary().connected === 2`, null, { timeout: 20000 });
    check('A holds two connections; B and C hold one each', true);

    const A_dev = await deviceIdOf(A);
    const B_dev = await deviceIdOf(B);
    const C_dev = await deviceIdOf(C);

    await A.waitForFunction((devs) => {
        const links = window.__arcade.p2p._identityLinks();
        return devs.every(d => d in links);
    }, [B_dev, C_dev], { timeout: 15000 });
    for (const [page, dev] of [[B, A_dev], [C, A_dev]]) {
        await page.waitForFunction((d) => d in window.__arcade.p2p._identityLinks(), dev, { timeout: 15000 });
    }
    check('identity bindings complete on all three devices', true);

    // B and C are not adjacent, and nothing about A's two connections tells
    // either of them the other exists. Under the party model a member DID
    // learn its fellow members (through the hub's relay) — it could name
    // devices it could never reach directly, which is precisely the
    // asymmetry the field test surfaced.
    await new Promise(r => setTimeout(r, 1500)); // give any (wrong) gossip time to land
    const bKnows = await B.evaluate(() => Object.keys(window.__arcade.p2p._identityLinks()));
    const cKnows = await C.evaluate(() => Object.keys(window.__arcade.p2p._identityLinks()));
    check('B and C never learn of each other (nothing gossips through A)',
        bKnows.length === 1 && bKnows[0] === A_dev && cKnows.length === 1 && cKnows[0] === A_dev,
        JSON.stringify([bKnows, cKnows]));

    // ── S1: a connection is not permission to play ────────────────────────
    for (const page of [A, B, C]) {
        await page.evaluate((src) => {
            window.__arcade.showGame('p2p-test-game', src, 'P2P Test');
        }, GAME_SRC);
    }
    const fA = await fixtureFrame(A, GAME);
    const fB = await fixtureFrame(B, GAME);
    const fC = await fixtureFrame(C, GAME);
    for (const f of [fA, fB, fC]) {
        await f.waitForFunction(`window.__peerStatus && typeof window.__peers === 'function'`, null, { timeout: 10000 });
    }
    const idleAll = await Promise.all([fA, fB, fC].map(async (f) => ({
        status: await f.evaluate(() => window.__peerStatus()),
        peers: (await f.evaluate(() => window.__peers())).length
    })));
    check("S1: every game reads 'idle' with an empty roster on live links",
        idleAll.every((s) => s.status === 'idle' && s.peers === 0), JSON.stringify(idleAll));
    const preSend = await fB.evaluate(() => window.__send({ preScope: 'B' }));
    check('S1: send() before any scope is open is refused', preSend === false);

    // ── S2: open it per connection, and read the roster ───────────────────
    const proposals = await openScope(A, B, GAME);
    check('S2: A proposed to both connections; B accepted its own', proposals === 2, String(proposals));
    await fA.waitForFunction(`window.__peerStatus() === 'connected'`, null, { timeout: 10000 });
    const rosterAfterB = await fA.evaluate(() => window.__peers());
    check("S2: with only B accepted, A's roster is B alone",
        rosterAfterB.length === 1 && rosterAfterB[0].deviceId === B_dev, JSON.stringify(rosterAfterB));
    check("S2: … and C's game is still 'idle' — an invite it never answered opens nothing",
        (await fC.evaluate(() => window.__peerStatus())) === 'idle');

    await C.evaluate(([d, g]) => window.__arcade.p2p.acceptGameInvite(d, g), [A_dev, GAME]);
    await fC.waitForFunction(`window.__peerStatus() === 'connected'`, null, { timeout: 10000 });
    await waitFor(async () => (await fA.evaluate(() => window.__peers())).length === 2, 10000);

    const rosterA = await fA.evaluate(() => window.__peers());
    const rosterB = await fB.evaluate(() => window.__peers());
    const rosterC = await fC.evaluate(() => window.__peers());
    check('S2: A sees BOTH B and C — more than one entry, every one direct',
        rosterA.length === 2 && [B_dev, C_dev].every(d =>
            rosterA.some(p => p.deviceId === d && p.direct === true && p.status === 'connected')),
        JSON.stringify(rosterA.map(p => [p.deviceId === B_dev ? 'B' : 'C', p.status, p.direct])));
    check('S2: B sees ONLY A, C sees ONLY A',
        rosterB.length === 1 && rosterB[0].deviceId === A_dev && rosterB[0].direct === true
        && rosterC.length === 1 && rosterC[0].deviceId === A_dev && rosterC[0].direct === true,
        JSON.stringify([rosterB, rosterC]));
    check('S2: onReady fired on every seat once its own scope opened',
        (await fA.evaluate(() => window.__readyEvents.length > 0))
        && (await fB.evaluate(() => window.__readyEvents.length > 0))
        && (await fC.evaluate(() => window.__readyEvents.length > 0)));
    check('S2: the pre-scope broadcast never arrived anywhere',
        !(await fA.evaluate(() => window.__got.some(p => p && p.preScope))));

    // ── S3: D1 inbound — delivered locally, re-emitted nowhere ────────────
    // The load-bearing check of the whole redesign, stated as a negation. B
    // broadcasts; A's iframe gets it; C must never see it, even though A
    // holds a live link to C with the SAME game open on it. Under the party
    // model this frame was fanned out to C by the transport.
    await fB.evaluate(() => window.__send({ fromB: 1 }));
    await fA.waitForFunction(`window.__rx.some(r => r.payload && r.payload.fromB === 1)`, null, { timeout: 10000 });
    const aFromB = await fA.evaluate(() => window.__rx.filter(r => r.payload && r.payload.fromB === 1));
    check("S3: B's broadcast reaches A exactly once, attributed to B, meta { relayed: false, to: all }",
        aFromB.length === 1 && aFromB[0].fromPeer === B_dev
        && aFromB[0].meta.relayed === false && aFromB[0].meta.to === 'all',
        JSON.stringify(aFromB.map(r => [r.fromPeer === B_dev ? 'B' : r.fromPeer, r.meta])));
    await new Promise(r => setTimeout(r, 800));
    check('S3: … and is NEVER re-emitted to C', !(await fC.evaluate(() =>
        window.__rx.some(r => r.payload && r.payload.fromB === 1))));

    // A frame naming a game that is NOT open on the arrival link is dropped
    // and diag-logged. Hand-built and pushed straight down the wire, because
    // this is the frame a hostile peer sends: gameId is a selector among the
    // games this link already agreed to, never a grant.
    await A.evaluate(() => { window.__diagBefore = window.__arcadeDiag.entries().length; });
    await B.evaluate((g) => {
        const addon = window.__arcade.p2p._addon();
        const peerId = Object.values(window.__arcade.p2p._identityLinks())[0];
        addon.sendTo(peerId, { arcade: 1, gameId: g, payload: { smuggled: 1 } });
    }, GAME2);
    await new Promise(r => setTimeout(r, 800));
    const dropLine = await A.evaluate((g) => window.__arcadeDiag.entries()
        .slice(window.__diagBefore)
        .some(e => e.tag === 'bridge' && e.msg.includes('dropped game frame for ' + g)), GAME2);
    check('S3: a frame for a game not open on the arrival link is dropped and diag-logged', dropLine);
    check('S3: … and it opened no scope by naming one',
        !(GAME2 in (await A.evaluate(() => window.__arcade.p2p._gameScopes()))));

    // ── S4: D1 outbound ───────────────────────────────────────────────────
    // A broadcasts: both its links have the game open, so both seats get it.
    await fA.evaluate(() => window.__send({ fromA: 1 }));
    for (const f of [fB, fC]) {
        await f.waitForFunction(`window.__rx.some(r => r.payload && r.payload.fromA === 1)`, null, { timeout: 10000 });
    }
    check('S4: A\'s broadcast fans to every link with the game open (both seats)', true);
    // B targets C, which it cannot name and could not reach if it could.
    check('S4: a targeted send to a device this game is not open with is refused',
        (await B.evaluate(([g, d]) => window.__arcade.p2p.send(g, { x: 1 }, d), [GAME, C_dev])) === false);
    check('S4: … and a targeted send to a device on an open scope is accepted',
        (await A.evaluate(([g, d]) => window.__arcade.p2p.send(g, { priv: 1 }, d), [GAME, B_dev])) === true);
    await fB.waitForFunction(`window.__rx.some(r => r.payload && r.payload.priv === 1)`, null, { timeout: 10000 });
    check('S4: … delivered to the addressee only, meta { to: me }',
        (await fB.evaluate(() => window.__rx.find(r => r.payload && r.payload.priv).meta.to)) === 'me'
        && !(await fC.evaluate(() => window.__rx.some(r => r.payload && r.payload.priv))));

    // ── S5: two games open CONCURRENTLY on one connection ─────────────────
    // The party model could not express this: a game attached to exactly one
    // party, and a party was a set of devices, so "B and I are playing two
    // different things" had nowhere to live. A scope is per game AND per
    // connection, so it is just two entries.
    for (const page of [A, B]) {
        await page.evaluate((src) => {
            window.__arcade.showGame('p2p-test-game-2', src, 'P2P Test 2');
        }, GAME_SRC + '?two');
    }
    const f2A = await fixtureFrame(A, 'two');
    const f2B = await fixtureFrame(B, 'two');
    for (const f of [f2A, f2B]) {
        await f.waitForFunction(`window.__peerStatus && typeof window.__peers === 'function'`, null, { timeout: 10000 });
    }
    // The fixture hard-codes its gameId, so drive the second scope through
    // the bridge — the frames it carries are what this section is about.
    await B.evaluate(() => {
        if (window.__invites2) return;
        window.__invites2 = [];
        window.__arcade.p2p.onGameInvite((e) => window.__invites2.push(e));
    });
    // An invite goes only where the game is NOT already open: game 1 is open
    // on both connections, so re-inviting it proposes to nobody; game 2 is
    // open on neither, so it proposes to both.
    check('S5: re-inviting an already-open game proposes to nobody',
        (await A.evaluate((g) => window.__arcade.p2p.inviteGame(g), GAME)) === 0);
    // The addressed form — the knock, and the host-side "invite this one
    // device" — reaches exactly that connection. C is asked and never
    // answers, which must leave the scope closed on both ends.
    check('S5: an addressed invite proposes to exactly that connection',
        (await A.evaluate(([g, d]) => window.__arcade.p2p.inviteGame(g, d), [GAME2, C_dev])) === 1);
    const sent2 = await A.evaluate((g) => window.__arcade.p2p.inviteGame(g), GAME2);
    check('S5: … while an unaddressed one reaches both connections', sent2 === 2, String(sent2));
    await B.waitForFunction(([d, g]) => (window.__invites2 || []).some(i => i.deviceId === d && i.gameId === g),
        [A_dev, GAME2], { timeout: 15000 });
    await B.evaluate(([d, g]) => window.__arcade.p2p.acceptGameInvite(d, g), [A_dev, GAME2]);
    await A.waitForFunction(([d, g]) => ((window.__arcade.p2p._gameScopes()[g]) || []).includes(d),
        [B_dev, GAME2], { timeout: 15000 });

    const scopesA = await A.evaluate(() => window.__arcade.p2p._gameScopes());
    check('S5: A holds two games open at once, with different device sets',
        (scopesA[GAME] || []).length === 2 && (scopesA[GAME2] || []).length === 1
        && scopesA[GAME2][0] === B_dev, JSON.stringify(scopesA));
    check('S5: per-game status and roster follow the scope, not the device',
        (await A.evaluate((g) => window.__arcade.p2p.statusForGame(g), GAME2)) === 'connected'
        && (await A.evaluate((g) => window.__arcade.p2p.rosterForGame(g).map(e => e.deviceId), GAME2))
            .join() === B_dev
        && (await A.evaluate((g) => window.__arcade.p2p.rosterForGame(g).length, GAME)) === 2);
    check("S5: C's game 2 never opens — it was never asked and never agreed",
        (await C.evaluate((g) => window.__arcade.p2p.statusForGame(g), GAME2)) === 'idle');

    // Traffic stays in its own game: a frame on game 2 must not surface in
    // game 1's iframe, on either device.
    await A.evaluate((g) => window.__arcade.p2p.send(g, { game2: 1 }), GAME2);
    await new Promise(r => setTimeout(r, 1000));
    check('S5: a game-2 frame never surfaces in game 1',
        !(await fB.evaluate(() => window.__rx.some(r => r.payload && r.payload.game2))));

    // ── S6: scope death on link death; the pairing survives ───────────────
    const pausedBefore = await B.evaluate((d) => {
        const rec = JSON.parse(localStorage.getItem('arcade.v1._meta.knownPeers') || '{}')[d];
        return rec ? rec.paused : undefined;
    }, A_dev);
    await A.evaluate((d) => {
        const pm = window.__arcade.p2p._addon().peerNode;
        pm.disconnectPeer(window.__arcade.p2p._identityLinks()[d]);
        pm.forgetSession(window.__arcade.p2p._identityLinks()[d]);
    }, C_dev);
    await waitFor(async () => {
        const s = await A.evaluate(() => window.__arcade.p2p._gameScopes());
        return !(s[GAME] || []).includes(C_dev);
    }, 10000).then(ok => check("S6: C's link dying closes the scopes that link held", ok));
    check('S6: … while the scopes on the SURVIVING link are untouched',
        (await A.evaluate(() => window.__arcade.p2p._gameScopes()))[GAME].includes(B_dev));
    await waitFor(async () => (await fA.evaluate(() => window.__peers())).length === 1, 10000)
        .then(ok => check("S6: … and A's roster drops to B alone", ok));
    check('S6: closing a scope never touched pause state (only Hang Up may)',
        (await B.evaluate((d) => {
            const rec = JSON.parse(localStorage.getItem('arcade.v1._meta.knownPeers') || '{}')[d];
            return rec ? rec.paused : undefined;
        }, A_dev)) === pausedBefore);

    // Leaving a game closes its scopes and tells the peer.
    await A.evaluate((g) => window.__arcade.p2p.leaveGame(g), GAME2);
    await waitFor(async () =>
        !(GAME2 in (await B.evaluate(() => window.__arcade.p2p._gameScopes()))), 10000)
        .then(ok => check('S6: leaveGame closes the scope on the peer too', ok));
    check('S6: … and the OTHER game the same connection has open survives',
        (await B.evaluate(() => window.__arcade.p2p._gameScopes()))[GAME].includes(A_dev));

    // ── S7: the retired party trio ────────────────────────────────────────
    const [party, parties, attached] = await Promise.all([
        fA.evaluate(() => window.__party()),
        fA.evaluate(() => window.__parties()),
        fA.evaluate(() => window.__attach('whatever'))
    ]);
    check('S7: peer.party() / parties() / attach() answer null / [] / null',
        party === null && Array.isArray(parties) && parties.length === 0 && attached === null,
        JSON.stringify([party, parties, attached]));
    check('S7: the peer.invite cap is advertised alongside the retired peer.party',
        (await fA.evaluate(() => window.__caps())).includes('peer.invite'));

    await A.close(); await B.close(); await C.close();
} catch (e) {
    console.error('\nFATAL:', e.message);
    check('run completed', false, e.message);
} finally {
    await harness.shutdown();
}

console.log(failed() === 0 ? '\nAll scope acceptance checks passed.' : `\n${failed()} check(s) FAILED.`);
process.exit(failed() === 0 ? 0 : 1);
