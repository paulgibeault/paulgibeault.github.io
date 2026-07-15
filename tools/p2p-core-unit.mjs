/* p2p-core-unit.mjs — hermetic Node unit tests for the p2p-core transport
 * hardening that the browser acceptance harnesses can't drive precisely (they
 * can't hand-craft a hostile control frame or a forged fingerprint). Covers the
 * issue #21 residual fixes:
 *   • generateId()        — CSPRNG, unguessable link identity
 *   • _clampSeq()         — ack/resync bounds (no MAX_SAFE_INTEGER outbox wipe)
 *   • _sessionResumable() — stash TTL + DTLS-fingerprint binding on resume
 *   • _onChannelMessage() — oversized app-frame drop (relay amplification cap)
 *
 * PeerManager instantiates headless: it only touches RTCPeerConnection inside
 * connection methods, and its visibilitychange listener is `typeof document`
 * guarded. No browser, no network. Run: `npm run p2p-core-unit`.
 */
import { PeerManager } from '../p2p/p2p-core.js';

let pass = 0, fail = 0;
function ok(cond, label) {
    if (cond) { pass++; console.log('  ✓ ' + label); }
    else { fail++; console.log('  ✗ ' + label); }
}

function idTests() {
    console.log('\ngenerateId — unguessable link identity');
    const pm = new PeerManager();
    const ids = new Set();
    const N = 20000;
    for (let i = 0; i < N; i++) ids.add(pm.generateId());
    ok(ids.size === N, `no collisions across ${N} ids (${ids.size} unique)`);
    const sample = pm.generateId();
    ok(/^[0-9a-z]+$/.test(sample), 'id is base36 lowercase-alnum');
    ok(sample.length >= 20, `id is wide (${sample.length} chars ≈ 96 bits, was 36 bits)`);
    ok(pm.myId && typeof pm.myId === 'string' && pm.myId.length >= 20, 'constructor seeds myId from the CSPRNG id');
}

function clampTests() {
    console.log('\n_clampSeq — ack/resync sequence bounds');
    const pm = new PeerManager();
    ok(pm._clampSeq(Number.MAX_SAFE_INTEGER, 5) === 5, 'huge value clamps to outSeq (no over-prune)');
    ok(pm._clampSeq(3, 5) === 3, 'in-range value passes through');
    ok(pm._clampSeq(5, 5) === 5, 'exactly outSeq passes through');
    ok(pm._clampSeq(-1, 5) === null, 'negative rejected');
    ok(pm._clampSeq(NaN, 5) === null, 'NaN rejected');
    ok(pm._clampSeq(2.5, 5) === null, 'non-integer rejected');
    ok(pm._clampSeq('4', 5) === null, 'string rejected');

    // End-to-end through the control handler. The sharp defect the clamp closes:
    // NaN passes `typeof === 'number'`, and `filter(e => e.seq > NaN)` is always
    // false — so a resync/ack carrying NaN silently WIPED the whole outbox and
    // defeated replay. The clamp rejects it (and negatives/floats) outright.
    const mkPeer = () => ({ outbox: [{seq:1,wire:'a'},{seq:2,wire:'b'},{seq:3,wire:'c'}], outSeq: 3, dataChannel: null, resyncTimer: null });
    pm.peers.set('P', mkPeer());
    pm._handleControl('P', { __p2pc: 'resync', have: NaN });
    ok(pm.peers.get('P').outbox.length === 3, 'resync:NaN leaves the outbox intact (was: silent wipe → no replay)');
    pm._handleControl('P', { __p2pc: 'ack', upTo: NaN });
    ok(pm.peers.get('P').outbox.length === 3, 'ack:NaN leaves the outbox intact');
    pm._handleControl('P', { __p2pc: 'ack', upTo: -9 });
    ok(pm.peers.get('P').outbox.length === 3, 'ack:negative is rejected (no change)');
    // Legitimate acks still prune, and a value past outSeq clamps to it (a peer
    // can only ever ack what we actually sent — never beyond).
    pm._handleControl('P', { __p2pc: 'ack', upTo: 2 });
    ok(pm.peers.get('P').outbox.length === 1 && pm.peers.get('P').outbox[0].seq === 3, 'ack:2 prunes seq ≤ 2, keeps seq 3');
    pm._handleControl('P', { __p2pc: 'ack', upTo: Number.MAX_SAFE_INTEGER });
    ok(pm.peers.get('P').outbox.length === 0, 'ack:MAX clamps to outSeq (acks everything sent) — no out-of-range prune');
}

