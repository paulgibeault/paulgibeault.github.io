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
import http from 'node:http';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4799;
const DROP_PORT = 4798;
const BASE = `http://127.0.0.1:${PORT}`;

// In-test dead-drop standing in for the public MQTT broker: the rendezvous
// carrier is override-injected (window.__arcadeRdvCarrierFactory), so the
// acceptance run never touches external infrastructure.
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
// Hermetic: never touch external STUN; loopback host candidates suffice.
const FORCE_LOCAL_ICE = `
    const OrigRTC = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends OrigRTC {
        constructor(cfg = {}) { super({ ...cfg, iceServers: [] }); }
    };
`;
// SEPARATE contexts per simulated device: distinct localStorage + IndexedDB,
// so deviceIds and identity certificates genuinely differ like real devices.
const contextH = await browser.newContext();
const contextJ = await browser.newContext();
await contextH.addInitScript(FORCE_LOCAL_ICE + HTTP_CARRIER);
await contextJ.addInitScript(FORCE_LOCAL_ICE + HTTP_CARRIER);

async function launcherPage(label, context) {
    const page = await context.newPage();
    page.on('pageerror', err => console.error(`  [${label} pageerror]`, err.message));
    await page.goto(`${BASE}/`);
    await page.waitForFunction('!!window.__arcade && !!window.__arcade.showGame');
    return page;
}

try {
    console.log('\nP2P acceptance — launcher-owned multiplayer\n');

    const H = await launcherPage('host', contextH);
    const J = await launcherPage('joiner', contextJ);

    // 1. Load the bridge on both, as a real user would: open the single
    //    Multiplayer menu item (the hub dialog), then "New connection" —
    //    that's what actually initializes the transport (ensureAddon()).
    for (const [page, label] of [[H, 'host'], [J, 'joiner']]) {
        await page.evaluate(() => document.getElementById('menu-multiplayer').click());
        await page.evaluate(() => document.getElementById('connections-dialog-new').click());
        await page.waitForFunction('!!window.__arcade.p2p && !!window.__arcade.p2p._addon()', null, { timeout: 15000 });
        check(`${label}: bridge + vendored transport loaded (no CDN)`, true);
    }

    // 2. Signaling ceremony at the transport level (stands in for QR / link
    //    tennis — the human-carried exchange, exercised manually via the
    //    launcher's Multiplayer panel; see p2p/PROTOCOL.md §4).
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
    // Poll for the fixture frame: attachment and URL assignment lag the
    // showGame() call, and a frames() snapshot taken too early returns
    // undefined on slow CI runners (same helper as the multiseat script).
    async function fixtureFrame(page) {
        for (let i = 0; i < 100; i++) {
            const f = page.frames().find(fr => fr.url().includes('p2p-test-game'));
            if (f) return f;
            await new Promise(r => setTimeout(r, 100));
        }
        throw new Error('fixture frame never attached');
    }
    const fH = await fixtureFrame(H), fJ = await fixtureFrame(J);
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
    failures++;
} finally {
    await browser.close();
    server.kill();
}

console.log(failures === 0 ? '\nAll P2P acceptance checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
