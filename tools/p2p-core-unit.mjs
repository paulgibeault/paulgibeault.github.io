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
// PARTIES (v1.13) — per-party role and relay scoping. The critical property
// is relay ISOLATION: a frame must never cross parties, and a node that
// leads party A while a member of party B must never re-relay B's traffic.
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

async function rejectsWith(promise, re) {
    try { await promise; return false; } catch (e) { return re.test(e.message); }
}

// A connected link in a party, with a capturing channel so relay output is
// observable. resyncFlushed lets _sendAppTo transmit immediately.
const partyLink = (partyId, type, sentLog, id) => fakePeer('connected', {
    partyId, type, outSeq: 0, lastInSeq: 0, resyncFlushed: true, lastAliveAt: 0,
    everConnected: true,
    dataChannel: { readyState: 'open', send(w) { if (sentLog) sentLog.push([id, w]); } },
});
const appFrames = (log) => log.map(([id, w]) => [id, JSON.parse(w)]).filter(([, f]) => !f.__p2pc);

function relayIsolationTests() {
    console.log('\nparties — relay isolation (a frame must never cross parties)');
    const pm = new PeerManager();
    const sent = [];
    pm.parties.set('A', { role: 'leader' });
    pm.parties.set('B', { role: 'member' });
    pm.peers.set('a1', partyLink('A', 'client', sent, 'a1'));
    pm.peers.set('a2', partyLink('A', 'client', sent, 'a2'));
    pm.peers.set('b1', partyLink('B', 'host', sent, 'b1'));
    pm.sessionStash.set('sA', { partyId: 'A', type: 'client', outSeq: 0, outbox: [] });
    pm.sessionStash.set('sB', { partyId: 'B', type: 'client', outSeq: 0, outbox: [] });

    const delivered = [];
    pm.addEventListener('message', (e) => delivered.push(e.detail));

    // Frame arrives on a led party's link → fan out inside that party only.
    pm._onChannelMessage('a1', JSON.stringify({ text: 'x', from: 'spoofable', seq: 1 }));
    let apps = appFrames(sent);
    ok(apps.length === 1 && apps[0][0] === 'a2', 'leader relays an A-link frame to the other A spoke only');
    ok(apps[0][1].relayed === true && apps[0][1].from === 'a1', 'relay stamps relayed:true and the arrival link id as from');
    ok(pm.sessionStash.get('sA').outbox.length === 1, 'same-party stash receives the relay (repair window replay)');
    ok(pm.sessionStash.get('sB').outbox.length === 0, 'other-party stash receives NOTHING');

    // Frame arrives on the member party's hub link → no relay at all (we are
    // a spoke there, whatever we lead elsewhere).
    sent.length = 0;
    pm._onChannelMessage('b1', JSON.stringify({ text: 'y', from: 'hub', seq: 1, relayed: true }));
    apps = appFrames(sent);
    ok(apps.length === 0, 'a frame arriving on a member link is never re-relayed (leader-elsewhere must not leak it)');
    ok(pm.sessionStash.get('sA').outbox.length === 1 && pm.sessionStash.get('sB').outbox.length === 0,
        'no stash gains frames from a member-link arrival');
    ok(delivered[1].relayed === true, 'relayed stamp from OUR hub survives on a member link (host-relay attribution)');

    // Forged relayed:true on a link we lead is stripped before local dispatch.
    pm._onChannelMessage('a2', JSON.stringify({ text: 'z', from: 'a2', seq: 1, relayed: true }));
    ok(delivered[2].relayed === false, 'inbound relayed:true on a led link is forged → stripped');

    // Targeted frames still skip the fan-out entirely.
    sent.length = 0;
    pm._onChannelMessage('a1', JSON.stringify({ text: 'private', from: 'a1', seq: 2, noRelay: true }));
    ok(appFrames(sent).length === 0, 'noRelay frames are never fanned out by the party leader');

    // broadcast with a party filter touches only that party.
    sent.length = 0;
    pm.broadcast({ text: 'p', from: 'me' }, null, { partyId: 'A' });
    apps = appFrames(sent);
    ok(apps.length === 2 && apps.every(([id]) => id === 'a1' || id === 'a2'),
        'broadcast({partyId}) reaches only that party\'s links');
    ok(pm.sessionStash.get('sB').outbox.length === 0, 'broadcast({partyId}) skips other parties\' stashes');
    sent.length = 0;
    pm.broadcast({ text: 'q', from: 'me' });
    ok(appFrames(sent).length === 3, 'party-less broadcast still reaches every link (device-level traffic)');
}