function resumeTests() {
    console.log('\n_sessionResumable — stash TTL + fingerprint binding');
    const pm = new PeerManager();
    const now = Date.now();
    const fresh = { stashedAt: now, peerFingerprint: 'AA:BB:CC' };
    const noFp = { stashedAt: now, peerFingerprint: null };
    const stale = { stashedAt: now - 13 * 3600 * 1000, peerFingerprint: 'AA:BB:CC' };
    const connMatch = { remoteDescription: { sdp: 'a=fingerprint:sha-256 AA:BB:CC\r\n' } };
    const connDiff = { remoteDescription: { sdp: 'a=fingerprint:sha-256 DD:EE:FF\r\n' } };

    ok(pm._sessionResumable(fresh, connMatch) === true, 'matching fingerprint within TTL → resume');
    ok(pm._sessionResumable(fresh, connDiff) === false, 'different fingerprint → refuse (no outbox leak to a new device)');
    ok(pm._sessionResumable(stale, connMatch) === false, 'aged-out stash → refuse even on a fingerprint match');
    ok(pm._sessionResumable(fresh, {}) === true, 'no remote description yet → allow (only refuse on positive mismatch)');
    ok(pm._sessionResumable(noFp, connMatch) === true, 'no stashed fingerprint → allow (cannot prove a mismatch)');
    ok(pm._sessionResumable(null, connMatch) === false, 'nothing to inherit → not resumable');

    // The snapshot records the current remote fingerprint so a later resume can
    // check it. (extractFingerprint uppercases; assert the captured shape.)
    const peerData = { type: 'client', outSeq: 4, lastInSeq: 2, outbox: [], outboxOverflowed: false,
        connection: { remoteDescription: { sdp: 'a=fingerprint:sha-256 aa:bb:cc\r\n' } } };
    const snap = pm._sessionSnapshot(peerData);
    ok(snap.peerFingerprint === 'AA:BB:CC', 'snapshot captures the (uppercased) remote fingerprint');
    ok(typeof snap.stashedAt === 'number', 'snapshot stamps stashedAt for the TTL check');
}

function frameSizeTests() {
    console.log('\n_onChannelMessage — oversized app-frame drop');
    const pm = new PeerManager();
    pm.isHost = false; // no relay loop; isolate the size gate
    pm.peers.set('P', { status: 'connected', lastInSeq: 0, outSeq: 0, outbox: [] });

    let dropped = 0, delivered = 0;
    pm.addEventListener('diagnostic', (e) => { if (/oversized app frame/.test(e.detail.msg)) dropped++; });
    pm.addEventListener('message', () => { delivered++; });

    // A frame just over the default 256 KB cap.
    const huge = JSON.stringify({ text: 'x'.repeat(pm.options.maxAppFrameBytes + 10), from: 'P' });
    pm._onChannelMessage('P', huge);
    ok(dropped === 1 && delivered === 0, 'frame over maxAppFrameBytes is dropped, never dispatched');

    // A normal small frame still flows.
    pm._onChannelMessage('P', JSON.stringify({ text: 'hello', from: 'P' }));
    ok(delivered === 1, 'a normal-sized frame is dispatched');

    // Control frames are exempt from the app-frame cap (they never carry bulk).
    ok(pm.options.maxAppFrameBytes === 256 * 1024, 'default cap is 256 KB');
}

(async () => {
    console.log('p2p-core unit tests — transport hardening (issue #21 residuals)');
    idTests();
    clampTests();
    resumeTests();
    frameSizeTests();
    console.log('');
    if (fail) { console.log(fail + ' check(s) FAILED.'); process.exit(1); }
    console.log('All ' + pass + ' p2p-core unit checks passed.');
})();
