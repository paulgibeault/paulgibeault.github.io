/* p2p-core-unit.mjs — hermetic Node unit tests for the p2p-core transport
 * hardening that the browser acceptance harnesses can't drive precisely (they
 * can't hand-craft a hostile control frame or a forged fingerprint). Covers the
 * issue #21 residual fixes:
 *   • generateId()        — CSPRNG, unguessable link identity
 *   • _clampSeq()         — ack/resync bounds (no MAX_SAFE_INTEGER outbox wipe)
 *   • _sessionResumable() — stash TTL + DTLS-fingerprint binding on resume
 *   • _onChannelMessage() — oversized app-frame drop (relay amplification cap)
 * plus the v1.12 read model — the accessor contract arcade-p2p.js/p2p-ui.js
 * (and the rendezvous side's episodesActive()) depend on instead of reaching
 * into `peers`/`sessionStash`/`options`.
 *
 * PeerManager instantiates headless: it only touches RTCPeerConnection inside
 * connection methods, and its visibilitychange listener is `typeof document`
 * guarded. No browser, no network. Run: `npm run p2p-core-unit`.
 */
import { PeerManager } from '../p2p/p2p-core.js';
import { RendezvousManager } from '../p2p/rendezvous.js';

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

// A minimal live-peer entry that survives _teardownPeer (fake connection).
const fakePeer = (status, extra = {}) => ({
    status,
    connection: { close() {}, onicecandidate: null },
    dataChannel: null,
    outbox: [],
    ...extra,
});

function readModelTests() {
    console.log('\nread model — the accessor contract consumers use instead of peers/sessionStash/options');

    // hasLink / linkStatus
    const pm = new PeerManager();
    pm.peers.set('C', fakePeer('connected'));
    pm.peers.set('I', fakePeer('interrupted'));
    pm.peers.set('F', fakePeer('finalizing'));
    ok(pm.hasLink('C') === true && pm.hasLink('nope') === false, 'hasLink: live entry true, unknown false');
    ok(pm.linkStatus('C') === 'connected' && pm.linkStatus('I') === 'interrupted', 'linkStatus reports the raw transport status');
    ok(pm.linkStatus('nope') === null, 'linkStatus: no live entry → null');

    // hasStashedSession
    pm.sessionStash.set('S', { type: 'client', outbox: [] });
    ok(pm.hasStashedSession('S') === true && pm.hasStashedSession('C') === false, 'hasStashedSession tracks the stash only');

    // hostLinkId — joiner resolves live first, then stash; a host gets null
    const joiner = new PeerManager();
    joiner.peers.set('h1', fakePeer('connected', { type: 'host' }));
    joiner.sessionStash.set('h2', { type: 'host', outbox: [] });
    ok(joiner.hostLinkId() === 'h1', 'hostLinkId prefers the live host-typed entry');
    joiner.peers.delete('h1');
    ok(joiner.hostLinkId() === 'h2', 'hostLinkId falls back to a stashed host session (repair window)');
    joiner.sessionStash.delete('h2');
    ok(joiner.hostLinkId() === null, 'hostLinkId: nothing host-typed anywhere → null');
    const host = new PeerManager();
    host.isHost = true;
    host.peers.set('j1', fakePeer('connected', { type: 'client' }));
    ok(host.hostLinkId() === null, 'hostLinkId on a host node → null (its links are joiners)');

    // abandonPending — ceremony leftovers dropped via disconnectPeer,
    // established sessions (connected AND interrupted) untouched.
    const pm2 = new PeerManager();
    pm2.peers.set('C', fakePeer('connected'));
    pm2.peers.set('I', fakePeer('interrupted'));
    pm2.peers.set('F', fakePeer('finalizing'));
    pm2.peers.set('N', fakePeer('new'));
    const terminal = [];
    pm2.addEventListener('status', (e) => { if (e.detail.status === 'disconnected') terminal.push(e.detail.peerId); });
    pm2.abandonPending();
    ok(pm2.hasLink('C') && pm2.hasLink('I'), 'abandonPending keeps connected and interrupted (mid-repair) links');
    ok(!pm2.hasLink('F') && !pm2.hasLink('N'), 'abandonPending drops every unfinished ceremony');
    ok(terminal.sort().join(',') === 'F,N', 'each drop routes through disconnectPeer (terminal status event fired)');

    // outboxSnapshot — deepest outbox across live links AND stashed sessions
    const pm3 = new PeerManager();
    pm3.peers.set('A', fakePeer('connected', { outbox: [1, 2, 3] }));
    pm3.peers.set('B', fakePeer('connected', { outbox: [1], outboxOverflowed: true }));
    pm3.sessionStash.set('Z', { outbox: [1, 2, 3, 4, 5] });
    const snap = pm3.outboxSnapshot();
    ok(snap.depth === 5, `outboxSnapshot.depth is the deepest queue incl. the stash (${snap.depth})`);
    ok(snap.overflowed === true, 'outboxSnapshot.overflowed surfaces any per-link overflow');
    ok(snap.limit === pm3.options.outboxLimit, 'outboxSnapshot.limit mirrors the configured cap');

    // getConfig / setConfig — snapshot is a copy; only tunable knobs apply
    const pm4 = new PeerManager();
    const cfg = pm4.getConfig();
    cfg.connectionTimeoutMs = 1;
    ok(pm4.options.connectionTimeoutMs !== 1, 'getConfig returns a copy (mutating it changes nothing)');
    const applied = pm4.setConfig({ connectionTimeoutMs: 120000, iceMode: 'local', allowIPv6Candidates: false });
    ok(applied.connectionTimeoutMs === 120000 && applied.iceMode === 'local' && applied.allowIPv6Candidates === false,
        'setConfig applies the tunable knobs and returns the resulting snapshot');
    ok(pm4.setConfig({ iceMode: 'weird' }).iceMode === 'anywhere', 'setConfig normalizes an unknown iceMode to anywhere');
    pm4.setConfig({ outboxLimit: 1, maxAppFrameBytes: 1, nonsense: true });
    ok(pm4.options.outboxLimit !== 1 && pm4.options.maxAppFrameBytes !== 1,
        'setConfig ignores non-tunable and unknown keys (construction-fixed knobs stay put)');

    // episodesActive — the rendezvous side of the read model
    const rdv = new RendezvousManager(new PeerManager(), {});
    rdv.episodes.set('p1', { settled: false });
    rdv.episodes.set('p2', { settled: true });
    rdv.episodes.set('p3', { settled: false });
    ok(rdv.episodesActive() === 2, 'episodesActive counts only unsettled episodes');
    rdv.episodes.clear();
    ok(rdv.episodesActive() === 0, 'episodesActive: no episodes → 0');
    rdv.destroy();
}

(async () => {
    console.log('p2p-core unit tests — transport hardening (issue #21 residuals)');
    idTests();
    clampTests();
    resumeTests();
    frameSizeTests();
    readModelTests();
    console.log('');
    if (fail) { console.log(fail + ' check(s) FAILED.'); process.exit(1); }
    console.log('All ' + pass + ' p2p-core unit checks passed.');
})();
