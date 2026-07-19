#!/usr/bin/env node
//
// tools/p2p-multiparty-acceptance.mjs — end-to-end proof of the Phase 2
// multi-party bridge (plans/multi-party-2026-07.md): one device concurrently
// LEADING one party while a MEMBER of another, with every game-facing
// surface scoped to the game's attached party.
//
// Topology under test (the 2026-07-18 field-test shape):
//
//   A ──member── H ──member── (B leads)      H leads P1 = {A}
//                                            H is a member of P2 = {B's star}
//
// Proven here, end to end through real launchers + the SDK:
//   M1  a joined device can lead its own party (createAnswer {newParty:true}
//       coexisting with an established led party)
//   M2  partiesSnapshot / per-party hub caps / knownPeers party persistence
//   M3  identity gossip never crosses parties (A and B never learn each other)
//   M4  per-game attachment: unattached among two parties reads 'idle';
//       SDK party()/parties()/attach() drive it; presence (onReady) follows
//       an attach; roster/status flip with the attachment
//   M5  frames never cross parties — broadcasts, and cross-party targeted
//       sends refuse
//   M6  party death (closeParty) sweeps hub caps + attachment; the game
//       auto-attaches to the sole survivor
//   M7  restart resume re-groups links into their pre-restart parties via
//       the persisted knownPeers party keys (two LED parties must NOT
//       coalesce into one — the adoptPartyId hook's whole job)
//   M8  partiesSnapshot().members — the launcher party card's leader-first
//       hierarchy, with gossip-known fellow members carrying NO health claim
//   M9  leaveParty (P3 launcher UX): deliberate goodbye from either role —
//       roster departure without a repair episode, persisted party record
//       cleared, the leaver's other parties untouched
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
const { launcherPage, deviceIdOf } = harness;

const FAST_RDV = `(() => {
    const r = window.__arcade.p2p._rdv();
    r.options.listenerDelayMs = 800;
    r.options.callerDelayMs = 1600;
    window.__rdvEv = window.__rdvEv || [];
    for (const t of ['pair-established', 'reconnecting', 'reconnected', 'recovered-inband', 'gave-up'])
        r.addEventListener(t, () => window.__rdvEv.push(t));
})()`;

// Ceremony with explicit party options — the harness's ceremony() drives the
// legacy party-less path only. offerOpts runs on the host side (e.g.
// {partyId}), answerOpts on the joiner side (e.g. {newParty:true}).
async function partyCeremony(H, J, { offerOpts = undefined, answerOpts = undefined } = {}) {
    const packedOffer = await H.evaluate(async (opts) => {
        const { ConnectionUtils } = await import('./p2p/p2p-core.js');
        const addon = window.__arcade.p2p._addon();
        return await ConnectionUtils.encodePayload(await addon.peerNode.createOffer(opts || {}));
    }, offerOpts);
    const packedAnswer = await J.evaluate(async ([packed, opts]) => {
        const { ConnectionUtils } = await import('./p2p/p2p-core.js');
        const addon = window.__arcade.p2p._addon();
        const offer = await ConnectionUtils.decodePayload(packed);
        return await ConnectionUtils.encodePayload(await addon.peerNode.createAnswer(offer, opts || {}));
    }, [packedOffer, answerOpts]);
    await H.evaluate(async (packed) => {
        const { ConnectionUtils } = await import('./p2p/p2p-core.js');
        await window.__arcade.p2p._addon().peerNode.acceptAnswer(await ConnectionUtils.decodePayload(packed));
    }, packedAnswer);
}

const contexts = {};
for (const label of ['H', 'A', 'B', 'C']) contexts[label] = await harness.newDeviceContext();

