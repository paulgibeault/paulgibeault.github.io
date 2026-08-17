/* p2p-core-unit.mjs — hermetic Node unit tests for the p2p-core transport
 * hardening that the browser acceptance harnesses can't drive precisely (they
 * can't hand-craft a hostile control frame or a forged fingerprint). Covers the
 * issue #21 residual fixes:
 *   • generateId()        — CSPRNG, unguessable link identity
 *   • _clampSeq()         — ack/resync bounds (no MAX_SAFE_INTEGER outbox wipe)
 *   • _sessionResumable() — stash TTL + DTLS-fingerprint binding on resume
 *   • _onChannelMessage() — oversized app-frame drop
 * plus the v1.12 read model — the accessor contract arcade-p2p.js/p2p-ui.js
 * (and the rendezvous side's episodesActive()) depend on instead of reaching
 * into `peers`/`sessionStash`/`options` — and the v1.14 NO-RELAY invariant
 * (PROTOCOL §5.6), which is the load-bearing one: it is asserted as a
 * negation, so it fails the moment any forwarding path comes back.
 *
 * PeerManager instantiates headless: it only touches RTCPeerConnection inside
 * connection methods, and its visibilitychange listener is `typeof document`
 * guarded. No browser, no network. Run: `npm run p2p-core-unit`.
 */
import { PeerManager, ConnectionUtils } from '../p2p/p2p-core.js';
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
    host.peers.set('j1', fakePeer('connected', { type: 'client' }));
    ok(host.hostLinkId() === null, 'hostLinkId on an inviter node → null (its links are all joiners, none typed host)');

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

    // episodesActive — the rendezvous side of the read model. Counts LIVE
    // episode machines (scheduled/starting pairs are pending, not active).
    const rdv = new RendezvousManager(new PeerManager(), {});
    rdv._machine('p1').lifecycle = 'live';
    rdv._machine('p2'); // idle
    rdv._machine('p3').lifecycle = 'scheduled';
    rdv._machine('p4').lifecycle = 'live';
    ok(rdv.episodesActive() === 2, 'episodesActive counts only live episode machines');
    rdv.machines.clear();
    ok(rdv.episodesActive() === 0, 'episodesActive: no machines → 0');
    rdv.destroy();
}

function minifySdpTests() {
    console.log('\nminifySDP — candidate cap (QR density, field report 2026-07-17)');
    const cand = (foundation, protocol, address, port, type) =>
        `a=candidate:${foundation} 1 ${protocol} 2113937151 ${address} ${port} typ ${type} generation 0`;
    const sdp = [
        'v=0', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
        cand(1, 'udp', '11111111-2222-3333-4444-555555555555.local', 50001, 'host'), // mDNS #1
        cand(2, 'udp', '66666666-7777-8888-9999-aaaaaaaaaaaa.local', 50002, 'host'), // mDNS #2 (redundant)
        cand(3, 'udp', '192.168.1.10', 50003, 'host'),                               // host v4
        cand(4, 'udp', '2001:db8::1', 50004, 'host'),                                // host v6 #1
        cand(5, 'udp', '2001:db8::2', 50005, 'host'),                                // host v6 #2 (privacy addr, redundant)
        cand(6, 'udp', '2001:db8::3', 50006, 'host'),                                // host v6 #3 (redundant)
        cand(7, 'udp', '203.0.113.7', 50007, 'srflx'),                               // srflx v4
        cand(8, 'udp', '203.0.113.8', 50008, 'srflx'),                               // srflx v4 #2 (redundant)
        cand(9, 'tcp', '192.168.1.10', 9, 'host'),                                   // tcp (always dropped)
        cand(10, 'udp', '198.51.100.9', 50009, 'relay'),                             // relay v4 (kept — TURN path)
        'a=ice-ufrag:abcd', 'a=ice-pwd:0123456789012345678901', ''
    ].join('\r\n');

    const kept = ConnectionUtils.minifySDP(sdp).split('\r\n').filter(l => l.startsWith('a=candidate:'));
    ok(kept.length === 5, `one candidate per (type × family) survives (${kept.length}/10: mdns, host v4, host v6, srflx v4, relay v4)`);
    ok(kept.some(l => l.includes('11111111-2222')) && !kept.some(l => l.includes('66666666-7777')),
        'first mDNS kept, second dropped');
    ok(kept.some(l => l.includes('2001:db8::1')) && !kept.some(l => l.includes('2001:db8::2')),
        'first host IPv6 kept, privacy-address duplicates dropped');
    ok(kept.some(l => l.includes('203.0.113.7')) && !kept.some(l => l.includes('203.0.113.8')),
        'first srflx kept, second dropped');
    ok(kept.some(l => l.includes('198.51.100.9')), 'relay candidate (TURN path) survives the cap');
    ok(!kept.some(l => l.includes(' tcp ')), 'tcp candidates still dropped');

    const noV6 = ConnectionUtils.minifySDP(sdp, { allowIPv6Candidates: false })
        .split('\r\n').filter(l => l.startsWith('a=candidate:'));
    ok(!noV6.some(l => l.includes('2001:db8')), 'allowIPv6Candidates:false still strips every IPv6');
    const noLocal = ConnectionUtils.minifySDP(sdp, { allowLocalCandidates: false })
        .split('\r\n').filter(l => l.startsWith('a=candidate:'));
    ok(!noLocal.some(l => l.includes('.local')), 'allowLocalCandidates:false still strips every mDNS');
    const nonCandLines = sdp.split('\r\n').filter(l => !l.startsWith('a=candidate:'));
    const outLines = ConnectionUtils.minifySDP(sdp).split('\r\n');
    ok(nonCandLines.every(l => outLines.includes(l)), 'non-candidate SDP lines pass through untouched');
}