async function partyCeremonyTests() {
    console.log('\nparties — ceremony guards (per-party invariants replace the role-flip guard)');
    installFakeRtc();

    // THE 2026-07-18 field-test regression: a member of one party CAN start
    // and lead a new, independent party (was: "Cannot host while joined").
    const pm = new PeerManager({ connectionTimeoutMs: 60 });
    await pm.createAnswer({ peerId: 'hub1', sessionDesc: { type: 'offer', sdp: FAKE_SDP } });
    ok(pm.partyRole(pm.partyOf('hub1')) === 'member' && pm.defaultPartyId === pm.partyOf('hub1'),
        'legacy join forms a member party and makes it the default');
    ok(await rejectsWith(pm.createOffer(), /Cannot host while joined/),
        'legacy party-less createOffer still refuses while joined (v1.12 behavior preserved)');
    const newParty = pm.createParty();
    const offerPayload = JSON.parse(await pm.createOffer({ partyId: newParty }));
    ok(pm.partyOf(offerPayload.peerId) === newParty && pm.partyRole(newParty) === 'leader',
        'a joined node CAN lead a NEW party (the field-test fix) — invite link lands in it');
    ok(pm.partyOf('hub1') !== newParty, 'the member link stays in its own party');

    // Only a party's leader mints invites for it.
    ok(await rejectsWith(pm.createOffer({ partyId: pm.partyOf('hub1') }), /Only the party leader/),
        'createOffer into a party this node is a member of is refused');

    // Legacy join guard: a leader with established links refuses a party-less
    // join (its members would be orphaned) — but an explicit newParty join is
    // fine, because it conflicts with nothing.
    const host = new PeerManager({ connectionTimeoutMs: 60 });
    const hostOffer = JSON.parse(await host.createOffer());
    ok(host.isHost === true && host.partyRole(host.defaultPartyId) === 'leader',
        'legacy createOffer forms a leader default party (isHost mirror set)');
    ok(await rejectsWith(host.createAnswer({ peerId: 'h2', sessionDesc: { type: 'offer', sdp: FAKE_SDP } }),
        /Cannot join while hosting/),
        'legacy party-less join still refuses while leading with links (v1.12 behavior preserved)');
    await host.createAnswer({ peerId: 'h3', sessionDesc: { type: 'offer', sdp: FAKE_SDP } }, { newParty: true });
    ok(host.partyRole(host.partyOf('h3')) === 'member', 'explicit {newParty:true} join succeeds while leading');
    ok(host.defaultPartyId !== host.partyOf('h3') && host.isHost === true,
        'a newParty join leaves the default party and legacy mirror untouched');
    ok(host.partyOf(hostOffer.peerId) === host.defaultPartyId, 'the led party still holds its invite link');

    // Legacy "invite another player": repeat party-less offers share one party.
    const host2 = new PeerManager({ connectionTimeoutMs: 60 });
    const o1 = JSON.parse(await host2.createOffer());
    const o2 = JSON.parse(await host2.createOffer());
    ok(host2.partyOf(o1.peerId) === host2.partyOf(o2.peerId),
        'legacy repeat createOffer lands every invite in the same (default) party');
}