try {
    console.log('\nP2P multiparty acceptance — lead one party while a member of another\n');

    const H = await launcherPage('H', contexts.H);
    const A = await launcherPage('A', contexts.A);
    const B = await launcherPage('B', contexts.B);
    for (const page of [H, A, B]) await harness.bootBridge(page, { closeDialog: true });

    // ── M1: the two ceremonies ────────────────────────────────────────────
    // P1: H hosts (legacy path — default led party), A joins.
    await partyCeremony(H, A);
    await A.waitForFunction(`window.__arcade.p2p.status() === 'connected'`, null, { timeout: 20000 });
    // P2: B hosts (legacy — B's own led party), H joins WITH ITS LED PARTY
    // ESTABLISHED — the exact operation the old role-flip guard refused.
    await partyCeremony(B, H, { answerOpts: { newParty: true } });
    await B.waitForFunction(`window.__arcade.p2p.status() === 'connected'`, null, { timeout: 20000 });
    await H.waitForFunction(
        `window.__arcade.p2p._addon().peerNode.statusSummary().connected === 2`, null, { timeout: 20000 });
    check('M1: H holds two connected links — leading P1 while a member of P2', true);

    const H_dev = await deviceIdOf(H);
    const A_dev = await deviceIdOf(A);
    const B_dev = await deviceIdOf(B);

    // Identity bindings converge on every direct link.
    await H.waitForFunction((devs) => {
        const links = window.__arcade.p2p._identityLinks();
        return devs.every(d => d in links);
    }, [A_dev, B_dev], { timeout: 15000 });
    await A.waitForFunction((d) => d in window.__arcade.p2p._identityLinks(), H_dev, { timeout: 15000 });
    await B.waitForFunction((d) => d in window.__arcade.p2p._identityLinks(), H_dev, { timeout: 15000 });
    check('M1: identity bindings complete on all three devices', true);

    // ── M2: party read model + persistence ────────────────────────────────
    const partiesH = await H.evaluate(() => window.__arcade.p2p.partiesSnapshot());
    const ledParty = partiesH.find(p => p.role === 'leader');
    const memberParty = partiesH.find(p => p.role === 'member');
    check('M2: H partiesSnapshot = one led + one member party, one seat each',
        partiesH.length === 2 && !!ledParty && !!memberParty
        && ledParty.peers === 1 && memberParty.peers === 1,
        JSON.stringify(partiesH.map(p => [p.role, p.peers, p.status])));
    check('M2: both parties read connected with a leader name',
        partiesH.every(p => p.status === 'connected' && typeof p.leaderName === 'string' && p.leaderName));
    const partiesA = await A.evaluate(() => window.__arcade.p2p.partiesSnapshot());
    const partiesB = await B.evaluate(() => window.__arcade.p2p.partiesSnapshot());
    check('M2: A is a member of one party; B leads one party',
        partiesA.length === 1 && partiesA[0].role === 'member'
        && partiesB.length === 1 && partiesB[0].role === 'leader');

    // Roster entries carry distinct partyIds.
    const rosterH = await H.evaluate(() => window.__arcade.p2p.connectedPeers());
    check('M2: H roster = A and B on DISTINCT parties',
        rosterH.length === 2
        && rosterH.find(e => e.deviceId === A_dev)?.partyId === ledParty.id
        && rosterH.find(e => e.deviceId === B_dev)?.partyId === memberParty.id,
        JSON.stringify(rosterH.map(e => [e.deviceId === A_dev ? 'A' : 'B', e.partyId])));

    // Hub caps recorded per member party only.
    const hubCaps = await H.evaluate(() => window.__arcade.p2p._hubCaps());
    check("M2: H recorded B's hub caps for the member party only",
        Array.isArray(hubCaps[memberParty.id]) && hubCaps[memberParty.id].includes('peer.sendTo')
        && !(ledParty.id in hubCaps),
        JSON.stringify(hubCaps));

    // knownPeers party persistence: A under H's led key, B under the member key.
    const knownParty = await H.evaluate(() => {
        const known = JSON.parse(localStorage.getItem('arcade.v1._meta.knownPeers'));
        return Object.fromEntries(Object.entries(known).map(([d, r]) => [d, r.party || null]));
    });
    check('M2: knownPeers persist party membership (role per relationship, distinct keys)',
        knownParty[A_dev]?.role === 'leader' && knownParty[B_dev]?.role === 'member'
        && knownParty[A_dev].key !== knownParty[B_dev].key,
        JSON.stringify(knownParty));

    // ── M3: identity gossip never crosses parties ─────────────────────────
    await new Promise(r => setTimeout(r, 1500)); // give any (wrong) gossip time to land
    const indirectA = await A.evaluate(() => window.__arcade.p2p._indirectPeers());
    const indirectB = await B.evaluate(() => window.__arcade.p2p._indirectPeers());
    check('M3: A never learns B, B never learns A (no cross-party identity gossip)',
        !(B_dev in indirectA) && !(A_dev in indirectB),
        JSON.stringify([indirectA, indirectB]));

    // ── M4: per-game attachment ───────────────────────────────────────────
    for (const page of [H, A, B]) {
        await page.evaluate(() => {
            window.__arcade.showGame('p2p-test-game', 'tools/fixtures/p2p-test-game/index.html', 'P2P Test');
        });
    }
    const fH = await harness.fixtureFrame(H, 'p2p-test-game');
    const fA = await harness.fixtureFrame(A, 'p2p-test-game');
    const fB = await harness.fixtureFrame(B, 'p2p-test-game');
    for (const f of [fA, fB]) {
        await f.waitForFunction(`window.__peerStatus && window.__peerStatus() === 'connected'`, null, { timeout: 10000 });
    }
    check('M4: single-party devices auto-attach — A and B games see connected', true);
    await fH.waitForFunction(`window.__peerStatus && typeof window.__caps === 'function'`, null, { timeout: 10000 });
    const hStatus = await fH.evaluate(() => window.__peerStatus());
    check("M4: H's game is UNATTACHED among two live parties — status 'idle', empty roster",
        hStatus === 'idle', hStatus);
    check('M4: caps announce peer.party',
        await fH.evaluate(() => window.__caps().includes('peer.party')));
    const hParty0 = await fH.evaluate(() => window.__party());
    const hParties = await fH.evaluate(() => window.__parties());
    check('M4: party() null / parties() lists both, with roles and names',
        hParty0 === null && hParties.length === 2
        && hParties.some(p => p.role === 'leader') && hParties.some(p => p.role === 'member'),
        JSON.stringify(hParties.map(p => p.role)));

    // A broadcast sent while H's game is unattached must NOT be delivered.
    await fA.evaluate(() => window.__send({ preAttach: 1 }));
    await new Promise(r => setTimeout(r, 800));
    check("M4: a P1 broadcast is NOT delivered to H's unattached game",
        !(await fH.evaluate(() => window.__rx.some(r => r.payload && r.payload.preAttach))));

    // SDK attach → P1: status flips, roster is A only, presence exchanged.
    const attached = await fH.evaluate((id) => window.__attach(id), ledParty.id);
    check('M4: attach(P1) resolves the attached party entry',
        !!attached && attached.id === ledParty.id && attached.role === 'leader',
        JSON.stringify(attached));
    await fH.waitForFunction(`window.__peerStatus() === 'connected'`, null, { timeout: 10000 });
    const hPeers1 = await fH.evaluate(() => window.__peers());
    check("M4: attached game's roster = A only",
        hPeers1.length === 1 && hPeers1[0].deviceId === A_dev, JSON.stringify(hPeers1));
    check('M4: presence follows the attach — both sides fire onReady',
        await waitFor(async () =>
            (await fA.evaluate((d) => window.__readyEvents.some(e => e.deviceId === d), H_dev))
            && (await fH.evaluate((d) => window.__readyEvents.some(e => e.deviceId === d), A_dev)), 10000));

    // ── M5: frames never cross parties ────────────────────────────────────
    await fB.evaluate(() => window.__send({ p2Frame: 1 }));   // B → its party (H's member link)
    await fH.evaluate(() => window.__send({ fromH: 1 }));     // H's game → P1 only
    await fA.evaluate(() => window.__send({ p1Frame: 2 }));   // A → P1 (arrives at H)
    await fH.waitForFunction(`window.__rx.some(r => r.payload && r.payload.p1Frame === 2)`, null, { timeout: 10000 });
    const hFromA = await fH.evaluate(() => window.__rx.filter(r => r.payload && r.payload.p1Frame === 2));
    check('M5: P1 broadcast reaches the attached game, attributed to A',
        hFromA.length === 1 && hFromA[0].fromPeer === A_dev && hFromA[0].meta.relayed === false);
    await fA.waitForFunction(`window.__rx.some(r => r.payload && r.payload.fromH === 1)`, null, { timeout: 10000 });
    check("M5: H's game broadcast reached A", true);
    check("M5: … but NOT B (send scoped to the attached party)",
        !(await fB.evaluate(() => window.__rx.some(r => r.payload && r.payload.fromH))));
    check("M5: B's party frame is NOT delivered to H's P1-attached game",
        !(await fH.evaluate(() => window.__rx.some(r => r.payload && r.payload.p2Frame))));
    check("M5: A never receives P2 traffic (no cross-party relay through H)",
        !(await fA.evaluate(() => window.__rx.some(r => r.payload && r.payload.p2Frame))));
    // Cross-party targeted send refuses (B is not in the attached party).
    check('M5: targeted send to a device of ANOTHER party returns false',
        (await H.evaluate((d) => window.__arcade.p2p.send('p2p-test-game', { x: 1 }, d), B_dev)) === false);

    // Re-attach to P2: the same surfaces flip to B's table.
    const attached2 = await fH.evaluate((id) => window.__attach(id), memberParty.id);
    check('M4: re-attach(P2) resolves', !!attached2 && attached2.id === memberParty.id);
    await waitFor(async () => {
        const peers = await fH.evaluate(() => window.__peers());
        return peers.length === 1 && peers[0].deviceId === B_dev;
    }, 10000).then(ok => check("M4: after re-attach the roster is B only", ok));
    await fB.evaluate(() => window.__send({ p2Frame: 2 }));
    await fH.waitForFunction(`window.__rx.some(r => r.payload && r.payload.p2Frame === 2)`, null, { timeout: 10000 });
    check("M5: after re-attach, B's frames reach H's game", true);
    await fA.evaluate(() => window.__send({ p1Frame: 3 }));
    await new Promise(r => setTimeout(r, 800));
    check("M5: … and A's no longer do",
        !(await fH.evaluate(() => window.__rx.some(r => r.payload && r.payload.p1Frame === 3))));

    // ── M6: party death sweeps per-party state; game auto-reattaches ──────
    await H.evaluate((partyId) => {
        window.__arcade.p2p._addon().peerNode.closeParty(partyId);
    }, memberParty.id);
    await fH.waitForFunction((dev) => {
        const peers = window.__peers();
        return peers.length === 1 && peers[0].deviceId === dev;
    }, A_dev, { timeout: 10000 });
    check('M6: after closeParty(P2) the game auto-attaches to the surviving party (roster = A)', true);
    check("M6: H's game status recovered to connected on the survivor",
        (await fH.evaluate(() => window.__peerStatus())) === 'connected');
    const stateAfterClose = await H.evaluate(() => [
        window.__arcade.p2p._hubCaps(), window.__arcade.p2p._gameParties(),
        window.__arcade.p2p.partiesSnapshot().length]);
    check('M6: hub caps swept with the dead party; one live party remains',
        !(memberParty.id in stateAfterClose[0]) && stateAfterClose[2] === 1,
        JSON.stringify(stateAfterClose));
    check('M6: the attachment map points at the survivor only',
        Object.values(stateAfterClose[1]).every(p => p === ledParty.id),
        JSON.stringify(stateAfterClose[1]));

    // ── M7: restart resume re-groups links by persisted party keys ────────
    // Second led party P3 = {C}: without adoptPartyId, a restarted H would
    // coalesce A's and C's re-adopted links into ONE led party.
    const C = await launcherPage('C', contexts.C);
    await harness.bootBridge(C, { closeDialog: true });
    const p3 = await H.evaluate(() => window.__arcade.p2p._addon().peerNode.createParty());
    await partyCeremony(H, C, { offerOpts: { partyId: p3 } });
    await C.waitForFunction(`window.__arcade.p2p.status() === 'connected'`, null, { timeout: 20000 });
    const C_dev = await deviceIdOf(C);
    await H.waitForFunction((d) => d in window.__arcade.p2p._identityLinks(), C_dev, { timeout: 15000 });
    check('M7: H now leads two parties (P1 = A, P3 = C)',
        (await H.evaluate(() => window.__arcade.p2p.partiesSnapshot()))
            .filter(p => p.role === 'leader').length === 2);

    for (const page of [H, A, C]) await page.evaluate(FAST_RDV);
    await H.evaluate((devs) => Promise.all(devs.map(d => window.__arcade.p2p.enableAutoReconnect(d))), [A_dev, C_dev]);
    await A.evaluate((d) => window.__arcade.p2p.enableAutoReconnect(d), H_dev);
    await C.evaluate((d) => window.__arcade.p2p.enableAutoReconnect(d), H_dev);
    await H.waitForFunction(`window.__rdvEv.filter(e => e === 'pair-established').length >= 2`, null, { timeout: 15000 });
    check('M7: both pairs armed for auto-reconnect', true);

    await H.reload();
    await H.waitForFunction('!!window.__arcade && !!window.__arcade.showGame');
    const booted = await H.waitForFunction(
        '!!window.__arcade.p2p && !!window.__arcade.p2p._addon()', null, { timeout: 20000 }
    ).then(() => true).catch(() => false);
    check('M7: reloaded H booted the transport on its own (recent session)', booted);
    if (booted) {
        await H.evaluate(FAST_RDV);
        const healed = await H.waitForFunction((devs) => {
            const links = window.__arcade.p2p._identityLinks();
            return devs.every(d => d in links);
        }, [A_dev, C_dev], { timeout: 60000 }).then(() => true).catch(() => false);
        check('M7: both links re-adopted and re-bound after the restart', healed);
        if (healed) {
            const grouping = await H.evaluate((devs) => {
                const pm = window.__arcade.p2p._addon().peerNode;
                const links = window.__arcade.p2p._identityLinks();
                return devs.map(d => {
                    const partyId = pm.partyOf(links[d]);
                    return { partyId, role: pm.partyRole(partyId) };
                });
            }, [A_dev, C_dev]);
            check('M7: re-adopted links land in TWO DISTINCT led parties (no coalescing)',
                grouping[0].role === 'leader' && grouping[1].role === 'leader'
                && grouping[0].partyId !== grouping[1].partyId,
                JSON.stringify(grouping));

            // ── M8: partiesSnapshot members — the launcher party card's data ──
            // H invites B into A's party: A and B become fellow members who
            // know each other only THROUGH H (relayed identity gossip).
            const pA_H = grouping[0].partyId; // A's party, H's local id
            const pC_H = grouping[1].partyId; // C's party, H's local id
            await partyCeremony(H, B, { offerOpts: { partyId: pA_H }, answerOpts: { newParty: true } });
            await H.waitForFunction((d) => d in window.__arcade.p2p._identityLinks(), B_dev, { timeout: 20000 });

            const cardH = await H.evaluate((pid) =>
                window.__arcade.p2p.partiesSnapshot().find(p => p.id === pid), pA_H);
            check('M8: leader card lists itself first (leader), then both members with live health',
                !!cardH && cardH.members.length === 3
                && cardH.members[0].isLeader && cardH.members[0].isSelf
                && cardH.members.slice(1).every(m => !m.isLeader && !m.isSelf && m.status === 'connected'),
                JSON.stringify(cardH && cardH.members));

            // A's card: leader H first (health visible — A's own link), then
            // itself, then fellow member B with NO claimed health (null — a
            // leaf can't see the hub's other links; the UI draws no dot).
            const cardA = await A.waitForFunction(() => {
                const p = window.__arcade.p2p.partiesSnapshot()[0];
                return (p && p.members.length === 3) ? JSON.stringify(p) : undefined;
            }, null, { timeout: 20000 }).then(h => h.jsonValue()).then(JSON.parse)
                .catch(async (e) => {
                    const dump = await A.evaluate(() => JSON.stringify({
                        parties: window.__arcade.p2p.partiesSnapshot(),
                        indirect: window.__arcade.p2p._indirectPeersByParty()
                    }));
                    throw new Error(e.message + ' — A state: ' + dump);
                });
            check('M8: member card = leader first, self second, gossip-known fellow member without health',
                cardA.members[0].isLeader && !cardA.members[0].isSelf && cardA.members[0].status === 'connected'
                && cardA.members[1].isSelf && !cardA.members[1].isLeader
                && cardA.members[2].deviceId === B_dev && cardA.members[2].status === null,
                JSON.stringify(cardA.members));

            // ── M9: leaveParty — deliberate goodbye, both roles ───────────
            // Member side: A walks away from its hub link. The peer must see
            // a departure (roster drop) but burn NO repair episode — the bye
            // drops it to quiet standby, still callable.
            const reconnCountH = await H.evaluate(() => window.__rdvEv.filter(e => e === 'reconnecting').length);
            check('M9: member leaveParty resolves true',
                await A.evaluate((pid) => window.__arcade.p2p.leaveParty(pid), cardA.id));
            await H.waitForFunction((d) =>
                !window.__arcade.p2p.connectedPeers().some(e => e.deviceId === d), A_dev, { timeout: 15000 });
            check('M9: H roster drops A promptly (departure, not interruption)', true);
            check('M9: A shows no party afterwards',
                (await A.evaluate(() => window.__arcade.p2p.partiesSnapshot())).length === 0);
            check('M9: A cleared the persisted party record and paused the pairing',
                await A.evaluate((d) => {
                    const rec = JSON.parse(localStorage.getItem('arcade.v1._meta.knownPeers') || '{}')[d];
                    return !!rec && !rec.party && rec.paused === true;
                }, H_dev));
            await new Promise(r => setTimeout(r, 1200));
            check('M9: the bye spared H a repair episode',
                (await H.evaluate(() => window.__rdvEv.filter(e => e === 'reconnecting').length)) === reconnCountH);
            check('M9: the party survives on the leader with its other member (B)',
                await H.evaluate((pid) => {
                    const p = window.__arcade.p2p.partiesSnapshot().find(x => x.id === pid);
                    return !!p && p.peers === 1 && p.members.length === 2;
                }, pA_H));

            // Leader side: H ends C's party — every member sees it end.
            const reconnCountC = await C.evaluate(() => window.__rdvEv.filter(e => e === 'reconnecting').length);
            check('M9: leader leaveParty resolves true',
                await H.evaluate((pid) => window.__arcade.p2p.leaveParty(pid), pC_H));
            await C.waitForFunction(`window.__arcade.p2p.partiesSnapshot().length === 0`, null, { timeout: 15000 });
            check('M9: leader leaveParty ends the party — C sees it gone', true);
            check("M9: H's OTHER party (B) is untouched",
                await H.evaluate((pid) => {
                    const ps = window.__arcade.p2p.partiesSnapshot();
                    return ps.length === 1 && ps[0].id === pid;
                }, pA_H));
            await new Promise(r => setTimeout(r, 1200));
            check('M9: C burned no repair episode on the deliberate goodbye',
                (await C.evaluate(() => window.__rdvEv.filter(e => e === 'reconnecting').length)) === reconnCountC);
        }
    }

    await H.close(); await A.close(); await B.close(); await C.close();
} catch (e) {
    console.error('\nFATAL:', e.message);
    check('run completed', false, e.message);
} finally {
    await harness.shutdown();
}

console.log(failed() === 0 ? '\nAll multiparty acceptance checks passed.' : `\n${failed()} check(s) FAILED.`);
process.exit(failed() === 0 ? 0 : 1);