// ==========================================
// NO RELAY (v1.14, PROTOCOL §5.6) — the successor to the v1.13 party tests,
// which proved a frame never crossed a party boundary. The property is
// stronger now and stated as a NEGATION: an inbound app frame is dispatched
// locally and re-emitted on NO other link, whatever its payload claims.
// Written this way on purpose — a positive test can pass while a forwarding
// path quietly returns; this one fails the moment one does.
// ==========================================

// Minimal RTCPeerConnection/RTCSessionDescription fakes so the ceremony
// entry points (createOffer/createAnswer success paths) run headless.
const FAKE_SDP = 'v=0\r\na=candidate:1 1 udp 2113937151 192.168.1.10 50001 typ host generation 0\r\na=fingerprint:sha-256 AA:BB:CC\r\na=ice-ufrag:abcd\r\n';
class FakeRTCPeerConnection {
    constructor() {
        this.localDescription = null;
        this.remoteDescription = null;
        this.iceGatheringState = 'complete';
        this.signalingState = 'stable';
        this.iceConnectionState = 'new';
        this.onicecandidate = null;
    }
    createDataChannel() { return { readyState: 'connecting', close() {}, send() {} }; }
    async createOffer() { return { type: 'offer', sdp: FAKE_SDP }; }
    async createAnswer() { return { type: 'answer', sdp: FAKE_SDP }; }
    async setLocalDescription(d) { this.localDescription = d; }
    async setRemoteDescription(d) { this.remoteDescription = d; }
    close() {}
}
const installFakeRtc = () => {
    globalThis.RTCPeerConnection = FakeRTCPeerConnection;
    globalThis.RTCSessionDescription = class { constructor(d) { Object.assign(this, d); } };
};

// A connected link with a capturing channel, so anything this node puts on
// the wire is observable. resyncFlushed lets _sendAppTo transmit immediately.
const wiredLink = (type, sentLog, id) => fakePeer('connected', {
    type, outSeq: 0, lastInSeq: 0, resyncFlushed: true, lastAliveAt: 0,
    everConnected: true,
    dataChannel: { readyState: 'open', send(w) { if (sentLog) sentLog.push([id, w]); } },
});
const appFrames = (log) => log.map(([id, w]) => [id, JSON.parse(w)]).filter(([, f]) => !f.__p2pc);

// Every shape a v1.13 hub would have fanned out, plus the ones a hostile
// sender would have used to steer the fan-out. All of them must now do
// nothing but arrive.
const NO_RELAY_CASES = [
    ['a plain broadcast frame', { text: 'x', from: 'spoofable', seq: 1 }],
    ['a frame claiming relayed:true', { text: 'y', from: 'nope', seq: 2, relayed: true }],
    ['a frame claiming noRelay:false', { text: 'z', from: 'nope', seq: 3, noRelay: false }],
    ['a frame naming another link as its origin', { text: 'w', from: 'a2', seq: 4 }],
];

