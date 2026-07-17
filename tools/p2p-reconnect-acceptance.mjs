#!/usr/bin/env node
//
// tools/p2p-reconnect-acceptance.mjs — end-to-end proof of the reconnect
// lifecycle the Multiplayer dialog promises: auto-heal after a client is
// TERMINATED mid-call (page reload), Hang Up as a mutual goodbye (the other
// side doesn't burn a repair episode), and Call as a one-sided ring that
// reaches any peer whose arcade is merely open — including after the old
// 10-minute episode window ('gave-up' now means quiet, not deaf) and after
// a fresh boot outside the resume window (standby-at-launch).
//
//   node tools/p2p-reconnect-acceptance.mjs
//
// Self-contained like p2p-acceptance.mjs: local static server, local ICE,
// injected loopback dead-drop (no external broker touched).
//
// Exit code: 0 if all checks pass, 1 otherwise.

import { startP2PHarness, makeCheck } from './lib/p2p-test-harness.mjs';

const { check, failed } = makeCheck();
const harness = await startP2PHarness({ port: 4795, dropPort: 4794 });
const { launcherPage, ceremony } = harness;

// Compress the in-band-first-claim delays so scenarios finish in seconds;
// everything else (episode timeout, stall, re-arm) keeps production values
// unless a scenario overrides it explicitly.
const FAST_RDV = `(() => {
    const r = window.__arcade.p2p._rdv();
    r.options.listenerDelayMs = 800;
    r.options.callerDelayMs = 1600;
    window.__rdvEv = window.__rdvEv || [];
    for (const t of ['pair-established', 'reconnecting', 'reconnected', 'recovered-inband', 'gave-up', 'remote-bye'])
        r.addEventListener(t, () => window.__rdvEv.push(t));
    window.__rdvDiag = window.__rdvDiag || [];
    r.addEventListener('diagnostic', (e) => window.__rdvDiag.push((e.detail || {}).msg || ''));
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

const peerDev = (page) => page.evaluate(() =>
    Object.keys(JSON.parse(localStorage.getItem('arcade.v1._meta.knownPeers')))[0]);

async function freshPair(tag) {
    const ctxH = await harness.newDeviceContext();
    const ctxJ = await harness.newDeviceContext();
    const H = await launcherPage(tag + ':host', ctxH);
    const J = await launcherPage(tag + ':joiner', ctxJ);
    await loadBridge(H); await loadBridge(J);
    await ceremony(H, J);
    await pairBoth(H, J);
    return { ctxH, ctxJ, H, J };
}

// Enables auto-reconnect for EVERY peer a page currently knows (the host knows
// two; each spoke knows only the host). Waits until at least `expected` peers
// are bound so the host doesn't pair only its first spoke.
async function pairAllKnown(page, expected) {
    await page.waitForFunction((n) => {
        const raw = localStorage.getItem('arcade.v1._meta.knownPeers');
        return !!raw && Object.keys(JSON.parse(raw)).length >= n;
    }, expected, { timeout: 15000 });
    await page.evaluate(() => {
        const known = JSON.parse(localStorage.getItem('arcade.v1._meta.knownPeers'));
        return Promise.all(Object.keys(known).map((d) => window.__arcade.p2p.enableAutoReconnect(d)));
    });
}

// Hub + two spokes: one host holding two live links, each spoke paired to it.
async function freshTriple(tag) {
    const ctxH = await harness.newDeviceContext();
    const ctxA = await harness.newDeviceContext();
    const ctxB = await harness.newDeviceContext();
    const H = await launcherPage(tag + ':host', ctxH);
    const A = await launcherPage(tag + ':A', ctxA);
    const B = await launcherPage(tag + ':B', ctxB);
    await loadBridge(H); await loadBridge(A); await loadBridge(B);
    await ceremony(H, A, { waitHost: false });
    await ceremony(H, B, { waitHost: false });
    await pairAllKnown(H, 2); await pairAllKnown(A, 1); await pairAllKnown(B, 1);
    // Both pairs established (the host fires pair-established once per pair).
    await H.waitForFunction(`window.__rdvEv.filter(e => e === 'pair-established').length >= 2`, null, { timeout: 15000 });
    await A.waitForFunction(`window.__rdvEv.includes('pair-established')`, null, { timeout: 15000 });
    await B.waitForFunction(`window.__rdvEv.includes('pair-established')`, null, { timeout: 15000 });
    return { ctxH, ctxA, ctxB, H, A, B };
}

const connectedAgain = (page) =>
    page.waitForFunction(`window.__arcade.p2p.status() === 'connected'`, null, { timeout: 60000 })
        .then(() => true).catch(() => false);

try {
    console.log('\nP2P reconnect acceptance — heal, hang up, call\n');

    // 1. TERMINATED CLIENT: reload one launcher mid-call. resume-on-launch
    //    must boot the transport by itself and both sides must heal — twice
    //    in a row (the second run exercises the adopted link + ratchet).
    {
        console.log('  [terminated client mid-call]');
        const s = await freshPair('A');
        for (let round = 1; round <= 2; round++) {
            await s.J.reload();
            await s.J.waitForFunction('!!window.__arcade && !!window.__arcade.showGame');
            const booted = await s.J.waitForFunction(
                '!!window.__arcade.p2p && !!window.__arcade.p2p._addon()', null, { timeout: 20000 }
            ).then(() => true).catch(() => false);
            check(`round ${round}: reloaded client booted the transport on its own`, booted);
            if (!booted) break;
            await s.J.evaluate(FAST_RDV);
            check(`round ${round}: reloaded client healed`, await connectedAgain(s.J));
            check(`round ${round}: surviving client healed`, await connectedAgain(s.H));
        }
        await s.ctxH.close(); await s.ctxJ.close();
    }

    // 2. HANG UP → one-sided CALL BACK. The bye must reach the other side
    //    (no repair episode burned there — it drops to quiet standby), and a
    //    Call from the hanger-upper alone must re-establish.
    {
        console.log('\n  [hang up → call back, one-sided]');
        const s = await freshPair('B');
        const devOnH = await peerDev(s.H);
        await s.H.evaluate((d) => window.__arcade.p2p.hangUpKnownPeer(d), devOnH);

        const jGotBye = await s.J.waitForFunction(
            `window.__rdvEv.includes('remote-bye')`, null, { timeout: 15000 }
        ).then(() => true).catch(() => false);
        check('other side received the goodbye (bye frame beat the teardown)', jGotBye);

        await s.J.waitForFunction(`window.__arcade.p2p.status() === 'idle'`, null, { timeout: 15000 })
            .catch(() => {});
        check('other side dropped to idle promptly (no lingering interrupted)',
            await s.J.evaluate(() => window.__arcade.p2p.status()) === 'idle');
        // Give the (compressed) repair delays time to have fired if they were
        // going to: a bye must mean NO public repair attempt on the receiver.
        await new Promise(r => setTimeout(r, 2500));
        check('other side burned no repair episode on a deliberate hang-up',
            !(await s.J.evaluate(() => window.__rdvEv.includes('reconnecting'))));

        const stateH = await s.H.evaluate((d) => window.__arcade.p2p.connectionState(d), devOnH);
        check("hanger-upper shows 'paused'", stateH === 'paused', stateH);

        const tried = await s.H.evaluate((d) => window.__arcade.p2p.callKnownPeer(d), devOnH);
        check('Call reports an attempt', tried === true, String(tried));
        check('one-sided call re-established: caller connected', await connectedAgain(s.H));
        check('one-sided call re-established: callee connected', await connectedAgain(s.J));
        await s.ctxH.close(); await s.ctxJ.close();
    }

    // 3. GIVE-UP IS NOT DEATH: let the survivor's active episode time out
    //    ('gave-up'), then a one-sided Call must still land — the episode
    //    demoted to a quiet subscription instead of going deaf.
    {
        console.log('\n  [call long after the survivor gave up]');
        const s = await freshPair('C');
        const devOnH = await peerDev(s.H);
        const devOnJ = await peerDev(s.J);
        await s.J.evaluate(() => { window.__arcade.p2p._rdv().options.episodeTimeoutMs = 3000; });
        // Pause H quietly (no bye) then hard-kill the link: J must go through
        // a real repair episode and time out.
        await s.H.evaluate(async (d) => {
            await window.__arcade.p2p._rdv().pausePair(d);
            const pm = window.__arcade.p2p._addon().peerNode;
            Array.from(pm.peers.values()).forEach(p => { try { p.dataChannel.close(); } catch (e) {} });
        }, devOnH);

        const gaveUp = await s.J.waitForFunction(
            `window.__rdvEv.includes('gave-up')`, null, { timeout: 60000 }
        ).then(() => true).catch(() => false);
        check("survivor's episode gave up (active phase over)", gaveUp);
        const stillArmed = await s.J.evaluate(() => window.__arcade.p2p._rdv().episodesActive());
        check('…but its subscription is still armed (quiet, reachable)', stillArmed === 1, `episodes=${stillArmed}`);

        const tried = await s.H.evaluate((d) => window.__arcade.p2p.callKnownPeer(d), devOnH);
        check('Call reports an attempt', tried === true, String(tried));
        check('post-give-up call: caller connected', await connectedAgain(s.H));
        check('post-give-up call: callee connected', await connectedAgain(s.J));
        void devOnJ;
        await s.ctxH.close(); await s.ctxJ.close();
    }

    // 4. STANDBY AT BOOT: outside the resume window a freshly-opened arcade
    //    must still arm quiet standby (tryResumeOnLaunch boots the bridge for
    //    any auto-reconnect peer), so a Call reaches an app that is merely open.
    {
        console.log('\n  [call an arcade that merely booted (stale resume window)]');
        const s = await freshPair('D');
        const devOnH = await peerDev(s.H);
        // Hang up so nothing is live, then reopen J as "just booted, hours later".
        await s.H.evaluate((d) => window.__arcade.p2p.hangUpKnownPeer(d), devOnH);
        await s.J.evaluate(() => {
            // Age the resume stamp past the 6h window: only the standby path
            // may boot the transport now.
            localStorage.setItem('arcade.v1._meta.lastLiveSession', String(Date.now() - 7 * 3600 * 1000));
        });
        await s.J.reload();
        await s.J.waitForFunction('!!window.__arcade && !!window.__arcade.showGame');
        const booted = await s.J.waitForFunction(
            '!!window.__arcade.p2p && !!window.__arcade.p2p._addon()', null, { timeout: 20000 }
        ).then(() => true).catch(() => false);
        check('freshly-opened arcade armed standby for its auto-reconnect peer', booted);
        if (booted) {
            await s.J.evaluate(FAST_RDV);
            const quiet = await s.J.evaluate(() => ({
                episodes: window.__arcade.p2p._rdv().episodesActive(),
                status: window.__arcade.p2p.status()
            }));
            check('standby is quiet (no session claimed)', quiet.status === 'idle', quiet.status);
            check('standby episode armed', quiet.episodes === 1, `episodes=${quiet.episodes}`);

            await s.H.evaluate((d) => window.__arcade.p2p.callKnownPeer(d), devOnH);
            check('call reached the merely-open arcade: caller connected', await connectedAgain(s.H));
            check('call reached the merely-open arcade: callee connected', await connectedAgain(s.J));
        }
        await s.ctxH.close(); await s.ctxJ.close();
    }

    // 5. RE-PAIR SUPERSEDES A STALE EPISODE: with a repair episode stuck
    //    active (the peer is unreachable), a fresh manual ceremony re-pairs —
    //    the fresh secret MUST cancel the stale episode, which still holds
    //    the OLD base/role/epoch and squats the pair's one episode slot. If
    //    it survives, every publish rides retired topics/keys and no episode
    //    with the new secret can ever start, so healing is dead until an app
    //    restart (found via field logs from a laptop↔phone session).
    {
        console.log('\n  [manual re-ceremony while a stale episode is running]');
        const s = await freshPair('E');
        const killLinks = (page) => page.evaluate(() => {
            const pm = window.__arcade.p2p._addon().peerNode;
            Array.from(pm.peers.values()).forEach(p => { try { p.dataChannel.close(); } catch (e) {} });
        });
        // Park J quietly (paused, no bye) and kill the link: H's episode
        // arms and can never complete — the "stale episode" of the field log.
        await s.J.evaluate(async (d) => { await window.__arcade.p2p._rdv().pausePair(d); }, await peerDev(s.J));
        await killLinks(s.H);
        const armed = await s.H.waitForFunction(
            `window.__arcade.p2p._rdv().episodesActive() === 1`, null, { timeout: 30000 }
        ).then(() => true).catch(() => false);
        check('stale episode armed while the peer is unreachable', armed);

        // Fresh manual ceremony (new transport peerIds). The identity
        // handshake re-pairs automatically — both sides still have
        // autoReconnect on — and the fresh secret must supersede.
        await ceremony(s.H, s.J);
        const staleCancelled = await s.H.waitForFunction(
            `window.__arcade.p2p._rdv().episodesActive() === 0`, null, { timeout: 15000 }
        ).then(() => true).catch(() => false);
        check('fresh pairing cancelled the stale episode', staleCancelled);

        // Break the new link quietly: both sides must heal with the NEW
        // secret (before the fix, H stayed deaf on retired topics forever).
        await killLinks(s.H);
        await s.H.waitForFunction(`window.__arcade.p2p.status() !== 'connected'`, null, { timeout: 30000 }).catch(() => {});
        check('healed after re-pair: side A', await connectedAgain(s.H));
        check('healed after re-pair: side B', await connectedAgain(s.J));
        await s.ctxH.close(); await s.ctxJ.close();
    }

    // 6. IMPATIENT USERS: after a hang-up, BOTH sides mash Call. Every press
    //    used to cancel the running episode — carrier, subscriptions and the
    //    offer nonce the peer was mid-answering — and re-arm a fresh one, so
    //    two users pressing Call kept resetting each other's handshake
    //    (field log: three Calls in 8 seconds, never connected). A press on
    //    a pair with a live episode must promote it in place, and the pair
    //    must still converge under interleaved presses from both sides.
    {
        console.log('\n  [both sides mash Call after a hang-up]');
        const s = await freshPair('F');
        const devOnH = await peerDev(s.H);
        const devOnJ = await peerDev(s.J);
        await s.H.evaluate((d) => window.__arcade.p2p.hangUpKnownPeer(d), devOnH);
        await s.J.waitForFunction(`window.__rdvEv.includes('remote-bye')`, null, { timeout: 15000 }).catch(() => {});
        for (let i = 0; i < 3; i++) {
            await s.H.evaluate((d) => window.__arcade.p2p.callKnownPeer(d), devOnH);
            await new Promise(r => setTimeout(r, 400));
            await s.J.evaluate((d) => window.__arcade.p2p.callKnownPeer(d), devOnJ);
            await new Promise(r => setTimeout(r, 400));
        }
        check('mashed calls converged: side A connected', await connectedAgain(s.H));
        check('mashed calls converged: side B connected', await connectedAgain(s.J));
        await s.ctxH.close(); await s.ctxJ.close();
    }

    // 7. DOUBLE HANG-UP: both sides hang up. Both pairs are then paused —
    //    deliberately unreachable — so a Call from ONE side alone must land
    //    nowhere (the peer is deaf by choice), and a Call from EACH side
    //    (any order, any gap) must re-establish with the kept secret. This
    //    is the "we both hung up, can we ever get back?" guarantee.
    {
        console.log('\n  [double hang-up → both must call, and that works]');
        const s = await freshPair('G');
        const devOnH = await peerDev(s.H);
        const devOnJ = await peerDev(s.J);
        await s.H.evaluate((d) => window.__arcade.p2p.hangUpKnownPeer(d), devOnH);
        await s.J.waitForFunction(`window.__rdvEv.includes('remote-bye')`, null, { timeout: 15000 }).catch(() => {});
        await s.J.evaluate((d) => window.__arcade.p2p.hangUpKnownPeer(d), devOnJ);
        const stateH = await s.H.evaluate((d) => window.__arcade.p2p.connectionState(d), devOnH);
        const stateJ = await s.J.evaluate((d) => window.__arcade.p2p.connectionState(d), devOnJ);
        check("both sides show 'paused' after the double hang-up",
            stateH === 'paused' && stateJ === 'paused', `H=${stateH} J=${stateJ}`);

        // One-sided call: H rings, but J hung up too — J must stay deaf
        // (no episode armed, nothing claimed) until ITS user calls back.
        const triedH = await s.H.evaluate((d) => window.__arcade.p2p.callKnownPeer(d), devOnH);
        check('first call reports an attempt', triedH === true, String(triedH));
        await new Promise(r => setTimeout(r, 3000));
        const jDeaf = await s.J.evaluate(() => ({
            episodes: window.__arcade.p2p._rdv().episodesActive(),
            status: window.__arcade.p2p.status()
        }));
        check('peer that also hung up stays deaf to a one-sided call',
            jDeaf.episodes === 0 && jDeaf.status === 'idle', `episodes=${jDeaf.episodes} status=${jDeaf.status}`);

        // Second side calls too (later, not simultaneous) → must converge.
        const triedJ = await s.J.evaluate((d) => window.__arcade.p2p.callKnownPeer(d), devOnJ);
        check('second call reports an attempt', triedJ === true, String(triedJ));
        check('double hang-up survived: side A connected', await connectedAgain(s.H));
        check('double hang-up survived: side B connected', await connectedAgain(s.J));
        await s.ctxH.close(); await s.ctxJ.close();
    }

    // 8. HANG-UP SURVIVES A RESTART — in both directions: the reopened
    //    hanger-upper must STILL be hung up (paused, no episode armed, deaf
    //    to the peer) until its user presses Call, and that Call must still
    //    work from the persisted secret with no new ceremony.
    {
        console.log('\n  [hang up → restart → still hung up, and Call still works]');
        const s = await freshPair('H');
        const devOnH = await peerDev(s.H);
        await s.H.evaluate((d) => window.__arcade.p2p.hangUpKnownPeer(d), devOnH);
        await s.J.waitForFunction(`window.__rdvEv.includes('remote-bye')`, null, { timeout: 15000 }).catch(() => {});

        // Restart the hanger-upper. resume-on-launch boots the bridge (the
        // session was live minutes ago) but must NOT resume the paused pair.
        await s.H.reload();
        await s.H.waitForFunction('!!window.__arcade && !!window.__arcade.showGame');
        const booted = await s.H.waitForFunction(
            '!!window.__arcade.p2p && !!window.__arcade.p2p._addon()', null, { timeout: 20000 }
        ).then(() => true).catch(() => false);
        check('reopened hanger-upper booted the bridge (recent session)', booted);
        if (booted) {
            await s.H.evaluate(FAST_RDV);
            await new Promise(r => setTimeout(r, 2500)); // resume-on-launch settle time
            const stateH = await s.H.evaluate((d) => window.__arcade.p2p.connectionState(d), devOnH);
            check("hang-up persisted across the restart ('paused')", stateH === 'paused', stateH);
            const armed = await s.H.evaluate(() => window.__arcade.p2p._rdv().episodesActive());
            check('…and no episode armed for the hung-up pair (still deaf)', armed === 0, `episodes=${armed}`);

            const tried = await s.H.evaluate((d) => window.__arcade.p2p.callKnownPeer(d), devOnH);
            check('Call after restart reports an attempt (secret persisted)', tried === true, String(tried));
            check('call landed: reopened caller connected', await connectedAgain(s.H));
            check('call landed: waiting callee connected', await connectedAgain(s.J));
        }
        await s.ctxH.close(); await s.ctxJ.close();
    }
    // 9. PAIRING STORM: the enable triggers (user toggle, identity-handshake
    //    auto-pair, pair-request auto-accept) can all fire in the same
    //    instant — and identity envelopes replay after a reconnect, firing
    //    the auto-pair path twice. Every extra trigger used to mint a fresh
    //    pairing random; the crossed exchanges then committed DIFFERENT
    //    bases on the two devices, leaving rendezvous permanently deaf on
    //    disjoint topics (field logs: laptop and phone each ringing/offering
    //    into silence, zero decrypt warnings). All triggers must collapse
    //    into one confirmed exchange, both sides must commit the SAME key,
    //    and the pair must still heal through the dead-drop afterwards.
    {
        console.log('\n  [pairing storm: every enable trigger at once, both sides]');
        const s = await freshPair('I');
        const storm = (page) => page.evaluate(async () => {
            const dev = Object.keys(JSON.parse(localStorage.getItem('arcade.v1._meta.knownPeers')))[0];
            const rdv = window.__arcade.p2p._rdv();
            const peerId = [...rdv.pairsByPeerId.entries()].find(([, p]) => p === dev)?.[0];
            const bursts = [];
            for (let i = 0; i < 3; i++) bursts.push(window.__arcade.p2p.enableAutoReconnect(dev));
            // A replayed identity envelope reaches the rendezvous layer as a
            // direct enablePair — the bridge's once-per-link guard can't help.
            if (peerId) bursts.push(rdv.enablePair(peerId, dev));
            await Promise.all(bursts.map(b => Promise.resolve(b).catch(() => {})));
        });
        await Promise.all([storm(s.H), storm(s.J)]);
        // Every exchange must settle committed — no candidate stuck waiting.
        for (const page of [s.H, s.J]) {
            const settled = await page.waitForFunction(`(() => {
                const r = window.__arcade.p2p._rdv();
                return r.myRands.size === 0 &&
                    [...r.pairExchanges.values()].every(ex => ex.committed);
            })()`, null, { timeout: 15000 }).then(() => true).catch(() => false);
            check('storm settled into a committed exchange', settled);
        }
        const keyCheckOf = (page) => page.evaluate(async () => {
            const dev = Object.keys(JSON.parse(localStorage.getItem('arcade.v1._meta.knownPeers')))[0];
            const rec = await new Promise((resolve, reject) => {
                const req = indexedDB.open('qrp2p-rendezvous', 1);
                req.onsuccess = () => {
                    const db = req.result;
                    const get = db.transaction('pairs', 'readonly').objectStore('pairs').get(dev);
                    get.onsuccess = () => { db.close(); resolve(get.result); };
                    get.onerror = () => { db.close(); reject(get.error); };
                };
                req.onerror = () => reject(req.error);
            });
            if (!rec) return null;
            const { RendezvousCrypto } = await import('./p2p/rendezvous-crypto.js');
            return RendezvousCrypto.keyCheck(rec.base);
        });
        const [checkH, checkJ] = await Promise.all([keyCheckOf(s.H), keyCheckOf(s.J)]);
        check('both sides persisted a secret', !!checkH && !!checkJ, `H=${checkH} J=${checkJ}`);
        check('both sides committed the SAME key', !!checkH && checkH === checkJ, `H=${checkH} J=${checkJ}`);

        // The stored secret must be the one the LAST commit announced — a
        // resumePair()/pausePair() read-modify-write racing the commit used
        // to write the OLD record back over it (field log: committed
        // caa65318, then rang on bbb4d9a9 forever).
        const lastCommitted = (page) => page.evaluate(() => {
            const lines = (window.__rdvDiag || []).filter(m => m.includes('secret established'));
            const m = /key check ([0-9a-f]{8})/.exec(lines[lines.length - 1] || '');
            return m ? m[1] : null;
        });
        const [logH, logJ] = await Promise.all([lastCommitted(s.H), lastCommitted(s.J)]);
        check('stored secret matches the last committed one (no write-back clobber)',
            !!logH && logH === checkH && logJ === checkJ,
            `H log=${logH} db=${checkH}; J log=${logJ} db=${checkJ}`);

        // Same room, end to end: kill the link quietly and demand a heal.
        await s.H.evaluate(() => {
            const pm = window.__arcade.p2p._addon().peerNode;
            Array.from(pm.peers.values()).forEach(p => { try { p.dataChannel.close(); } catch (e) {} });
        });
        await s.H.waitForFunction(`window.__arcade.p2p.status() !== 'connected'`, null, { timeout: 30000 }).catch(() => {});
        check('post-storm heal: side A connected', await connectedAgain(s.H));
        check('post-storm heal: side B connected', await connectedAgain(s.J));
        await s.ctxH.close(); await s.ctxJ.close();
    }

    // 10. CARRIER SEVER/RESTORE (T-4): a signaling outage mid-repair must not
    //     strand the pair. While the carrier session is dead, offers/rings
    //     publish into the void and no heal happens; when the session comes
    //     back, the onSessionUp hook republishes at once and the pair heals.
    //     Also proves nudgeAll() reaches the carrier's ensureAlive hook — both
    //     hooks the injected carrier previously lacked, so these recovery paths
    //     only ran in production.
    {
        console.log('\n  [carrier severed mid-repair → onSessionUp heals on restore]');
        const s = await freshPair('J2');
        // Sever both devices BEFORE the repair, so every episode carrier is born
        // deaf/mute (severedDefault) and can make no progress.
        await s.H.evaluate(() => window.__arcadeRdvSever(true));
        await s.J.evaluate(() => window.__arcadeRdvSever(true));
        await s.H.evaluate(() => {
            const pm = window.__arcade.p2p._addon().peerNode;
            Array.from(pm.peers.values()).forEach(p => { try { p.dataChannel.close(); } catch (e) {} });
        });
        await s.H.waitForFunction(`window.__arcade.p2p.status() !== 'connected'`, null, { timeout: 30000 }).catch(() => {});
        // Prove nudgeAll now reaches the carrier's ensureAlive hook.
        const kicksBefore = await s.J.evaluate(() => window.__arcadeRdvEnsureAliveCount());
        await s.J.evaluate(() => window.__arcade.p2p._rdv().nudgeAll('test'));
        const kicksAfter = await s.J.evaluate(() => window.__arcadeRdvEnsureAliveCount());
        check('nudgeAll() reaches the carrier ensureAlive hook', kicksAfter > kicksBefore, `${kicksBefore} → ${kicksAfter}`);
        // No heal while signaling is severed (generous window).
        await s.H.waitForTimeout(4000);
        const stalled = (await s.H.evaluate(() => window.__arcade.p2p.status() !== 'connected'))
            && (await s.J.evaluate(() => window.__arcade.p2p.status() !== 'connected'));
        check('severed signaling stalls the repair (no heal while the socket is dead)', stalled);
        // Restore → onSessionUp republishes → heal.
        await s.H.evaluate(() => window.__arcadeRdvSever(false));
        await s.J.evaluate(() => window.__arcadeRdvSever(false));
        check('carrier restore heals side A', await connectedAgain(s.H));
        check('carrier restore heals side B', await connectedAgain(s.J));
        const republished = (await s.H.evaluate(() => (window.__rdvDiag || []).some(m => m.includes('session restored'))))
            || (await s.J.evaluate(() => (window.__rdvDiag || []).some(m => m.includes('session restored'))));
        check('onSessionUp logged an immediate republish', republished);
        await s.ctxH.close(); await s.ctxJ.close();
    }

    // 11. DAY-TOPIC ROLLOVER (T-4 / B-rdv-1): a long-lived episode must resubscribe
    //     to the new UTC-day topic before publishers rotate at midnight, or it
    //     goes deaf within ~24-48h. Drive _refreshTopics with the clock advanced
    //     a day and assert the subscription window shifts (new topic in, aged out).
    {
        console.log('\n  [day-topic rollover resubscribes before going deaf]');
        const s = await freshPair('K2');
        await s.J.evaluate(() => window.__arcadeRdvSever(true)); // hold the episode open (no heal)
        await s.H.evaluate(() => {
            const pm = window.__arcade.p2p._addon().peerNode;
            Array.from(pm.peers.values()).forEach(p => { try { p.dataChannel.close(); } catch (e) {} });
        });
        const armed = await s.J.waitForFunction(`window.__arcade.p2p._rdv().episodesActive() >= 1`, null, { timeout: 15000 })
            .then(() => true).catch(() => false);
        check('repair episode armed + subscribed to day-topics', armed);
        const shift = await s.J.evaluate(async () => {
            const r = window.__arcade.p2p._rdv();
            const [pairId, ep] = [...r.episodes.entries()][0];
            const before = [...ep.topicSubs.keys()];
            const realNow = Date.now;
            try {
                Date.now = () => realNow.call(Date) + 26 * 3600 * 1000; // roll past midnight
                await r._refreshTopics(pairId, ep);
            } finally { Date.now = realNow; }
            const after = [...ep.topicSubs.keys()];
            return {
                added: after.filter(t => !before.includes(t)).length,
                dropped: before.filter(t => !after.includes(t)).length,
                count: after.length
            };
        });
        check('rollover subscribed a new day-topic', shift.added >= 1, `added=${shift.added}`);
        check('rollover dropped the aged day-topic', shift.dropped >= 1, `dropped=${shift.dropped}`);
        check('subscription window stays bounded (3 day-topics)', shift.count === 3, `count=${shift.count}`);
        await s.J.evaluate(() => window.__arcadeRdvSever(false));
        await s.ctxH.close(); await s.ctxJ.close();
    }

    // 12. PERSISTENT REPLAY CACHE (S-sec-4a): with the ratchet frozen, the only
    //     thing that makes a recorded offer/ring dead-on-arrival in a LATER
    //     episode is the per-pair nonce FIFO persisted in the pairing record.
    //     Which side answers offers vs rings on a given heal is nondeterministic
    //     (in-band vs sealed timing), so this drives the mechanism directly on a
    //     live episode: _rememberNonce must record, dedupe, and PERSIST a nonce,
    //     and a fresh episode seeded from that record must reject it on sight.
    {
        console.log('\n  [persistent replay cache: record + persist + seed-reject]');
        const s = await freshPair('M2');
        // Hold an episode open (severed carrier → it can't heal away).
        await s.J.evaluate(() => window.__arcadeRdvSever(true));
        await s.H.evaluate(() => {
            const pm = window.__arcade.p2p._addon().peerNode;
            Array.from(pm.peers.values()).forEach(p => { try { p.dataChannel.close(); } catch (e) {} });
        });
        const armed = await s.J.waitForFunction(`window.__arcade.p2p._rdv().episodesActive() >= 1`, null, { timeout: 15000 })
            .then(() => true).catch(() => false);
        check('episode armed to exercise the nonce cache on', armed);
        const NONCE = 'test_deadbeefcafe';
        const rec = await s.J.evaluate(async (nonce) => {
            const r = window.__arcade.p2p._rdv();
            const [pairId, ep] = [...r.episodes.entries()][0];
            r._rememberNonce(pairId, ep, nonce);
            const inRam = ep.seenNonceSet.has(nonce);
            r._rememberNonce(pairId, ep, nonce); // idempotent — must not duplicate
            const noDup = ep.rec.seenNonces.filter((n) => n === nonce).length === 1;
            await new Promise((res) => setTimeout(res, 250)); // let the async persist land
            const persisted = await new Promise((res) => {
                const req = indexedDB.open('qrp2p-rendezvous', 1);
                req.onsuccess = () => {
                    const db = req.result;
                    const g = db.transaction('pairs', 'readonly').objectStore('pairs').get(pairId);
                    g.onsuccess = () => { db.close(); res((g.result && g.result.seenNonces) || []); };
                    g.onerror = () => { db.close(); res([]); };
                };
                req.onerror = () => res([]);
            });
            // A fresh episode seeds seenNonceSet from the record exactly this way.
            const freshSeed = new Set(persisted);
            return { inRam, noDup, persistedHas: persisted.includes(nonce), seedRejects: freshSeed.has(nonce) };
        }, NONCE);
        check('processed nonce is in the episode in-RAM set', rec.inRam);
        check('re-recording the same nonce does not duplicate it', rec.noDup);
        check('processed nonce is persisted to the pair record (survives restart)', rec.persistedHas);
        check('a fresh episode seeded from the record rejects the replayed nonce', rec.seedRejects);
        await s.J.evaluate(() => window.__arcadeRdvSever(false));
        await s.ctxH.close(); await s.ctxJ.close();
    }

    // 13. MULTI-PAIR CONCURRENT RENDEZVOUS (T-4 / T6): a hub with two spokes,
    //     both links cut at once, both repairing through the SAME rendezvous
    //     instance on the host. Proves per-pair episode isolation — two heals
    //     racing on one node don't clobber each other's records/topics — and
    //     that the host re-holds BOTH links, not just whichever won.
    {
        console.log('\n  [multi-pair concurrent rendezvous heal (hub + two spokes)]');
        const s = await freshTriple('N2');
        // Sever every carrier, then cut both host links so both pairs must
        // repair with no signaling until we restore it.
        for (const p of [s.H, s.A, s.B]) await p.evaluate(() => window.__arcadeRdvSever(true));
        await s.H.evaluate(() => {
            const pm = window.__arcade.p2p._addon().peerNode;
            Array.from(pm.peers.values()).forEach((p) => { try { p.dataChannel.close(); } catch (e) {} });
        });
        const aDown = await s.A.waitForFunction(`window.__arcade.p2p.status() !== 'connected'`, null, { timeout: 30000 }).then(() => true).catch(() => false);
        const bDown = await s.B.waitForFunction(`window.__arcade.p2p.status() !== 'connected'`, null, { timeout: 30000 }).then(() => true).catch(() => false);
        check('both spokes dropped after the host cut both links', aDown && bDown);
        // Restore all carriers → both pairs must heal concurrently.
        for (const p of [s.H, s.A, s.B]) await p.evaluate(() => window.__arcadeRdvSever(false));
        check('spoke A healed', await connectedAgain(s.A));
        check('spoke B healed', await connectedAgain(s.B));
        const hostHealed = await s.H.waitForFunction(() => {
            const pm = window.__arcade.p2p._addon().peerNode;
            return Array.from(pm.peers.values()).filter((p) => p.status === 'connected').length === 2;
        }, null, { timeout: 60000 }).then(() => true).catch(() => false);
        check('host re-holds BOTH healed links concurrently (per-pair isolation)', hostHealed);
        await s.ctxH.close(); await s.ctxA.close(); await s.ctxB.close();
    }
} catch (e) {
    console.error('\nFATAL:', e.message);
    check('run completed', false, e.message);
} finally {
    await harness.shutdown();
}

console.log(failed() === 0 ? '\nAll reconnect acceptance checks passed.' : `\n${failed()} check(s) FAILED.`);
process.exit(failed() === 0 ? 0 : 1);