function partyLifecycleTests() {
    console.log('\nparties — lifecycle, GC, and read model');

    // GC: a party dies with its last reference; the default pointer clears.
    const pm = new PeerManager();
    pm.parties.set('A', { role: 'leader' });
    pm.defaultPartyId = 'A';
    pm.peers.set('a1', partyLink('A', 'client', null, 'a1'));
    pm.peers.get('a1').everConnected = false; // no stash on teardown
    pm._teardownPeer('a1', 'disconnected');
    ok(!pm.parties.has('A') && pm.defaultPartyId === null,
        'tearing down a party\'s last link collects the party and clears the default pointer');

    // A stashed session keeps the party alive; forgetSession collects it.
    pm.parties.set('B', { role: 'member' });
    pm.peers.set('b1', partyLink('B', 'host', null, 'b1'));
    pm._teardownPeer('b1', 'disconnected'); // everConnected → stashed
    ok(pm.parties.has('B') && pm.hasStashedSession('b1'), 'a stashed (repairing) session keeps its party alive');
    ok(pm.partyOf('b1') === 'B' && pm.hubLinkId('B') === 'b1', 'partyOf/hubLinkId resolve through the stash during repair');
    pm.forgetSession('b1');
    ok(!pm.parties.has('B'), 'forgetting the stashed session collects the party');

    // closeParty: live links dropped, stashes swept, other parties untouched.
    const pm2 = new PeerManager();
    pm2.parties.set('A', { role: 'leader' });
    pm2.parties.set('B', { role: 'member' });
    pm2.peers.set('a1', partyLink('A', 'client', null, 'a1'));
    pm2.peers.set('b1', partyLink('B', 'host', null, 'b1'));
    pm2.sessionStash.set('a2', { partyId: 'A', type: 'client', outSeq: 0, outbox: [] });
    const terminal = [];
    pm2.addEventListener('status', (e) => { if (e.detail.status === 'disconnected') terminal.push(e.detail.peerId); });
    pm2.closeParty('A');
    ok(!pm2.parties.has('A') && !pm2.hasLink('a1') && !pm2.hasStashedSession('a1') && !pm2.hasStashedSession('a2'),
        'closeParty drops the party\'s live links and stashes — nothing lingers to repair into it');
    ok(terminal.includes('a1'), 'closeParty routes drops through disconnectPeer (terminal status events fire)');
    ok(pm2.parties.has('B') && pm2.hasLink('b1'), 'closeParty leaves other parties untouched');

    // statusSummary per-party breakdown.
    const pm3 = new PeerManager();
    pm3.parties.set('A', { role: 'leader' });
    pm3.parties.set('B', { role: 'member' });
    pm3.defaultPartyId = 'B';
    pm3.peers.set('a1', partyLink('A', 'client', null, 'a1'));
    pm3.peers.set('a2', Object.assign(partyLink('A', 'client', null, 'a2'), { status: 'interrupted' }));
    pm3.peers.set('b1', partyLink('B', 'host', null, 'b1'));
    pm3.sessionStash.set('a3', { partyId: 'A', type: 'client', outSeq: 0, outbox: [] });
    const sum = pm3.statusSummary();
    const pa = sum.parties.find((p) => p.partyId === 'A');
    const pb = sum.parties.find((p) => p.partyId === 'B');
    ok(pa && pa.role === 'leader' && pa.connected === 1 && pa.interrupted === 1 && pa.stashed === 1 && !pa.isDefault,
        'statusSummary breaks a led party down per status incl. its stash');
    ok(pb && pb.role === 'member' && pb.connected === 1 && pb.isDefault === true,
        'statusSummary marks the default party and counts the member link');
    ok(sum.connected === 2 && sum.established === true, 'aggregate fields still cover every party (legacy consumers)');
    const peersOfA = pm3.partyPeers('A');
    ok(peersOfA.length === 3 && peersOfA.filter((p) => p.live).length === 2
        && peersOfA.find((p) => p.peerId === 'a3').status === 'stashed',
        'partyPeers lists live links and stashed sessions of exactly one party');
    ok(pm3.hubLinkId('A') === null, 'hubLinkId is null for a party this node leads');

    // abandonPending(partyId) drops only that party's unfinished ceremonies.
    const pm4 = new PeerManager();
    pm4.parties.set('A', { role: 'leader' });
    pm4.parties.set('B', { role: 'leader' });
    pm4.peers.set('a1', Object.assign(partyLink('A', 'client', null, 'a1'), { status: 'new' }));
    pm4.peers.set('b1', Object.assign(partyLink('B', 'client', null, 'b1'), { status: 'new' }));
    pm4.abandonPending('A');
    ok(!pm4.hasLink('a1') && pm4.hasLink('b1'), 'abandonPending(partyId) is scoped to that party');
}