function noRelayTests() {
    console.log('\nno relay (v1.14) — an inbound frame is delivered locally and re-emitted NOWHERE');
    const pm = new PeerManager();
    const sent = [];
    pm.peers.set('a1', wiredLink('client', sent, 'a1'));
    pm.peers.set('a2', wiredLink('client', sent, 'a2'));
    pm.peers.set('h1', wiredLink('host', sent, 'h1'));
    pm.sessionStash.set('s1', { type: 'client', outSeq: 0, outbox: [] });

    const delivered = [];
    pm.addEventListener('message', (e) => delivered.push(e.detail));

    // The whole point, case by case: arrival on ANY link, of ANY shape,
    // produces exactly one local dispatch and zero outbound app frames.
    for (const [label, frame] of NO_RELAY_CASES) {
        for (const arrival of ['a1', 'h1']) {
            sent.length = 0;
            delivered.length = 0;
            const before = pm.sessionStash.get('s1').outbox.length;
            pm._onChannelMessage(arrival, JSON.stringify({ ...frame, seq: frame.seq + 100 }));
            ok(delivered.length === 1, `${label} on ${arrival}: dispatched locally exactly once`);
            ok(appFrames(sent).length === 0, `${label} on ${arrival}: re-emitted on NO other link`);
            ok(pm.sessionStash.get('s1').outbox.length === before,
                `${label} on ${arrival}: no repairing stash inherits it either`);
        }
    }

    // The `relayed` flag survives to the layer above VERBATIM. It is reserved
    // legacy (PROTOCOL §5.1): this node never sets it, so a true value can
    // only be a pre-v1.14 hub's stamp — the bridge refuses such a frame, and
    // it can only do that if the transport stops rewriting the field.
    delivered.length = 0;
    pm._onChannelMessage('h1', JSON.stringify({ text: 'legacy', from: 'hub', seq: 900, relayed: true }));
    ok(delivered[0].relayed === true, 'an inbound relayed:true is reported verbatim (the bridge refuses it)');
    delivered.length = 0;
    pm._onChannelMessage('a1', JSON.stringify({ text: 'direct', from: 'a1', seq: 901 }));
    ok(delivered[0].relayed === false, 'a frame with no stamp reports relayed:false');

    // Nothing this node emits ever carries `relayed` — there is no path left
    // that could produce one.
    sent.length = 0;
    pm.broadcast({ text: 'mine', from: 'me', relayed: true });
    const emitted = appFrames(sent);
    ok(emitted.length === 3 && emitted.every(([, f]) => f.relayed === undefined),
        'the wire serializer drops `relayed` even when a caller sets it');

    // broadcast() is device-level traffic (the identity announce): every link
    // and every repairing stash, no filtering — that part is unchanged.
    ok(pm.sessionStash.get('s1').outbox.length === 1, 'broadcast still reaches a repairing stash');
}

async function ceremonyTests() {
    console.log('\nceremonies — one standalone link each, in any order, with no role guards');
    installFakeRtc();

    // THE guard removal. v1.12 refused "host while joined" and "join while
    // hosting"; v1.13 kept both for party-less calls. With no party and no
    // node-global role there is nothing left for either to protect — and the
    // 2026-08-16 field test is exactly the shape those refusals produced.
    const pm = new PeerManager({ connectionTimeoutMs: 60 });
    await pm.createAnswer({ peerId: 'hub1', sessionDesc: { type: 'offer', sdp: FAKE_SDP } });
    ok(pm.hasLink('hub1') && pm.peers.get('hub1').type === 'host',
        'joining forms one host-typed link');
    const offerPayload = JSON.parse(await pm.createOffer());
    ok(pm.hasLink(offerPayload.peerId) && pm.peers.get(offerPayload.peerId).type === 'client',
        'a joined node CAN invite — createOffer while joined mints a client-typed link');
    ok(pm.hasLink('hub1'), 'and the link it joined on is untouched');

    const host = new PeerManager({ connectionTimeoutMs: 60 });
    const o1 = JSON.parse(await host.createOffer());
    const o2 = JSON.parse(await host.createOffer());
    ok(o1.peerId !== o2.peerId && host.hasLink(o1.peerId) && host.hasLink(o2.peerId),
        'repeat invites mint distinct, independent links');
    await host.createAnswer({ peerId: 'h3', sessionDesc: { type: 'offer', sdp: FAKE_SDP } });
    ok(host.hasLink('h3') && host.hasLink(o1.peerId),
        'an inviting node CAN join — createAnswer while hosting leaves its invites alone');

    // The polite side is the only asymmetry a ceremony leaves behind (§5.5).
    ok(host.peers.get('h3').polite === true && host.peers.get(o1.peerId).polite === false,
        'the joiner side stays polite for renegotiation glare — the one lasting role');
}

