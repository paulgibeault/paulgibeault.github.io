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

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4795;
const DROP_PORT = 4794;
const BASE = `http://127.0.0.1:${PORT}`;

// In-test dead-drop. Deliberately REPLAYS full history to new subscribers —
// harsher than real MQTT — because the protocol must tolerate stale blobs.
const dropTopics = new Map();
const dropServer = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const u = new URL(req.url, 'http://x');
    const topic = u.searchParams.get('t') || '';
    if (req.method === 'POST' && u.pathname === '/pub') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            if (!dropTopics.has(topic)) dropTopics.set(topic, []);
            dropTopics.get(topic).push(body);
            res.end('ok');
        });
    } else if (u.pathname === '/sub') {
        const arr = dropTopics.get(topic) || [];
        const since = parseInt(u.searchParams.get('since') || '0', 10);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ msgs: arr.slice(since), next: arr.length }));
    } else res.end('');
});
dropServer.listen(DROP_PORT);

const HTTP_CARRIER = `
    window.__arcadeRdvCarrierFactory = () => ({
        base: 'http://127.0.0.1:${DROP_PORT}',
        subs: new Map(),
        timer: null,
        async connect() { if (!this.timer) this.timer = setInterval(() => this._poll(), 120); },
        async _poll() {
            for (const [topic, st] of this.subs) {
                try {
                    const r = await fetch(this.base + '/sub?t=' + topic + '&since=' + st.next);
                    const j = await r.json();
                    st.next = j.next;
                    j.msgs.forEach(m => st.cbs.forEach(cb => { try { cb(m); } catch (e) {} }));
                } catch (e) {}
            }
        },
        async publish(topic, payload) { await fetch(this.base + '/pub?t=' + topic, { method: 'POST', body: payload }); },
        subscribe(topic, cb) {
            if (!this.subs.has(topic)) this.subs.set(topic, { next: 0, cbs: new Set() });
            const st = this.subs.get(topic);
            st.cbs.add(cb);
            return () => st.cbs.delete(cb);
        },
        close() { clearInterval(this.timer); this.timer = null; this.subs.clear(); }
    });
`;
const FORCE_LOCAL_ICE = `
    const OrigRTC = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends OrigRTC {
        constructor(cfg = {}) { super({ ...cfg, iceServers: [] }); }
    };
`;

let failures = 0;
function check(name, ok, detail) {
    console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures++;
}

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', ROOT], { stdio: 'ignore' });
for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/index.html`)).ok) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 100));
}

const browser = await chromium.launch({
    channel: 'chrome', headless: true,
    args: ['--disable-features=WebRtcHideLocalIpsWithMdns']
});

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
})()`;

async function launcherPage(label, context) {
    const page = await context.newPage();
    page.on('pageerror', err => console.error(`  [${label} pageerror]`, err.message));
    await page.goto(`${BASE}/`);
    await page.waitForFunction('!!window.__arcade && !!window.__arcade.showGame');
    return page;
}

async function loadBridge(page) {
    await page.evaluate(() => document.getElementById('menu-multiplayer').click());
    await page.evaluate(() => document.getElementById('connections-dialog-new').click());
    await page.waitForFunction('!!window.__arcade.p2p && !!window.__arcade.p2p._addon()', null, { timeout: 15000 });
    await page.evaluate(() => {
        const overlay = document.getElementById('p2p-modal-overlay');
        if (overlay) overlay.style.display = 'none';
        if (window.__arcade.closeConnectionsDialog) window.__arcade.closeConnectionsDialog();
    });
    await page.evaluate(FAST_RDV);
}

async function ceremony(H, J) {
    const packedOffer = await H.evaluate(async () => {
        const { ConnectionUtils } = await import('./p2p/p2p-core.js');
        return await ConnectionUtils.encodePayload(await window.__arcade.p2p._addon().peerNode.createOffer());
    });
    const packedAnswer = await J.evaluate(async (packed) => {
        const { ConnectionUtils } = await import('./p2p/p2p-core.js');
        const offer = await ConnectionUtils.decodePayload(packed);
        return await ConnectionUtils.encodePayload(await window.__arcade.p2p._addon().peerNode.createAnswer(offer));
    }, packedOffer);
    await H.evaluate(async (packed) => {
        const { ConnectionUtils } = await import('./p2p/p2p-core.js');
        await window.__arcade.p2p._addon().peerNode.acceptAnswer(await ConnectionUtils.decodePayload(packed));
    }, packedAnswer);
    await H.waitForFunction(`window.__arcade.p2p.status() === 'connected'`, null, { timeout: 20000 });
    await J.waitForFunction(`window.__arcade.p2p.status() === 'connected'`, null, { timeout: 20000 });
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
    const ctxH = await browser.newContext();
    const ctxJ = await browser.newContext();
    await ctxH.addInitScript(FORCE_LOCAL_ICE + HTTP_CARRIER);
    await ctxJ.addInitScript(FORCE_LOCAL_ICE + HTTP_CARRIER);
    const H = await launcherPage(tag + ':host', ctxH);
    const J = await launcherPage(tag + ':joiner', ctxJ);
    await loadBridge(H); await loadBridge(J);
    await ceremony(H, J);
    await pairBoth(H, J);
    return { ctxH, ctxJ, H, J };
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
        const stillArmed = await s.J.evaluate(() => window.__arcade.p2p._rdv().episodes.size);
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
                episodes: window.__arcade.p2p._rdv().episodes.size,
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
            `window.__arcade.p2p._rdv().episodes.size === 1`, null, { timeout: 30000 }
        ).then(() => true).catch(() => false);
        check('stale episode armed while the peer is unreachable', armed);

        // Fresh manual ceremony (new transport peerIds). The identity
        // handshake re-pairs automatically — both sides still have
        // autoReconnect on — and the fresh secret must supersede.
        await ceremony(s.H, s.J);
        const staleCancelled = await s.H.waitForFunction(
            `window.__arcade.p2p._rdv().episodes.size === 0`, null, { timeout: 15000 }
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
            episodes: window.__arcade.p2p._rdv().episodes.size,
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
            const armed = await s.H.evaluate(() => window.__arcade.p2p._rdv().episodes.size);
            check('…and no episode armed for the hung-up pair (still deaf)', armed === 0, `episodes=${armed}`);

            const tried = await s.H.evaluate((d) => window.__arcade.p2p.callKnownPeer(d), devOnH);
            check('Call after restart reports an attempt (secret persisted)', tried === true, String(tried));
            check('call landed: reopened caller connected', await connectedAgain(s.H));
            check('call landed: waiting callee connected', await connectedAgain(s.J));
        }
        await s.ctxH.close(); await s.ctxJ.close();
    }
} catch (e) {
    console.error('\nFATAL:', e.message);
    failures++;
} finally {
    await browser.close();
    server.kill();
    dropServer.close();
}

console.log(failures === 0 ? '\nAll reconnect acceptance checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