function partyAdoptionTests() {
    console.log('\nparties — rendezvous adoption continuity');

    const fakeConn = () => ({ close() {}, onicecandidate: null, remoteDescription: null });

    // A repaired link rejoins the party its stashed session belonged to.
    const pm = new PeerManager();
    pm.parties.set('A', { role: 'leader' });
    pm.sessionStash.set('S', { partyId: 'A', type: 'client', outSeq: 7, lastInSeq: 3, outbox: [], outboxOverflowed: false, stashedAt: Date.now(), peerFingerprint: null });
    pm.adoptConnection('S', fakeConn());
    ok(pm.partyOf('S') === 'A' && pm.peers.get('S').outSeq === 7,
        'adoption restores the stashed session INTO its original party');

    // No prior session (browser restart): leader-side fallbacks coalesce into
    // ONE adopted leader party — this is what restores hub relay after a hub
    // restart (pre-v1.13 the resumed hub never relayed again: isHost stayed
    // false and nothing re-derived it).
    const hub = new PeerManager();
    hub.adoptConnection('X', fakeConn(), { readyState: 'open', send() {} });
    hub.adoptConnection('Y', fakeConn(), { readyState: 'open', send() {} });
    const px = hub.partyOf('X'), py = hub.partyOf('Y');
    ok(px === py && hub.partyRole(px) === 'leader', 'restart-adopted client links coalesce into one leader party');
    ok(hub.defaultPartyId === px && hub.isHost === true, 'the adopted leader party becomes the default (mirror restored)');
    hub.peers.get('X').resyncFlushed = true;
    hub.peers.get('Y').resyncFlushed = true;
    hub._onChannelMessage('X', JSON.stringify({ text: 'post-restart', from: 'X', seq: 1 }));
    ok(hub.peers.get('Y').outbox.length === 1, 'a restart-resumed hub RELAYS between its adopted spokes again (v1.12 regression fixed)');

    // A host-typed fallback forms its own member party instead.
    const spoke = new PeerManager();
    spoke.adoptConnection('H', fakeConn(), null, { fallbackType: 'host' });
    ok(spoke.partyRole(spoke.partyOf('H')) === 'member' && spoke.hubLinkId(spoke.partyOf('H')) === 'H',
        'a restart-adopted hub link forms a member party (hubLinkId resolves it)');

    // An explicit opts.partyId (persisted membership, Phase 2) wins over the fallback.
    const pm5 = new PeerManager();
    pm5.parties.set('P', { role: 'leader' });
    pm5.adoptConnection('Q', fakeConn(), null, { partyId: 'P' });
    ok(pm5.partyOf('Q') === 'P', 'adoption honors an explicit partyId from the layer above');
}

(async () => {
    console.log('p2p-core unit tests — transport hardening (issue #21 residuals)');
    idTests();
    clampTests();
    resumeTests();
    frameSizeTests();
    readModelTests();
    minifySdpTests();
    relayIsolationTests();
    await partyCeremonyTests();
    partyLifecycleTests();
    partyAdoptionTests();
    console.log('');
    if (fail) { console.log(fail + ' check(s) FAILED.'); process.exit(1); }
    console.log('All ' + pass + ' p2p-core unit checks passed.');
    process.exit(0); // fake-RTC ceremony reap timers may still be pending
})();