function lifecycleTests() {
    console.log('\nlifecycle and read model — links, stashes, and what a caller can see');

    // Teardown: an established link stashes; an unfinished one does not.
    const pm = new PeerManager();
    pm.peers.set('a1', wiredLink('client', null, 'a1'));
    pm.peers.get('a1').everConnected = false;
    pm._teardownPeer('a1', 'disconnected');
    ok(!pm.hasLink('a1') && !pm.hasStashedSession('a1'),
        'a link that never connected leaves nothing behind');
    pm.peers.set('b1', wiredLink('host', null, 'b1'));
    pm._teardownPeer('b1', 'disconnected'); // everConnected → stashed
    ok(pm.hasStashedSession('b1') && pm.hostLinkId() === 'b1',
        'an established link stashes for repair, and hostLinkId still resolves it');
    pm.forgetSession('b1');
    ok(!pm.hasStashedSession('b1'), 'forgetSession drops the stash (deliberate start-over)');

    // statusSummary is flat — no party breakdown, no isHost mirror.
    const pm3 = new PeerManager();
    pm3.peers.set('a1', wiredLink('client', null, 'a1'));
    pm3.peers.set('a2', Object.assign(wiredLink('client', null, 'a2'), { status: 'interrupted' }));
    pm3.peers.set('b1', wiredLink('host', null, 'b1'));
    pm3.sessionStash.set('a3', { type: 'client', outSeq: 0, outbox: [] });
    const sum = pm3.statusSummary();
    ok(sum.connected === 2 && sum.interrupted === 1 && sum.stashed === 1 && sum.established === true,
        'statusSummary counts every link and stash');
    ok(!('parties' in sum) && !('isHost' in sum),
        'statusSummary carries no party breakdown and no isHost mirror (both deleted)');

    // allPeers is what the bridge intersects with a game's scope.
    const all = pm3.allPeers();
    ok(all.length === 4 && all.filter((p) => p.live).length === 3
        && all.find((p) => p.peerId === 'a3').status === 'stashed',
        'allPeers lists every live link and every stashed session');

    // abandonPending drops every unfinished ceremony, node-wide.
    const pm4 = new PeerManager();
    pm4.peers.set('a1', Object.assign(wiredLink('client', null, 'a1'), { status: 'new' }));
    pm4.peers.set('b1', wiredLink('client', null, 'b1')); // connected
    pm4.abandonPending();
    ok(!pm4.hasLink('a1') && pm4.hasLink('b1'), 'abandonPending drops pending links and keeps established ones');
}

function adoptionTests() {
    console.log('\nrendezvous adoption — session continuity, still with no forwarding');

    const fakeConn = () => ({ close() {}, onicecandidate: null, remoteDescription: null });

    // A repaired link resumes its stashed session by peerId.
    const pm = new PeerManager();
    pm.sessionStash.set('S', { type: 'client', outSeq: 7, lastInSeq: 3, outbox: [], outboxOverflowed: false, stashedAt: Date.now(), peerFingerprint: null });
    pm.adoptConnection('S', fakeConn());
    ok(pm.hasLink('S') && pm.peers.get('S').outSeq === 7 && pm.peers.get('S').lastInSeq === 3,
        'adoption restores the stashed session (seq counters carry over)');

    // The v1.13 test here asserted the OPPOSITE: that a restart-resumed hub
    // relays between its re-adopted spokes again. That regression fix died
    // with the feature — a restarted node must now stay as mute as any other.
    const hub = new PeerManager();
    const sent = [];
    hub.adoptConnection('X', fakeConn(), { readyState: 'open', send(w) { sent.push(['X', w]); } });
    hub.adoptConnection('Y', fakeConn(), { readyState: 'open', send(w) { sent.push(['Y', w]); } });
    hub.peers.get('X').resyncFlushed = true;
    hub.peers.get('Y').resyncFlushed = true;
    sent.length = 0;
    hub._onChannelMessage('X', JSON.stringify({ text: 'post-restart', from: 'X', seq: 1 }));
    ok(hub.peers.get('Y').outbox.length === 0 && appFrames(sent).length === 0,
        'a restart-adopted node forwards NOTHING between its links');

    // fallbackType is all adoption needs from the layer above now.
    const spoke = new PeerManager();
    spoke.adoptConnection('H', fakeConn(), null, { fallbackType: 'host' });
    ok(spoke.peers.get('H').type === 'host' && spoke.hostLinkId() === 'H',
        'fallbackType host adopts a host-typed link (hostLinkId resolves it)');
    const client = new PeerManager();
    client.adoptConnection('C', fakeConn(), null, { fallbackType: 'client' });
    ok(client.peers.get('C').type === 'client' && client.hostLinkId() === null,
        'fallbackType client adopts a client-typed link');
}

(async () => {
    console.log('p2p-core unit tests — transport hardening (issue #21 residuals)');
    idTests();
    clampTests();
    resumeTests();
    frameSizeTests();
    readModelTests();
    minifySdpTests();
    noRelayTests();
    await ceremonyTests();
    lifecycleTests();
    adoptionTests();
    console.log('');
    if (fail) { console.log(fail + ' check(s) FAILED.'); process.exit(1); }
    console.log('All ' + pass + ' p2p-core unit checks passed.');
    process.exit(0); // fake-RTC ceremony reap timers may still be pending
})();
