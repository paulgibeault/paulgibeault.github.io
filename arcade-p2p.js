/* arcade-p2p.js — launcher-side multiplayer bridge (ES module, lazy-loaded)
 *
 * Turns the in-repo P2P transport (p2p/, see p2p/README.md) into the backbone behind
 * Arcade.peer.*. Games never see any of this: they talk to the SDK, the SDK
 * talks arcade:peer.* postMessages to the launcher, and the launcher calls
 * this bridge. One connection per device, owned by the launcher, shared by
 * every game.
 *
 * Loaded on demand via import() from index.html:
 *   - when the user opens the Multiplayer menu item, or
 *   - at startup when the URL carries a #p2p-offer= / #p2p-answer= fragment
 *     (an invite or reply link pointed at the launcher).
 *
 * Wire envelopes between launchers (invisible to games):
 *   { arcade: 1, gameId, payload }        — a game's message, routed by gameId
 *   { arcade: 1, kind: 'identity', deviceId, name } — this device announcing
 *     itself once its data channel opens (see "known peers" below)
 *   { arcade: 1, kind: 'sync', ... }      — Arcade.sync launcher-level state
 *     replication (digest/req/diff; see arcade-sync.js). Accepted only from a
 *     DIRECT link with a completed identity binding — never relayed or
 *     host-forwarded — and dispatched to onSyncEnvelope(fn) listeners as
 *     fn(fromDeviceId, env). Sent with sendSyncEnvelope(deviceId, env), which
 *     targets exactly that device's direct link.
 *   { arcade: 1, kind: 'backup', ... }    — backup-to-trusted-peer transfer
 *     frames (offer/accept/decline/chunk/ack; see arcade-backup.js). Same
 *     delivery rules as 'sync': direct links with a completed identity
 *     binding only, dispatched via onBackupEnvelope(fn), sent with
 *     sendBackupEnvelope(deviceId, env).
 *   { arcade: 1, kind: 'revoke', deviceId, revokedAt, sig } — a signed
 *     device revocation (#32): the sender's user disowned one of THEIR OWN
 *     devices (a lost phone). Same delivery rules as 'sync'/'backup'; the
 *     signature is verified against the userPub already pinned for the
 *     TARGET deviceId, so the carrier is irrelevant — only the user key's
 *     holder can mint one. Revocations also ride identity frames as gossip
 *     (`uid.revocations`) for eventual propagation with no server.
 *
 * User identity above device identity (#32, arcade-user-identity.js): when
 * the user has set one up, identity frames carry `uid: {userPub, cert,
 * revocations}` — cert is an Ed25519 signature over {deviceId, fingerprint,
 * issuedAt}. A receiver that already pinned the same userPub for that
 * deviceId treats a VERIFIED cert over a rotated fingerprint as a routine
 * re-attestation: the pin auto-promotes silently instead of raising the
 * "device identity changed" alarm (detail.fingerprintAutoPromoted). An
 * UNVERIFIED change keeps today's TOFU-with-notice treatment unchanged.
 *
 * Status vocabulary mapping (transport → SDK), aggregated across ALL peer
 * links so one wobbling link never flaps the global status:
 *   any link connected           → 'connected'   (data channel OPEN — the
 *                                                 transport's v1.5.1 meaning)
 *   else any link interrupted    → 'interrupted' (v1.7: session alive, the
 *                                                 transport is repairing it —
 *                                                 sends still work, they queue
 *                                                 and replay on recovery)
 *   else any link pending        → 'connecting'
 *   none                         → 'idle'
 *
 * While 'connected' or 'interrupted' the bridge holds a screen Wake Lock —
 * screen dimming is the #1 cause of the long suspends that kill sessions.
 *
 * Known peers — naming/reconnect-recognition (no server, still one ceremony
 * per connection; WebRTC can't skip the offer/answer round trip):
 *   Each device has a persistent `deviceId` (random, generated once) and a
 *   user-editable `deviceName`. The moment ANY peer's data channel opens, we
 *   broadcast our identity; the receiving side upserts `knownPeers[deviceId]`
 *   — `name` is a local editable label (seeded from the peer's self-reported
 *   `remoteName` and offered as a suggestion index.html prompts the user to
 *   accept/edit on first contact — see its onPeerIdentity({isNew}) handler —
 *   then never auto-overwritten by later handshakes), `remoteName` is
 *   whatever the peer most recently reported about itself.
 *   Storage keys (see ARCADE_PLATFORM.md's storage convention):
 *     arcade.v1._meta.deviceId, .deviceName, .knownPeers, .lastLiveSession
 *
 * Auto-reconnect (rendezvous, PROTOCOL.md §7) — OPT-IN PER PEER:
 *   knownPeers[deviceId].autoReconnect gates everything. When both sides
 *   opted in, a pairing secret is (re)established over the live channel on
 *   every manual ceremony; if the connection later dies completely, the
 *   transport re-signals through a public dead-drop relay — everything
 *   published is end-to-end sealed; the relay can only delay or drop. While
 *   an episode runs, games see 'interrupted'. resumeRendezvous() at startup
 *   revives a recent session after a full browser restart — see also the
 *   pageshow{persisted:true} listener in index.html, which redoes that same
 *   check for a page the browser restored from bfcache instead of reloading
 *   (a back-button return from navigating away doesn't always re-run this
 *   module's startup code). The 🔁/🚫 toggle (enableAutoReconnect/
 *   disableAutoReconnect) PAUSES rather than forgets an existing secret —
 *   same primitive as hangUpKnownPeer/callKnownPeer below — so flipping it
 *   off then back on needs no new ceremony to work again; only a device that
 *   has NEVER paired needs a live link to mint one.
 *
 * Call / Hang up / Start over — the launcher's Multiplayer dialog, framed
 * like a phone: a saved connection is either live (Hang Up ends it, keeping
 * the secret for later) or not (Call rings it through the dead-drop):
 *   hangUpKnownPeer() says goodbye over the live channel (the other side
 *   drops to quiet standby instead of burning a repair episode), drops the
 *   link, and tells our rendezvous to stop healing it — secret kept.
 *   callKnownPeer() clears that and rings: it reaches the peer whenever
 *   their arcade is merely OPEN with the pair enabled (active repair,
 *   quiet standby after a timeout, or standby-at-boot — see
 *   resumeRendezvous). startOverKnownPeer() is the harder reset: drops the
 *   link, forgets the stashed session AND the pairing secret, so the next
 *   connection is a fully fresh ceremony — the saved name stays, only
 *   deleteKnownPeer() forgets the device outright.
 */

import { RendezvousManager, RDV_BUILD } from './p2p/rendezvous.js';
import { DEFAULT_ICE_SERVERS } from './p2p/p2p-core.js';
import { MqttCarrier, MultiCarrier, CarrierPool } from './p2p/rendezvous-carriers.js';
import { readKnownPeers, writeKnownPeers, setKnownPeerPaused, markKnownPeerRevoked } from './arcade-known-peers.js';
import { ArcadeDiag } from './arcade-diag.js';
import { isDeviceId, validatePeerEnvelope, validateRevocationEntry } from './arcade-envelope.js';
import {
    readUserIdentityMeta, signDeviceCert, signRevocation,
    verifyDeviceCert, verifyRevocation, isUserPub
} from './arcade-user-identity.js';

// Free public MQTT-over-WSS brokers used as the untrusted dead-drop. They
// see only ciphertext on unlinkable rotating topics, and only during repair.
// ALL of them are used at once (publish to every live one, subscribe on
// all): the rendezvous works while ANY single broker is reachable from both
// devices. One broker was the whole story until test.mosquitto.org went
// down for an evening and stranded two perfectly-paired devices
// (2026-07-09 field logs).
const RDV_BROKER_URLS = [
    'wss://test.mosquitto.org:8081/mqtt',
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
];

// A user (or a network that blocks the public brokers' WSS ports) can point
// rendezvous at their own MQTT-over-WSS broker(s) by setting
// arcade.v1._meta.rdvBrokers to a JSON array of wss:// URLs. Empty/invalid ⇒
// the built-in fleet. The brokers only ever see ciphertext on rotating topics,
// so trusting a self-hosted one costs nothing beyond the metadata a public one
// already sees. SELF_HOSTING.md walks through standing one up.

// Exported so the Multiplayer dialog's Advanced panel can validate before it
// writes the key — one shape, one place (the arcade-known-peers.js lesson).
// Returns the valid entries, or null when nothing usable remains.
export function validateBrokerUrls(arr) {
    if (!Array.isArray(arr)) return null;
    const urls = arr.filter((u) => typeof u === 'string' && /^wss:\/\//i.test(u));
    return urls.length ? urls : null;
}

function rdvBrokerUrls() {
    try {
        const raw = localStorage.getItem('arcade.v1._meta.rdvBrokers');
        if (raw) {
            const urls = validateBrokerUrls(JSON.parse(raw));
            if (urls) return urls;
        }
    } catch (e) {}
    return RDV_BROKER_URLS;
}

// Custom ICE servers (arcade.v1._meta.iceServers, a JSON RTCIceServer[]) —
// the only way to add TURN, which symmetric-NAT pairs need off-LAN. Replaces
// the transport's built-in public STUN list when set; empty/invalid ⇒ null ⇒
// the built-in default. WARNING for anyone touching the shape: this key rides
// save-file exports/backups like every arcade.v1.* key, so a static TURN
// credential stored here leaves the device with every exported save —
// SELF_HOSTING.md tells users to prefer short-lived credentials.
export function validateIceServers(arr) {
    if (!Array.isArray(arr)) return null;
    const ok = arr.filter((s) => s && typeof s === 'object'
        && (typeof s.urls === 'string' || (Array.isArray(s.urls) && s.urls.length && s.urls.every((u) => typeof u === 'string')))
        && [].concat(s.urls).every((u) => /^(stun|turn|turns):/i.test(u))
        && (s.username === undefined || typeof s.username === 'string')
        && (s.credential === undefined || typeof s.credential === 'string'));
    return ok.length ? ok : null;
}

function iceServersConfig() {
    try {
        const raw = localStorage.getItem('arcade.v1._meta.iceServers');
        if (raw) {
            const valid = validateIceServers(JSON.parse(raw));
            if (valid) return valid;
        }
    } catch (e) {}
    return null;
}

let rdv = null;
// peerIds with an ACTIVE rendezvous repair episode. Per-peer (not a single
// global flag): with two known peers, repairing peer A must not make peer B's
// unrelated stashed/departed session read as 'interrupted' in the roster.
const rdvReconnecting = new Set();

// ONE broker fleet per device, however many pairs are armed: every episode
// used to mint its own MultiCarrier (3 WSS sockets per PAIR), so a device
// with N repairing/standby pairs held 3N sockets to the same three public
// brokers. Episodes now lease topics from this shared pool — 3 sockets per
// DEVICE — and the underlying fleet is (re)built lazily, which is also when
// the test hook and any rdvBrokers override are consulted (a changed broker
// list applies on the next pool build, i.e. after all episodes settle plus
// the pool's linger).
const rdvPool = new CarrierPool(() => {
    // Test hook: acceptance injects a loopback/dead-drop carrier here.
    if (typeof window !== 'undefined' && window.__arcadeRdvCarrierFactory) {
        return window.__arcadeRdvCarrierFactory();
    }
    return new MultiCarrier(rdvBrokerUrls().map((url) => {
        let label = url;
        try { label = new URL(url).hostname.split('.').slice(-2)[0]; } catch (e) {} // mosquitto / emqx / hivemq
        return new MqttCarrier({ url, onLog: (msg) => ArcadeDiag.log('mqtt', `[${label}] ${msg}`) });
    }));
}, { onLog: (msg) => ArcadeDiag.log('mqtt', `[pool] ${msg}`) });

function rdvCarrierFactory() {
    return rdvPool.acquire();
}

// Terminal link statuses have already been removed from the transport's peers
// map by the time their event fires, so aggregation only ever sees live links.
function aggregateStatus(mp) {
    const s = mp.peerNode.statusSummary();
    if (s.connected) return 'connected';
    if (s.interrupted) return 'interrupted';
    if (s.finalizing + s.pending) return 'connecting';
    // A rendezvous episode means a session is being repaired even though its
    // dead link has left the peers map — games should keep waiting, not reset.
    if (rdvReconnecting.size) return 'interrupted';
    return 'idle';
}

// Terminal teardown and the rendezvous 'reconnecting' claim race on the same
// event: hold a would-be drop to 'idle' for a beat so games never glimpse a
// spurious 'idle' when an auto-reconnect is about to take over.
let idleHoldTimer = null;
function applyStatus(mp) {
    const next = aggregateStatus(mp);
    if (idleHoldTimer) { clearTimeout(idleHoldTimer); idleHoldTimer = null; }
    if (next === 'idle' && (sdkStatus === 'connected' || sdkStatus === 'interrupted')) {
        idleHoldTimer = setTimeout(() => {
            idleHoldTimer = null;
            setStatus(aggregateStatus(mp));
            notifyRosterChange();
        }, 1500);
        return;
    }
    setStatus(next);
    // Every path that can change a link's status funnels through here, so the
    // per-peer roster rides the same trigger (it dedupes internally).
    notifyRosterChange();
}

const META_PREFIX = 'arcade.v1._meta.';
const DEVICE_ID_KEY = META_PREFIX + 'deviceId';
const DEVICE_NAME_KEY = META_PREFIX + 'deviceName';
const LAST_LIVE_SESSION_KEY = META_PREFIX + 'lastLiveSession';
const DEFAULT_DEVICE_NAME = 'My device';
const RESUME_WINDOW_MS = 6 * 3600 * 1000; // resumeRendezvous freshness window

function randomDeviceId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return window.crypto.randomUUID();
    }
    return 'dev-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// Memoized — immutable once minted, and the receive path now consults it on
// every inbound frame (targeted routing), so no per-frame storage reads.
let myDeviceIdCache = null;
function getMyDeviceId() {
    if (myDeviceIdCache) return myDeviceIdCache;
    try {
        let id = localStorage.getItem(DEVICE_ID_KEY);
        if (!id) {
            id = randomDeviceId();
            localStorage.setItem(DEVICE_ID_KEY, id);
        }
        myDeviceIdCache = id;
    } catch (e) {
        myDeviceIdCache = randomDeviceId(); // storage unavailable — ephemeral fallback
    }
    return myDeviceIdCache;
}

function getMyDeviceName() {
    try { return localStorage.getItem(DEVICE_NAME_KEY) || DEFAULT_DEVICE_NAME; }
    catch (e) { return DEFAULT_DEVICE_NAME; }
}

const peerIdentityListeners = []; // fn({deviceId, name, remoteName, isNew, fingerprintChanged, fingerprintAutoPromoted})
const revokedListeners = [];      // fn({deviceId, name}) — a verified revocation latched (#32)
const pairRequestListeners = [];  // fn({deviceId, name}) — peer wants auto-reconnect, user undecided
const remoteByeListeners = [];    // fn({deviceId, name}) — peer hung up on purpose
const presenceListeners = [];     // fn({gameId, deviceId, name, kind}) — remote game mounted/listening
// One record per DIRECT-link seat, keyed by transport peerId. Consolidates what
// used to be four parallel structures (identityLinks, announcedTo,
// autoPairMintedFor, and the reverse lookup) so a single place owns a seat's
// whole lifecycle — the root fix for the stale-binding class (nothing used to
// own "this seat left, forget everything"). `deviceIndex` is the O(1) reverse
// lookup that replaces the old linear scan over identityLinks.
//   seat = { deviceId: string|null, announced: bool, minted: bool }
// Lifecycle: `announced`/`minted` reset on a link's terminal disconnect (a
// reconnect re-announces / re-mints); the deviceId binding is KEPT until the
// session goes fully idle, so a rendezvous repair can re-adopt it (seatReachable
// gates any use of a binding whose link isn't currently live). A deliberate
// hang-up / start-over forgets the seat outright via unbindDevice().
// (indirectPeers below stays separate — it is keyed by relay TAG, not peerId.)
const seats = new Map();        // peerId → seat
const deviceIndex = new Map();  // deviceId → peerId of its direct link
function getSeat(peerId) {
    let s = seats.get(peerId);
    if (!s) { s = { deviceId: null, announced: false, minted: false }; seats.set(peerId, s); }
    return s;
}
function bindSeatDevice(peerId, deviceId) {
    const s = getSeat(peerId);
    s.deviceId = deviceId;
    deviceIndex.set(deviceId, peerId);
}
// Forget everything about one deviceId's seat (deliberate hang-up / start-over).
function unbindDevice(deviceId) {
    const pid = deviceIndex.get(deviceId);
    deviceIndex.delete(deviceId);
    if (pid !== undefined) seats.delete(pid);
}

// Devices known only THROUGH the host (star topology): other joiners, whose
// identity frames arrive host-relayed. Maps deviceId → the relay `from` tag,
// which the host stamps with the source LINK's peerId (unforgeable by the
// sender — see the transport's relay loop). Used to (a) admit a joiner's
// targeted send to another joiner (routed via the host), and (b) attribute
// relayed frames to their true sender instead of the relaying host.
const indirectPeers = new Map(); // deviceId → relay `from` tag

// Wire-level capabilities THIS bridge honors, announced in identity frames.
// A joiner gates targeted sends on the HOST having announced 'peer.sendTo':
// an older host would neither honor noRelay (it would blind-relay a private
// frame to every seat) nor forward joiner→joiner targets — refusing locally
// is the only way the sender can keep its privacy guarantee in a
// mixed-version session. hostCaps is what the host link announced.
const WIRE_CAPS = ['peer.sendTo'];
let hostCaps = new Set();

function identityFrame() {
    return { arcade: 1, kind: 'identity', deviceId: getMyDeviceId(), name: getMyDeviceName(), caps: WIRE_CAPS };
}

// Broadcast our identity, with the user-identity extras (#32) attached when
// one is set up. Async because the device cert is an Ed25519 signature; the
// frame goes out a microtask later than the sync version did, which is
// invisible at data-channel timescales. Callers mark seat.announced BEFORE
// calling (same discipline as before), so no double-announce is possible.
// Resolves true when the frame was sent/queued on at least one link — a
// false return means the announce is LOST unless the caller retries (field
// report 2026-07-17: a host that never received the joiner's announce never
// records the peer, silently and permanently).
async function sendIdentity(mp, peerId) {
    const frame = identityFrame();
    try {
        const extras = await buildIdentityExtras(mp, peerId);
        if (extras) frame.uid = extras;
    } catch (e) {} // extras are strictly optional — announce plain
    try { return mp.send(frame) === true; } catch (e) { return false; }
}

function deviceIdForPeerId(peerId) {
    const s = seats.get(peerId);
    return s ? s.deviceId : null;
}

function deviceIdForRelayFrom(from) {
    if (typeof from !== 'string') return null;
    for (const [devId, tag] of indirectPeers) {
        if (tag === from) return devId;
    }
    return null;
}

// The device a frame's arrival link attributes it to: a relayed frame names
// its relay tag's owner (the true sender, not the relaying host); a direct
// frame names the link's identity binding. Shared by the game-message and
// presence paths so attribution hardening can never drift between them.
function linkSenderDeviceId(d) {
    return d.relayed ? deviceIdForRelayFrom(d.from) : deviceIdForPeerId(d.peerId);
}

// A joiner's single direct link is by definition the host; the transport
// resolves it (live entry first, then a stash-repair window's session).
function hostLinkPeerId() {
    return addon ? addon.peerNode.hostLinkId() : null;
}

// Is a transport peerId still a reachable seat? Live in `peers`, or stashed
// AND actively repairing via rendezvous. A stash with no active episode is a
// departure — its binding is stale. Shared by the identity-rebind guard (a
// live seat's binding can't be hijacked) and targeted-send (never claim
// delivery into a dead seat).
function seatReachable(peerId) {
    if (!addon || peerId === undefined || peerId === null) return false;
    if (addon.peerNode.hasLink(peerId)) return true;
    return addon.peerNode.hasStashedSession(peerId) && rdvReconnecting.has(peerId);
}

// ---- Identity-announce hardening (field report 2026-07-17) ----------------
// A connected pair where one side never received the other's identity frame
// used to stay broken silently and permanently: the announce was one-shot
// fire-and-forget, and the receiving side had no way to ask for it — the
// user just never saw the peer appear in Known Devices. Three counters:
//   1. announceSeat() resets the announced latch and retries when the send
//      never reached the transport;
//   2. an 'arcade.identity' ext frame (direct-link control channel, same
//      trust as all ext frames) lets a device REQUEST an announce;
//   3. requestIdentityIfUnbound() fires that request when a link stays
//      unbound past a grace, or when app frames arrive on an unbound link.
// Both directions are throttled per link so a hostile peer can't use the
// request to amplify broadcasts.
const IDENTITY_REQ_NS = 'arcade.identity';
const IDENTITY_REQ_THROTTLE_MS = 5000;
const identityReqSentAt = new Map();   // peerId → when we last ASKED them
const identityReqServedAt = new Map(); // peerId → when we last ANSWERED them

function identityThrottleOk(map, peerId) {
    const now = Date.now();
    if (now - (map.get(peerId) || 0) < IDENTITY_REQ_THROTTLE_MS) return false;
    map.set(peerId, now);
    return true;
}

function forgetIdentityThrottles(peerId) {
    identityReqSentAt.delete(peerId);
    identityReqServedAt.delete(peerId);
}

/**
 * Announces our identity on a link, owning the seat's announced latch: set
 * before sending (no double-announce), reset — with one delayed retry — when
 * the send never made it onto a link.
 */
function announceSeat(mp, peerId, { retry = true } = {}) {
    const seat = getSeat(peerId);
    seat.announced = true;
    sendIdentity(mp, peerId).then((ok) => {
        if (ok || seats.get(peerId) !== seat) return;
        seat.announced = false;
        ArcadeDiag.log('bridge', `identity announce to ${peerId} did not send${retry ? ' — retrying' : ''}`);
        if (!retry) return;
        setTimeout(() => {
            const s = seats.get(peerId);
            if (s && !s.announced && mp.peerNode.hasLink(peerId)) {
                announceSeat(mp, peerId, { retry: false });
            }
        }, 1500);
    });
}

/** Asks a live-but-unbound link's peer to (re)announce its identity. */
function requestIdentityIfUnbound(mp, peerId) {
    if (!peerId || !mp.peerNode.hasLink(peerId)) return;
    if (deviceIdForPeerId(peerId)) return;
    if (!identityThrottleOk(identityReqSentAt, peerId)) return;
    ArcadeDiag.log('bridge', `link ${peerId} has no identity binding — requesting an announce`);
    mp.peerNode.sendExt(peerId, IDENTITY_REQ_NS, { req: 1 });
}

// Roster: the per-device view of every DIRECT link (a host sees all joiners;
// a joiner sees exactly the host). Status folds the transport vocabulary to
// what games act on — 'connected' or 'interrupted' — because an identity-
// bound link that isn't cleanly up is by definition a session being repaired
// (renegotiating, or terminally down with its outbox stashed awaiting
// rendezvous adoption). Entries leave the roster only when the session is
// truly gone.
const rosterListeners = []; // fn([{deviceId, name, status, direct}])
let rosterTimer = null;
let lastRosterJson = null;

function rosterSnapshot() {
    if (!addon) return [];
    const known = readKnownPeers();
    const out = [];
    for (const [deviceId, peerId] of deviceIndex) {
        const linkStatus = addon.peerNode.linkStatus(peerId);
        let status = null;
        if (linkStatus) {
            status = linkStatus === 'connected' ? 'connected' : 'interrupted';
        } else if (addon.peerNode.hasStashedSession(peerId)
                && rdvReconnecting.has(peerId) && !(known[deviceId] && known[deviceId].paused)) {
            // A stashed session counts as a seat only while a rendezvous
            // episode is actively repairing it. A stash with NO episode is a
            // departure (remote bye, or a hang-up — `paused`), and departure
            // must LEAVE the roster: games key "player gone" on removal.
            status = 'interrupted';
        }
        if (status) {
            out.push({
                deviceId,
                name: (known[deviceId] && known[deviceId].name) || 'Unnamed device',
                status,
                direct: true
            });
        }
    }
    return out;
}

// Coalesces bursts (a status event and its rdv echo land in the same tick)
// and dedupes by full snapshot — a status flip on one entry must fire, mere
// re-triggers must not.
function notifyRosterChange() {
    if (rosterTimer) return;
    rosterTimer = setTimeout(() => {
        rosterTimer = null;
        const roster = rosterSnapshot();
        const json = JSON.stringify(roster);
        if (json === lastRosterJson) return;
        lastRosterJson = json;
        for (const fn of rosterListeners) {
            try { fn(roster.map((e) => ({ ...e }))); } catch (err) {}
        }
    }, 0);
}

// deviceIds whose direct-link fingerprint changed this session. A peer-chosen
// deviceId must never silently capture another device's auto-reconnect slot:
// while a deviceId is suspect, the pairing secret is NOT re-derived and
// stored-flag pair requests fall back to asking the user. Cleared only by an
// explicit user decision (enableAutoReconnect).
const fingerprintSuspects = new Set();

// A deviceId is suspect if its fingerprint changed this session (RAM flag) OR a
// prior change left a still-unconfirmed pending pin on the stored record. The
// stored `pinPendingFingerprint` survives a reload — the RAM set does not — so
// an imposter can't wait out a page refresh to have its declined fingerprint
// silently become the trusted pin. A REVOKED device (#32) is suspect
// unconditionally: revocation quarantines it out of pairing re-derivation,
// pair-request auto-accept, sync, and backup until the user's explicit
// local undo — a stolen device that still signs valid certs must never
// rotate its way back into trust.
function isFingerprintSuspect(deviceId, known) {
    if (fingerprintSuspects.has(deviceId)) return true;
    const rec = (known || readKnownPeers())[deviceId];
    return !!(rec && (rec.pinPendingFingerprint || rec.revoked));
}

// deviceIds are machine-generated on the honest path: either a UUID
// (crypto.randomUUID) or the 'dev-' fallback. Anything else is a peer making
// ids up — reject before it can touch knownPeers or the reconnect machinery.
// The shape itself lives in arcade-envelope.js (isDeviceId / DEVICE_ID_RE).

function stampLiveSession() {
    try { localStorage.setItem(LAST_LIVE_SESSION_KEY, String(Date.now())); } catch (e) {}
}

/**
 * Upserts a known peer. `fingerprint` is the DTLS fingerprint of the DIRECT
 * link the identity arrived on (null for relayed identities — those name a
 * device but must never bind an identity key). Pinning policy is trust-on-
 * first-use with change NOTICE, not hard-fail: every connection today is a
 * manual in-person ceremony (that exchange IS the authentication), and
 * browsers rotate certificates ~monthly, so a changed fingerprint means
 * "tell the user", never "silently trust" and never "silently block".
 *
 * `uid` (#32) is the PRE-VERIFIED cross-sign verdict from evaluateIdentityUid
 * — {userPub, certIssuedAt, promote} or null. Passing it in lets the single
 * read-modify-write here apply the promotion atomically: when `promote` is
 * set, the rotated fingerprint IS the new pin (the owner's signature
 * re-attested this device), pending-pin state clears, and the change is
 * reported as fingerprintAutoPromoted instead of fingerprintChanged.
 */
function recordPeerIdentity(deviceId, remoteName, fingerprint, uid) {
    if (!isDeviceId(deviceId)) return null;
    const safeRemoteName = (typeof remoteName === 'string' && remoteName.trim())
        ? remoteName.trim().slice(0, 60) : 'Unnamed device';
    const safeFp = (typeof fingerprint === 'string' && /^[0-9A-F]{2}(:[0-9A-F]{2}){19,63}$/.test(fingerprint)) ? fingerprint : null;
    const known = readKnownPeers();
    const existing = known[deviceId];
    const now = new Date().toISOString();
    const prevFp = existing ? existing.fingerprint : null;
    const rawChanged = !!(prevFp && safeFp && prevFp !== safeFp);
    const promoted = !!(uid && uid.promote && safeFp);
    const fingerprintChanged = rawChanged && !promoted;
    known[deviceId] = existing
        ? { ...existing, remoteName: safeRemoteName, lastConnectedAt: now, timesConnected: (existing.timesConnected || 0) + 1,
            // On a fingerprint change, KEEP the trusted pin and stash the new
            // fingerprint as pending until the user explicitly re-trusts
            // (enableAutoReconnect) — UNLESS a verified cert from the pinned
            // userPub covers the new fingerprint (promoted), which is the
            // owner re-attesting a routine rotation. Persisting the pending
            // pin here — not only in the RAM fingerprintSuspects set — is
            // what stops a reload from laundering an imposter's declined
            // fingerprint into the pin.
            fingerprint: fingerprintChanged ? prevFp : (safeFp || prevFp || null),
            ...(fingerprintChanged ? { fingerprintChangedAt: now, pinPendingFingerprint: safeFp } : {}) }
        : { name: safeRemoteName, remoteName: safeRemoteName, firstConnectedAt: now, lastConnectedAt: now, timesConnected: 1,
            fingerprint: safeFp };
    if (promoted) {
        delete known[deviceId].pinPendingFingerprint;
        delete known[deviceId].fingerprintChangedAt;
    }
    if (uid) {
        known[deviceId].userPub = uid.userPub;
        known[deviceId].deviceCertIssuedAt = uid.certIssuedAt;
    }
    writeKnownPeers(known);
    const detail = {
        deviceId, name: known[deviceId].name, remoteName: safeRemoteName, isNew: !existing,
        fingerprintChanged, fingerprintAutoPromoted: promoted && rawChanged
    };
    for (const fn of peerIdentityListeners) {
        try { fn(detail); } catch (err) {}
    }
    return detail;
}

/**
 * Decides what an identity frame's `uid` extras are worth BEFORE anything is
 * written (#32). Returns null (ignore the extras entirely) or
 * {userPub, certIssuedAt, promote}:
 *   - promote:false — first contact: pin this userPub TOFU-style. Recording
 *     it requires a VERIFIED cert over THIS connection's live fingerprint,
 *     so a userPub on file is always proof-of-possession, never a bare claim.
 *   - promote:true  — the pinned userPub re-attested this device under a
 *     NEWER cert: eligible for silent fingerprint-pin promotion.
 * Order matters: the revocation latch is checked FIRST — a revoked device
 * presenting a fresh, validly-signed cert must never promote past the
 * revocation (the stolen device still holds its keys; that's the point).
 */
async function evaluateIdentityUid(deviceId, uidRaw, liveFp) {
    if (!liveFp || !uidRaw || typeof uidRaw !== 'object') return null;
    const { userPub, cert } = uidRaw;
    if (!isUserPub(userPub)) return null;
    const known = readKnownPeers();
    const rec = known[deviceId];
    if (rec && rec.revoked) return null;
    if (!cert || typeof cert !== 'object') return null;
    if (cert.deviceId !== deviceId) return null;
    // The fingerprint the cert vouches for must be the one THIS connection
    // actually negotiated — a value carried in the frame proves nothing.
    if (cert.fingerprint !== liveFp) return null;
    if (!(await verifyDeviceCert(userPub, cert))) return null;
    if (rec && rec.userPub) {
        // Claiming a DIFFERENT user than the one pinned earns nothing —
        // neither promotion nor a re-pin (that would be the impersonation).
        if (rec.userPub !== userPub) return null;
        // Strictly-newer issuedAt: an attacker replaying an OLDER still-valid
        // cert (from a separately compromised past certificate) can't roll
        // the pin backward.
        if (!(cert.issuedAt > (rec.deviceCertIssuedAt || 0))) return null;
        return { userPub, certIssuedAt: cert.issuedAt, promote: true };
    }
    return { userPub, certIssuedAt: cert.issuedAt, promote: false };
}

// Own signed device cert, rebuilt only when the fingerprint or user key
// actually changes (both are stable within a session in practice).
let uidExtrasCache = null; // { fingerprint, userPub, cert }

/**
 * The `uid` extras for an outgoing identity frame, or null when the user
 * never set up an identity (the frame then looks exactly like today's).
 * peerId names any live link — this side's DTLS fingerprint is the same on
 * every link (one persistent RTC certificate).
 */
async function buildIdentityExtras(mp, peerId) {
    const meta = readUserIdentityMeta();
    if (!meta) return null;
    let ownFp = null;
    try { ownFp = mp.peerNode.getOwnFingerprint(peerId); } catch (e) {}
    if (!ownFp) return null;
    if (!uidExtrasCache || uidExtrasCache.fingerprint !== ownFp
            || uidExtrasCache.userPub !== meta.userPub) {
        const cert = await signDeviceCert(getMyDeviceId(), ownFp);
        if (!cert) return null; // key store unavailable — announce plain
        uidExtrasCache = { fingerprint: ownFp, userPub: meta.userPub, cert };
    }
    return { userPub: uidExtrasCache.userPub, cert: uidExtrasCache.cert, revocations: gossipRevocations() };
}

// Every latched revocation whose target has a userPub on file rides along
// as gossip (newest first, capped — the cap is a frame-size bound, and 8
// simultaneously-lost devices is beyond any honest fleet). Receivers verify
// each entry against their OWN records, so carrying another user's
// revocation is safe and widens propagation.
const REVOCATION_GOSSIP_CAP = 8;
function gossipRevocations() {
    const known = readKnownPeers();
    const out = [];
    for (const id of Object.keys(known)) {
        const rec = known[id];
        if (rec && rec.revoked && rec.userPub) {
            out.push({ deviceId: id, revokedAt: rec.revoked.revokedAt, sig: rec.revoked.sig });
        }
    }
    out.sort((a, b) => b.revokedAt - a.revokedAt);
    return out.slice(0, REVOCATION_GOSSIP_CAP);
}

/**
 * Verifies and latches one revocation entry (#32). The signature check runs
 * against the userPub THIS device already pinned for the target — never a
 * value carried alongside the entry — so only the holder of that user's
 * private key can produce an entry that passes, no matter who carried it.
 * On success: one-way latch, drop any live link, forget the pairing secret,
 * and quarantine (autoReconnect off + suspect) so nothing auto-heals it.
 */
async function applyRevocation(entry, source) {
    if (entry.deviceId === getMyDeviceId()) return false; // peers judge me; nothing to latch locally
    const rec = readKnownPeers()[entry.deviceId];
    if (!rec || !rec.userPub || rec.revoked) return false;
    if (!(await verifyRevocation(rec.userPub, entry))) return false;
    if (!markKnownPeerRevoked(entry.deviceId, entry)) return false;
    ArcadeDiag.log('bridge', `revocation latched for ${entry.deviceId} (${source})`);
    fingerprintSuspects.add(entry.deviceId);
    try {
        const pid = deviceIndex.get(entry.deviceId);
        if (pid !== undefined && addon && addon.peerNode.hasLink(pid)) {
            addon.peerNode.disconnectPeer(pid);
            addon.peerNode.forgetSession(pid);
        }
        if (rdv) await rdv.disablePair(entry.deviceId).catch(() => {});
        unbindDevice(entry.deviceId);
    } catch (e) {}
    const known = readKnownPeers();
    if (known[entry.deviceId]) {
        known[entry.deviceId].autoReconnect = false;
        writeKnownPeers(known);
    }
    for (const fn of revokedListeners) {
        try { fn({ deviceId: entry.deviceId, name: rec.name || 'Unnamed device' }); } catch (err) {}
    }
    notifyRosterChange();
    return true;
}

/** Gossip arrivals: shape-gate each entry, then the same verify-and-latch. */
async function processRevocationGossip(entries) {
    if (!Array.isArray(entries)) return;
    for (const raw of entries.slice(0, REVOCATION_GOSSIP_CAP)) {
        const v = validateRevocationEntry(raw);
        if (!v.ok) continue;
        try { await applyRevocation(v.entry, 'gossip'); } catch (e) {}
    }
}

function loadLocalScript(relPath, checkGlobal) {
    return new Promise((resolve, reject) => {
        if (window[checkGlobal]) return resolve();
        const s = document.createElement('script');
        s.src = new URL(relPath, import.meta.url).href;
        s.onload = resolve;
        s.onerror = () => reject(new Error(`failed to load ${relPath}`));
        document.head.appendChild(s);
    });
}

let addon = null;
let addonPromise = null;
let sdkStatus = 'idle';

const statusListeners = [];
const messageListeners = []; // fn(gameId, payload, fromDeviceId, meta)
const syncListeners = []; // fn(fromDeviceId, env)
const backupListeners = []; // fn(fromDeviceId, env)

function setStatus(next) {
    if (next === sdkStatus) return;
    ArcadeDiag.log('bridge', `status ${sdkStatus} → ${next}`);
    sdkStatus = next;
    // 'idle' means the session truly ended (a rendezvous repair holds
    // 'interrupted', never 'idle') — seats, indirect (through-the-host)
    // addressing, and the host's announced wire caps all die with it.
    // Identities re-announce on the next session. Clearing the seats too stops
    // departed-seat bindings from lingering past the session (B-p2p-1).
    if (next === 'idle') {
        const hadLinks = deviceIndex.size > 0;
        seats.clear();
        deviceIndex.clear();
        indirectPeers.clear();
        identityReqSentAt.clear();
        identityReqServedAt.clear();
        hostCaps = new Set();
        if (hadLinks) notifyRosterChange();
    }
    syncWakeLock();
    for (const fn of statusListeners) {
        try { fn(sdkStatus); } catch (e) {}
    }
}

// ---- screen wake lock -------------------------------------------------
// Held while a session is live ('connected' or 'interrupted'): a dimmed
// screen suspends the tab, and suspends are what break multiplayer. The
// browser auto-releases the lock when the tab hides; we re-request on
// return. Best-effort — denial (e.g. battery saver) is not an error.
let wakeLock = null;

async function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (e) { wakeLock = null; }
}

function syncWakeLock() {
    const want = sdkStatus === 'connected' || sdkStatus === 'interrupted';
    if (want && !wakeLock && document.visibilityState === 'visible') {
        requestWakeLock();
    } else if (!want && wakeLock) {
        try { wakeLock.release(); } catch (e) {}
        wakeLock = null;
    }
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        syncWakeLock();
        if (rdv && rdv.episodesActive()) {
            ArcadeDiag.log('bridge', 'page visible again — nudging rendezvous');
            rdv.nudgeAll('foreground');
        }
    } else if (rdv && rdv.episodesActive()) {
        // Evidence line: a wake lock only stops dimming while VISIBLE. Once
        // hidden, the browser may freeze this page's event loop outright —
        // the log must show where such a gap could have started.
        ArcadeDiag.log('bridge', 'page hidden — the browser may suspend timers and sockets until it returns');
    }
});
window.addEventListener('online', () => {
    if (rdv && rdv.episodesActive()) {
        ArcadeDiag.log('bridge', 'network back online — nudging rendezvous');
        rdv.nudgeAll('online');
    }
});
window.addEventListener('pageshow', (e) => {
    if (e.persisted && rdv && rdv.episodesActive()) {
        ArcadeDiag.log('bridge', 'page restored from bfcache — nudging rendezvous');
        rdv.nudgeAll('bfcache');
    }
});

async function ensureAddon() {
    if (addon) return addon;
    if (addonPromise) return addonPromise;

    addonPromise = (async () => {
        // Load the vendored QR libs FIRST — P2PAddon.init() skips any global
        // that already exists, so it never reaches for its CDN URLs.
        await loadLocalScript('./p2p/vendor/qrcode.min.js', 'QRCode');
        await loadLocalScript('./p2p/vendor/html5-qrcode.min.js', 'Html5Qrcode');

        const { default: P2PAddon } = await import('./p2p/p2p-addon.js');
        // Custom ICE servers apply to EVERY RTCPeerConnection this PeerManager
        // ever builds — first ceremony, in-band repair, and rendezvous
        // reconnect all go through the same _buildRtcConfig().
        const ice = iceServersConfig();
        const mp = new P2PAddon(ice ? { iceServers: ice } : {});
        await mp.init();
        ArcadeDiag.log('bridge', 'transport booted');
        // Transport-level diagnostics (interruptions, in-band repair, ICE)
        // feed the same connection log the Multiplayer dialog shows.
        mp.peerNode.addEventListener('diagnostic', (e) => {
            const d = e.detail || {};
            ArcadeDiag.log('p2p', (d.type && d.type !== 'info' ? d.type.toUpperCase() + ': ' : '') + d.msg);
        });

        // seat.announced tracks whether we've announced our identity to a peerId
        // yet, so a second peer joining an already-'connected' host still gets
        // our broadcast without re-announcing on every redundant status event.
        // seat.minted tracks whether a peerId's identity envelope already
        // triggered a pairing mint: identity frames ride the replayable
        // app-message path, so the SAME announcement can arrive twice — and a
        // second enablePair() mints a second random, the classic
        // committed-to-two-different-keys (permanently deaf) bug. One mint per link.
        mp.addEventListener('status', (e) => {
            const { peerId, status } = e.detail || {};
            applyStatus(mp);
            if (status === 'connected') {
                // A link coming up (fresh or rendezvous-resumed) means it's
                // no longer paused from the user's point of view, regardless
                // of how it got here.
                const devId = deviceIdForPeerId(peerId);
                if (devId) setKnownPeerPaused(devId, false);
                if (peerId) {
                    const seat = getSeat(peerId);
                    if (!seat.announced) announceSeat(mp, peerId);
                    // Belt and braces for the reverse direction: if THEIR
                    // announce hasn't produced a binding shortly after
                    // connect, ask for it (throttled; no-op once bound).
                    setTimeout(() => requestIdentityIfUnbound(mp, peerId), 4000);
                }
            } else if (peerId && (status === 'disconnected' || status === 'failed' || status === 'closed')) {
                // Terminal disconnect: reset announce/mint so a reconnect
                // re-announces and re-mints, but KEEP the deviceId binding — a
                // rendezvous repair re-adopts it (seatReachable gates its use;
                // a deliberate hang-up forgets it via unbindDevice, and full
                // idle clears every seat).
                const seat = seats.get(peerId);
                if (seat) { seat.announced = false; seat.minted = false; }
                forgetIdentityThrottles(peerId);
            }
        });

        // A peer noticed our identity never landed and asked for it (see the
        // announce-hardening block above). Ext frames arrive on the direct
        // link only, so peerId names a real link partner; the served-side
        // throttle bounds a spammy peer to one broadcast per window.
        mp.peerNode.addEventListener('control-ext', (e) => {
            const { peerId, ns, data } = e.detail || {};
            if (ns !== IDENTITY_REQ_NS || !data || !data.req) return;
            if (!peerId || !mp.peerNode.hasLink(peerId)) return;
            if (!identityThrottleOk(identityReqServedAt, peerId)) return;
            ArcadeDiag.log('bridge', `peer ${peerId} requested an identity announce — re-announcing`);
            announceSeat(mp, peerId);
        });

        // ALL arcade envelopes are handled at the TRANSPORT level, where the
        // sending link's peerId is available — identity frames need it for
        // the DTLS fingerprint, and game/presence frames need it to name the
        // sending device. Only a direct (non-relayed) identity may bind a
        // fingerprint; a relayed one still records the name.
        mp.peerNode.addEventListener('message', (e) => {
            const d = e.detail || {};
            if (!d.incoming) return;
            let env = null;
            try { env = JSON.parse(d.text); } catch (err) { return; }
            // Shape gate (arcade-envelope.js): discriminator, per-kind field
            // checks, and the deviceId pattern for identity frames. Routing
            // decisions (relayed gates, targeting, attribution) stay below.
            const shape = validatePeerEnvelope(env);
            if (!shape.ok) return;
            // A direct frame from a link we hold no identity binding for
            // means their announce got lost (the sync/backup/revoke/game
            // paths below will refuse or misattribute it) — ask them to
            // re-announce instead of staying silently deaf.
            if (!d.relayed && shape.kind !== 'identity' && !deviceIdForPeerId(d.peerId)) {
                requestIdentityIfUnbound(mp, d.peerId);
            }
            if (shape.kind === 'presence') {
                // The remote launcher says a game with this gameId is mounted
                // and listening over there.
                // Relayed presence originated at another joiner — attribute
                // it via the relay tag, not the link (which names the host).
                const presDeviceId = linkSenderDeviceId(d);
                const knownNow = readKnownPeers();
                const presName = (presDeviceId && knownNow[presDeviceId] && knownNow[presDeviceId].name)
                    || 'Unnamed device';
                for (const fn of presenceListeners) {
                    try { fn({ gameId: env.gameId, deviceId: presDeviceId, name: presName, kind: env.kind }); }
                    catch (err) {}
                }
                return;
            }
            if (shape.kind === 'sync') {
                // Launcher-level replication frames: direct links only (a relayed or
                // host-forwarded frame must never carry another device's sync data),
                // and only once the sender's identity binding completed.
                if (d.relayed) return;
                const syncDev = deviceIdForPeerId(d.peerId);
                if (!syncDev) return;
                for (const fn of syncListeners) { try { fn(syncDev, env); } catch (err) {} }
                return;
            }
            if (shape.kind === 'backup') {
                // Backup transfer frames: same delivery rules as 'sync' —
                // direct links only, identity binding required (a relayed or
                // host-forwarded frame must never carry another device's
                // backup data or spoof its origin).
                if (d.relayed) return;
                const backupDev = deviceIdForPeerId(d.peerId);
                if (!backupDev) return;
                for (const fn of backupListeners) { try { fn(backupDev, env); } catch (err) {} }
                return;
            }
            if (shape.kind === 'revoke') {
                // Signed device revocation (#32): same delivery rules as
                // 'sync'/'backup'. The envelope IS the entry ({deviceId,
                // revokedAt, sig} ride at the top level); applyRevocation
                // verifies the signature against the userPub already pinned
                // for the TARGET device, so nothing here trusts the sender
                // beyond "has a completed identity binding".
                if (d.relayed) return;
                const revokeSender = deviceIdForPeerId(d.peerId);
                if (!revokeSender) return;
                const rv = validateRevocationEntry(env);
                if (!rv.ok) return;
                applyRevocation(rv.entry, 'direct push from ' + revokeSender).catch(() => {});
                return;
            }
            if (shape.kind === 'game') {
                // A game's message. Route by gameId, attributing the sending
                // device when its identity handshake has completed.
                const isHub = mp.peerNode.isHost;
                // `fromDevice` is a HOST-stamped attribution on frames the
                // host bridge forwards joiner→joiner. A sender-supplied value
                // must never survive the hub, or a joiner could impersonate
                // any device on frames the host passes along.
                if (isHub) delete env.fromDevice;
                if (typeof env.to === 'string' && env.to !== getMyDeviceId()) {
                    // Addressed to someone else. As the hub, forward it down
                    // the addressee's direct link (stamping the true sender);
                    // any other arrival is an old host's blind relay of a
                    // targeted frame — drop it, never dispatch locally.
                    // A sender with no completed identity is never forwarded:
                    // an anonymous targeted frame would reach the addressee
                    // attributable to nobody — and (before the fromDevice-key
                    // check below existed) could read as host-authored.
                    if (isHub && deviceIndex.has(env.to) && seatReachable(deviceIndex.get(env.to))) {
                        const senderDev = deviceIdForPeerId(d.peerId);
                        if (senderDev) {
                            env.fromDevice = senderDev;
                            mp.sendTo(deviceIndex.get(env.to), env);
                        }
                    }
                    return;
                }
                // Attribution, in trust order: a host-forwarded frame carries
                // the host's stamp; a transport-relayed broadcast resolves
                // via its relay tag (the true sender, not the relaying
                // host); a direct frame resolves via its identity binding.
                // The mere PRESENCE of a fromDevice key marks a forward —
                // even a null/malformed one must not fall through to the
                // direct-link (host) attribution, or a forwarded frame could
                // read as host-authored.
                let fromDeviceId = null;
                let hostForwarded = false;
                if (!isHub && !d.relayed && 'fromDevice' in env) {
                    hostForwarded = true;
                    if (isDeviceId(env.fromDevice)) {
                        fromDeviceId = env.fromDevice;
                    }
                } else {
                    fromDeviceId = linkSenderDeviceId(d);
                }
                // meta is derived, not carried: a frame is only dispatched
                // when unaddressed ('all') or addressed to this device
                // ('me'); relayed covers both transport relays and
                // host-bridge forwards — "did NOT arrive from my direct
                // link partner", which is what spoof checks care about.
                const meta = {
                    relayed: !!d.relayed || hostForwarded,
                    to: typeof env.to === 'string' ? 'me' : 'all'
                };
                for (const fn of messageListeners) {
                    try { fn(env.gameId, env.payload, fromDeviceId, meta); } catch (err) {}
                }
                return;
            }
            // shape.kind === 'identity' — deviceId shape already vetted above;
            // recordPeerIdentity re-checks it (defense in depth for its other
            // callers) and owns name/fingerprint normalization.
            const fp = d.relayed ? null : mp.peerNode.getPeerFingerprint(d.peerId);
            if (!d.relayed && env.uid && typeof env.uid === 'object') {
                // Cross-signed identity (#32): signature checks are async, so
                // this frame completes a few microtasks later than a plain
                // one. Safe: nothing that needs the binding (sync/backup/
                // targeted frames) dispatches until the binding exists, and
                // peers only talk after announcing. The verdict is computed
                // BEFORE recordPeerIdentity so the pin promotion and the
                // pending-pin stash are decided in one atomic write.
                (async () => {
                    let uid = null;
                    try { uid = await evaluateIdentityUid(env.deviceId, env.uid, fp); } catch (err) {}
                    finishIdentityBranch(mp, d, env, recordPeerIdentity(env.deviceId, env.name, fp, uid));
                    try { await processRevocationGossip(env.uid.revocations); } catch (err) {}
                })();
                return;
            }
            finishIdentityBranch(mp, d, env, recordPeerIdentity(env.deviceId, env.name, fp));
        });

        // Everything after an identity frame's upsert: relay bookkeeping,
        // seat binding, roster, pause-clear, suspect marking, pairing mint.
        // Extracted verbatim from the listener so the cross-signed (async)
        // and plain (sync) arrival paths above cannot drift apart.
        function finishIdentityBranch(mp, d, env, detail) {
            if (!detail) return; // bind nothing
            if (d.relayed && !mp.peerNode.isHost && typeof d.from === 'string'
                    && env.deviceId !== getMyDeviceId()) {
                // Another joiner, reachable only through the host. The relay
                // tag is host-stamped (the source link's peerId), so a joiner
                // cannot claim someone else's tag — but it CAN claim someone
                // else's deviceId; the tag binding at least keeps its frames
                // attributed to the one link they actually arrive from.
                // (The hub itself never takes this branch: it holds direct
                // links to everyone, and the transport strips any forged
                // inbound `relayed` flag before dispatch anyway.)
                // A relayed identity must never override a LIVE direct binding:
                // otherwise a joiner could relay-claim a directly-connected
                // peer's deviceId and steal its broadcast attribution (S-sec-2).
                // Strict live-link check so a stale binding doesn't wrongly block
                // a legitimate relayed (re)appearance.
                if (deviceIndex.has(env.deviceId) && mp.peerNode.hasLink(deviceIndex.get(env.deviceId))) {
                    ArcadeDiag.log('bridge', `ignored relayed identity for ${env.deviceId}: already a live direct seat`);
                    return;
                }
                const firstSighting = !indirectPeers.has(env.deviceId);
                indirectPeers.set(env.deviceId, d.from);
                if (firstSighting) {
                    // Identity gossip: this device announced itself when ITS
                    // link connected — a joiner arriving later never heard
                    // it. First sighting of a newcomer ⇒ re-broadcast our
                    // identity once; the host relays it to them, making
                    // session knowledge symmetric (they can target us and
                    // attribute our broadcasts). Converges in one round:
                    // their identity is already recorded here, so their
                    // handler's own first-sighting re-announce (of us) finds
                    // nothing new on this side.
                    sendIdentity(mp, d.peerId);
                }
            }
            if (!d.relayed) {
                // Refuse to rebind a deviceId whose CURRENT link is still LIVE (a
                // real peer entry, connected or interrupted): a direct peer
                // announcing another live seat's deviceId would otherwise capture
                // that seat's inbound targeted frames and get its own frames
                // host-stamped with the victim's identity (S-sec-1). Uses a strict
                // live-link check, NOT seatReachable — a merely stashed/repairing
                // session must yield to a fresh manual re-ceremony (that's exactly
                // how a user recovers a dead link), which mints a new peerId.
                const boundPeerId = deviceIndex.get(env.deviceId);
                if (boundPeerId !== undefined && boundPeerId !== d.peerId
                        && mp.peerNode.hasLink(boundPeerId)) {
                    ArcadeDiag.log('bridge', `refused identity rebind: ${env.deviceId} still live on ${boundPeerId} (claim from ${d.peerId})`);
                    return;
                }
                bindSeatDevice(d.peerId, env.deviceId);
                // On a joiner, the direct link IS the host — record which
                // wire capabilities it announced (empty for an older host,
                // which gates targeted sends off; see WIRE_CAPS).
                if (!mp.peerNode.isHost) {
                    hostCaps = new Set(Array.isArray(env.caps)
                        ? env.caps.filter((c) => typeof c === 'string') : []);
                }
                // A direct identity binding is a roster join (or a rename —
                // recordPeerIdentity above already upserted the name).
                notifyRosterChange();
                // A completed handshake means this connection is live on
                // purpose — clear any leftover hang-up flag. (The status
                // handler's clear above misses FRESH ceremonies, because at
                // 'connected' time this seat's deviceId binding didn't exist.)
                setKnownPeerPaused(env.deviceId, false);
                if (detail.fingerprintChanged) fingerprintSuspects.add(env.deviceId);
                // A verified re-attestation (#32) clears any leftover suspect
                // state from an earlier session's unverified sighting of the
                // same rotation — the pending pin was already promoted inside
                // recordPeerIdentity's write.
                if (detail.fingerprintAutoPromoted) fingerprintSuspects.delete(env.deviceId);
                // A manual ceremony with an auto-reconnect peer is a fresh
                // trust event: re-establish the pairing secret every time —
                // UNLESS this link's fingerprint mismatches the pinned one.
                // A changed fingerprint on a known deviceId is exactly what a
                // peer claiming another device's id looks like, so the rebind
                // waits for an explicit user decision (the launcher confirms
                // via onPeerIdentity's fingerprintChanged flag).
                const known = readKnownPeers();
                const seat = getSeat(d.peerId);
                if (known[env.deviceId] && known[env.deviceId].autoReconnect && rdv
                        && !isFingerprintSuspect(env.deviceId, known)
                        && !seat.minted) {
                    seat.minted = true;
                    rdv.enablePair(d.peerId, env.deviceId).catch(() => {});
                    stampLiveSession();
                }
            }
        }

        // Rendezvous (PROTOCOL.md §7): zero-touch reconnection for opted-in
        // pairs. The carrier moves only sealed blobs; episodes surface to
        // games as 'interrupted' so nobody resets a running game. 'gave-up'
        // (v1.10) means the episode went QUIET — games release the session,
        // but the pair stays subscribed and reachable, so a much later
        // 'reconnected' with no fresh 'reconnecting' in between is normal.
        rdv = new RendezvousManager(mp.peerNode, { carrierFactory: rdvCarrierFactory });
        // Which build produced this log? Answer it up front: stale-cache
        // sessions are indistinguishable from real bugs without this line.
        ArcadeDiag.log('rdv', `build ${RDV_BUILD}`);
        rdv.addEventListener('diagnostic', (e) => {
            const d = e.detail || {};
            ArcadeDiag.log('rdv', (d.type && d.type !== 'info' ? d.type.toUpperCase() + ': ' : '') + d.msg);
        });
        rdv.addEventListener('reconnecting', (e) => {
            const { peerId } = e.detail || {};
            if (peerId) rdvReconnecting.add(peerId);
            applyStatus(mp);
        });
        for (const done of ['reconnected', 'recovered-inband', 'gave-up']) {
            rdv.addEventListener(done, (e) => {
                const { peerId } = e.detail || {};
                if (peerId) rdvReconnecting.delete(peerId);
                else rdvReconnecting.clear(); // legacy event without a peerId: clear all
                applyStatus(mp);
                if (done !== 'gave-up') stampLiveSession();
            });
        }
        rdv.addEventListener('pair-established', () => stampLiveSession());
        rdv.addEventListener('remote-bye', (e) => {
            // The peer hung up on purpose. Drop the link NOW instead of
            // letting it linger 'interrupted' through the repair grace
            // period — games should see the session end promptly. The
            // rendezvous layer already recorded the bye, so the teardown
            // below starts a quiet standby (callable), not a repair episode.
            const { peerId } = e.detail || {};
            if (peerId && mp.peerNode.hasLink(peerId)) {
                mp.peerNode.disconnectPeer(peerId);
            }
            const devId = peerId ? deviceIdForPeerId(peerId) : null;
            if (devId) {
                const known = readKnownPeers();
                for (const fn of remoteByeListeners) {
                    try { fn({ deviceId: devId, name: (known[devId] && known[devId].name) || 'Unnamed device' }); }
                    catch (err) {}
                }
            }
        });
        rdv.addEventListener('pair-request', (e) => {
            // The other device opted in; ours decides based on the stored
            // flag, or asks the user via the launcher's onPairRequest hook.
            const { peerId } = e.detail || {};
            const deviceId = deviceIdForPeerId(peerId);
            if (!deviceId) return;
            const known = readKnownPeers();
            const flag = known[deviceId] && known[deviceId].autoReconnect;
            if (flag === true && !isFingerprintSuspect(deviceId, known)) {
                rdv.enablePair(peerId, deviceId).catch(() => {});
            } else if (flag === undefined || (flag === true && isFingerprintSuspect(deviceId, known))) {
                // Undecided — or decided, but this link's fingerprint changed
                // since the flag was stored. Either way the user re-confirms.
                for (const fn of pairRequestListeners) {
                    try { fn({ deviceId, name: (known[deviceId] && known[deviceId].name) || 'Unnamed device' }); } catch (err) {}
                }
            } // flag === false → user declined; stay silent
        });

        // Game messages are routed on the transport 'message' listener above
        // (the addon's parsed 'data' event has no peerId, so it can't
        // attribute a sender).

        // Suspend detector. Browsers freeze a page's event loop entirely
        // (iOS Safari within seconds of backgrounding or the screen locking;
        // wake locks only prevent dimming while visible), and a frozen page
        // neither publishes to nor hears the dead-drop — field logs showed a
        // Call arming its offer and then 90+ silent seconds. The heartbeat
        // makes any freeze VISIBLE in the connection log (with its measured
        // length, so "did the phone sleep?" is answerable from a bug report)
        // and kicks the rendezvous the moment the page thaws —
        // visibilitychange alone is not delivered on every iOS resume path.
        let lastBeat = Date.now();
        setInterval(() => {
            const gap = Date.now() - lastBeat - 5000;
            lastBeat = Date.now();
            if (gap > 4000) {
                ArcadeDiag.log('bridge', `suspend detected: event loop was paused ~${Math.round(gap / 1000)}s — nudging rendezvous`);
                if (rdv) rdv.nudgeAll('suspend-recovery');
            }
        }, 5000);

        addon = mp;
        return mp;
    })();

    try {
        return await addonPromise;
    } catch (e) {
        addonPromise = null; // allow retry on transient load failures
        throw e;
    }
}

export const ArcadeP2P = {
    /** Current SDK-vocabulary status: 'idle' | 'connecting' | 'connected' | 'interrupted'. */
    status() { return sdkStatus; },

    /** Subscribe to status changes (SDK vocabulary). Returns unsubscribe. */
    onStatus(fn) {
        statusListeners.push(fn);
        return () => {
            const i = statusListeners.indexOf(fn);
            if (i >= 0) statusListeners.splice(i, 1);
        };
    },

    /**
     * Subscribe to inbound game messages: fn(gameId, payload, fromDeviceId,
     * meta). fromDeviceId is the sending device's stable id (null until its
     * identity handshake completes — a beat after 'connected'). meta is
     * { relayed, to }: relayed=true when the frame did NOT arrive from this
     * device's direct link partner (transport relay or host-bridge forward);
     * to is 'me' for targeted frames, 'all' for broadcasts.
     */
    onMessage(fn) {
        messageListeners.push(fn);
        return () => {
            const i = messageListeners.indexOf(fn);
            if (i >= 0) messageListeners.splice(i, 1);
        };
    },

    /** Subscribe to launcher-level sync envelopes: fn(fromDeviceId, env). Direct links only. */
    onSyncEnvelope(fn) {
        syncListeners.push(fn);
        return () => {
            const i = syncListeners.indexOf(fn);
            if (i >= 0) syncListeners.splice(i, 1);
        };
    },

    /**
     * Send a launcher-level sync envelope to one paired device over its
     * DIRECT link only (never relayed/host-forwarded — see the transport
     * listener's `kind:'sync'` branch). Returns false when there is no live
     * session, or when `deviceId` is unknown / its seat isn't reachable.
     */
    sendSyncEnvelope(deviceId, env) {
        if (!addon || (sdkStatus !== 'connected' && sdkStatus !== 'interrupted')) return false;
        const pid = deviceIndex.get(deviceId);
        if (pid === undefined || !seatReachable(pid)) return false;
        return addon.sendTo(pid, { ...env, arcade: 1, kind: 'sync' });
    },

    /** Subscribe to launcher-level backup envelopes: fn(fromDeviceId, env). Direct links only. */
    onBackupEnvelope(fn) {
        backupListeners.push(fn);
        return () => {
            const i = backupListeners.indexOf(fn);
            if (i >= 0) backupListeners.splice(i, 1);
        };
    },

    /**
     * Send a launcher-level backup envelope to one paired device over its
     * DIRECT link only — the same contract as sendSyncEnvelope (see the
     * transport listener's `kind:'backup'` branch). Returns false when there
     * is no live session, or when `deviceId` is unknown / unreachable.
     */
    sendBackupEnvelope(deviceId, env) {
        if (!addon || (sdkStatus !== 'connected' && sdkStatus !== 'interrupted')) return false;
        const pid = deviceIndex.get(deviceId);
        if (pid === undefined || !seatReachable(pid)) return false;
        return addon.sendTo(pid, { ...env, arcade: 1, kind: 'backup' });
    },

    /**
     * Write-side validators for the Multiplayer dialog's Advanced panel
     * (self-hosted broker / TURN overrides). Same functions the read side
     * uses, so what the panel accepts is exactly what the bridge honors.
     */
    validateBrokerUrls,
    validateIceServers,

    /**
     * The built-in defaults, for prepopulating that panel — the user edits
     * the real default lists instead of divining them. Copies: mutating the
     * return value must never reach the live config.
     */
    defaultBrokerUrls() { return RDV_BROKER_URLS.slice(); },
    defaultIceServers() { return DEFAULT_ICE_SERVERS.map((s) => ({ ...s })); },

    /**
     * Sync-gate support (arcade-sync.js): read-only passthrough to the
     * module-internal fingerprint-suspect check pairing itself already uses.
     * The sync engine must gate both inbound handling and outbound exchange
     * starts on this — a device whose fingerprint changed this session (or
     * has a still-unconfirmed pending pin) must not gain sync write
     * authority over this device's storage until the user re-trusts it.
     */
    isFingerprintSuspect(deviceId) {
        return isFingerprintSuspect(deviceId);
    },

    /**
     * Presence: fires when the remote launcher announces that a game with a
     * given gameId is mounted and listening — fn({gameId, deviceId, name,
     * kind}). kind 'presence' expects an ack (announceGame(gameId, true))
     * when we have the same game mounted; 'presence-ack' is the echo.
     */
    onPresence(fn) {
        presenceListeners.push(fn);
        return () => {
            const i = presenceListeners.indexOf(fn);
            if (i >= 0) presenceListeners.splice(i, 1);
        };
    },

    /**
     * Tell the remote launcher a game with this gameId is mounted and
     * listening here. isAck answers a received 'presence' (no further reply,
     * so the two-frame exchange terminates).
     */
    announceGame(gameId, isAck) {
        if (!addon || (sdkStatus !== 'connected' && sdkStatus !== 'interrupted')) return false;
        if (typeof gameId !== 'string' || !gameId) return false;
        addon.send({ arcade: 1, kind: isAck ? 'presence-ack' : 'presence', gameId });
        return true;
    },

    /**
     * Live remote devices whose identity handshake completed:
     * [{deviceId, name, status, direct}]. Used to seed a freshly-mounted
     * game's roster (welcome.peers) — same shape as onRosterChange pushes.
     */
    connectedPeers() {
        return rosterSnapshot();
    },

    /**
     * Subscribe to roster changes — one coarse event with the full roster
     * (same shape as connectedPeers()) on any join/leave/rename/per-peer
     * status change. Returns unsubscribe.
     */
    onRosterChange(fn) {
        rosterListeners.push(fn);
        return () => {
            const i = rosterListeners.indexOf(fn);
            if (i >= 0) rosterListeners.splice(i, 1);
        };
    },

    /**
     * Re-derive the roster and notify subscribers if it changed. For events
     * the bridge can't observe itself — today: a local rename in the Known
     * Peers panel, which writes storage the roster names read from.
     */
    refreshRoster() {
        notifyRosterChange();
    },

    /**
     * Per-connection status for one known peer — distinct from status()
     * above, which aggregates every live link into one SDK-facing value.
     * Returns 'connected' | 'interrupted' | 'connecting' | 'paused' | 'idle'.
     * 'paused' means the user hung up on purpose (hangUpKnownPeer) and it
     * hasn't come back up since; 'idle' covers everything else not
     * currently live (never connected this session, or dropped on its own).
     */
    connectionState(deviceId) {
        const peerId = deviceIndex.get(deviceId);
        if (addon && peerId) {
            const linkStatus = addon.peerNode.linkStatus(peerId);
            if (linkStatus) {
                if (linkStatus === 'connected') return 'connected';
                if (linkStatus === 'interrupted') return 'interrupted';
                return 'connecting';
            }
        }
        const known = readKnownPeers()[deviceId];
        return (known && known.paused) ? 'paused' : 'idle';
    },

    /**
     * Replay-queue visibility: { depth, limit, overflowed }. depth is the
     * deepest per-link outbox (live links and rendezvous-stashed sessions);
     * overflowed means the transport already dropped the oldest unacked
     * messages and games should resync state after recovery.
     */
    queueSnapshot() {
        if (!addon) return { depth: 0, limit: 0, overflowed: false };
        return addon.peerNode.outboxSnapshot();
    },

    /**
     * Subscribe to peer identity handshakes — fires once per newly-connected
     * transport peer once its self-reported identity arrives (a beat after
     * its status goes 'connected'): fn({deviceId, name, remoteName, isNew,
     * fingerprintChanged, fingerprintAutoPromoted}). `name` is the
     * locally-stored label (see index.html's Known Peers menu panel for
     * rename/delete); `isNew` marks a device seen for the first time.
     * `fingerprintAutoPromoted` (#32) means the fingerprint DID rotate but a
     * verified device cert from the pinned userPub covered it — the pin was
     * updated silently and no warning should be shown.
     */
    onPeerIdentity(fn) {
        peerIdentityListeners.push(fn);
        return () => {
            const i = peerIdentityListeners.indexOf(fn);
            if (i >= 0) peerIdentityListeners.splice(i, 1);
        };
    },

    /**
     * Subscribe to verified revocation latches (#32): fn({deviceId, name})
     * fires after a revocation of a known device passed signature
     * verification and was recorded — however it arrived (direct push,
     * identity-frame gossip, or this device's own revokeDevice call).
     */
    onRevoked(fn) {
        revokedListeners.push(fn);
        return () => {
            const i = revokedListeners.indexOf(fn);
            if (i >= 0) revokedListeners.splice(i, 1);
        };
    },

    /**
     * Revoke one of THIS user's own devices (#32) — the lost-phone action.
     * Only permitted when the target's pinned userPub equals this device's
     * own user identity (cryptographic proof it's literally another of the
     * user's devices — this API can never "ban" someone else's device).
     * Signs the revocation, latches it locally (quarantining the target out
     * of auto-reconnect/sync/backup), then pushes it to every currently
     * connected peer; identity-frame gossip carries it to everyone else
     * over time. Best-effort propagation by design — there is no server to
     * guarantee delivery, matching sync/backup's posture. Returns false when
     * the target isn't provably ours or nothing could be signed.
     */
    async revokeDevice(deviceId) {
        ArcadeDiag.log('bridge', `user action: revoke device ${deviceId}`);
        const meta = readUserIdentityMeta();
        const rec = readKnownPeers()[deviceId];
        if (!meta || !rec || rec.userPub !== meta.userPub || rec.revoked) return false;
        const entry = await signRevocation(deviceId);
        if (!entry) return false;
        // Same verify-and-latch path gossip uses — our own signature passes
        // the same gate, so the local latch can never diverge from what
        // peers will accept.
        const applied = await applyRevocation(entry, 'local user action');
        if (!applied) return false;
        if (addon) {
            for (const [devId, pid] of deviceIndex) {
                if (devId === deviceId || !seatReachable(pid)) continue;
                try { addon.sendTo(pid, { arcade: 1, kind: 'revoke', ...entry }); } catch (e) {}
            }
        }
        return true;
    },

    /**
     * Open the connection modal. Default: the Host / Join choice screen.
     * {mode:'host'} skips straight to a FRESH invite code — the one-tap
     * "Reconnect" entry for known peers (signaling is one-time-use by design,
     * so reconnecting means a fresh code with zero navigation to reach it).
     */
    async openUI(options) {
        (await ensureAddon()).showUI(options);
    },

    /**
     * Send a game's payload, wrapped in the launcher envelope. No `to` —
     * broadcast to every connected peer, exactly as before. With `to` (a
     * deviceId) — targeted: delivered on that device's direct link, or (a
     * joiner addressing another joiner) via the host bridge, which forwards
     * down the addressee's link; non-addressees never RECEIVE the frame.
     * Returns false when there is no live session, or when `to` is unknown /
     * its identity exchange hasn't completed — a private frame is never
     * silently downgraded to broadcast. During an 'interrupted' session the
     * transport queues and replays on recovery (exactly-once), targeted or
     * not.
     */
    send(gameId, payload, to) {
        if (!addon || (sdkStatus !== 'connected' && sdkStatus !== 'interrupted')) return false;
        if (to === undefined) {
            addon.send({ arcade: 1, gameId, payload });
            return true;
        }
        if (typeof to !== 'string' || to === getMyDeviceId()) return false;
        // Every targeted frame a JOINER sends transits the host, which must
        // honor noRelay (and forward joiner→joiner targets). An older host
        // announced no wire caps — it would blind-relay the private frame to
        // every seat — so refuse here; the game's caps()-negotiated fallback
        // covers mixed-version tables. A host's own targeted sends travel
        // only the addressee's direct link, so they need no such gate.
        if (!addon.peerNode.isHost && !hostCaps.has('peer.sendTo')) return false;
        const env = { arcade: 1, gameId, payload, to };
        const directLink = deviceIndex.get(to);
        if (directLink !== undefined) {
            // A binding can outlive its link (departed seat whose stash lingers
            // with no active repair) — refuse rather than report phantom
            // delivery into a dead session (B-p2p-1).
            if (!seatReachable(directLink)) return false;
            return addon.sendTo(directLink, env);
        }
        if (!addon.peerNode.isHost && indirectPeers.has(to)) {
            const hostLink = hostLinkPeerId();
            if (hostLink) return addon.sendTo(hostLink, env);
        }
        return false;
    },

    /**
     * Call at startup: if the URL fragment carries an offer/answer (invite or
     * reply link aimed at the launcher), boot the transport now so its
     * fragment ingestion + relay/ack logic runs. No-op otherwise.
     */
    async ingestFragmentIfPresent() {
        if (!/[#&]p2p-(offer|answer)=/.test(window.location.hash)) return false;
        await ensureAddon(); // P2PUIManager ingests the fragment on construction
        return true;
    },

    /**
     * Turns auto-reconnect ON for a known peer. If a pairing secret already
     * exists (this peer was paired before and later toggled off), re-arms it
     * in place via resumePair() — no live channel needed, since nothing was
     * forgotten. Only when NO secret exists yet does this fall back to
     * minting a fresh one over the direct link, which requires that link to
     * be live right now; the other device must opt in too (pairing
     * completes when both randoms cross). With neither an existing secret
     * nor a live link, the flag is simply set for next time you connect —
     * returns false in that case so callers don't claim a reconnect attempt
     * that never actually happened.
     */
    async enableAutoReconnect(deviceId) {
        ArcadeDiag.log('bridge', `user action: enable auto-reconnect for ${deviceId}`);
        const known = readKnownPeers();
        if (!known[deviceId]) return false;
        // A revoked device (#32) cannot be re-trusted through this path —
        // the UI hides the toggle, but the API refuses too. The only way
        // back is the explicit local un-revoke (clearKnownPeerRevoked).
        if (known[deviceId].revoked) return false;
        known[deviceId].autoReconnect = true;
        // Explicit user decision — re-trust this device even if its fingerprint
        // changed. Promote any pending fingerprint to the trusted pin so future
        // sessions accept it without re-prompting.
        if (known[deviceId].pinPendingFingerprint) {
            known[deviceId].fingerprint = known[deviceId].pinPendingFingerprint;
            delete known[deviceId].pinPendingFingerprint;
            delete known[deviceId].fingerprintChangedAt;
        }
        writeKnownPeers(known);
        fingerprintSuspects.delete(deviceId);
        await ensureAddon(); // rdv is only populated once the addon has loaded
        const peerId = deviceIndex.get(deviceId);
        if (peerId && addon.peerNode.linkStatus(peerId) === 'connected') {
            // The link is live: enabling here is a fresh trust event, so mint
            // (or refresh) the pairing secret over the channel — this also
            // consumes a pending pair-request random from the other side.
            // Resuming the OLD secret instead (the previous behavior) left
            // that random dangling and re-armed a stale-key episode against
            // a connected peer (seen in field logs).
            await rdv.enablePair(peerId, deviceId).catch(() => {});
            // Re-enable a paused stored record too; with the live link bound
            // it sees 'already connected' and rings nothing.
            await rdv.resumePair(deviceId).catch(() => false);
            stampLiveSession();
            return true;
        }
        if (await rdv.resumePair(deviceId).catch(() => false)) {
            stampLiveSession();
            return true;
        }
        if (peerId && addon.peerNode.hasLink(peerId)) {
            // Link exists but isn't fully up (mid-ceremony/interrupted) — a
            // best-effort mint; completion needs the channel to open.
            await rdv.enablePair(peerId, deviceId).catch(() => {});
            stampLiveSession();
            return true;
        }
        return false;
    },

    /**
     * Turns auto-reconnect OFF. Unlike startOverKnownPeer(), this SUSPENDS
     * the pairing (rdv.pausePair — same primitive hangUpKnownPeer uses)
     * rather than forgetting the secret: it's a lightweight preference
     * toggle, so re-enabling later needs no new ceremony to work again.
     */
    async disableAutoReconnect(deviceId) {
        ArcadeDiag.log('bridge', `user action: disable auto-reconnect for ${deviceId}`);
        const known = readKnownPeers();
        if (known[deviceId]) {
            known[deviceId].autoReconnect = false;
            writeKnownPeers(known);
        }
        await ensureAddon(); // rdv is only populated once the addon has loaded
        await rdv.pausePair(deviceId).catch(() => {});
    },

    /** true | false | undefined (never asked). */
    autoReconnectState(deviceId) {
        const rec = readKnownPeers()[deviceId];
        return rec ? rec.autoReconnect : undefined;
    },

    /**
     * Hangs up on this peer: says goodbye over the live channel (so the
     * other side doesn't burn a repair episode on a link we closed on
     * purpose — it drops to quiet standby instead, still callable), then
     * drops the link and tells our rendezvous layer to stop healing it.
     * Unlike disableAutoReconnect(), the pairing secret is kept, so
     * callKnownPeer() needs no new ceremony to bring it back.
     */
    async hangUpKnownPeer(deviceId) {
        ArcadeDiag.log('bridge', `user action: Hang Up ${deviceId}`);
        setKnownPeerPaused(deviceId, true);
        await ensureAddon(); // rdv/addon are only populated once the addon has loaded
        // Pause OUR side before the bye goes out: the peer reacts to a bye by
        // dropping the link immediately, and if our pair were still enabled
        // when that close lands, our own rendezvous would fire a repair
        // episode for the very link we're hanging up (and litter the
        // dead-drop with an offer nobody should answer).
        await rdv.pausePair(deviceId).catch(() => {});
        const peerId = deviceIndex.get(deviceId);
        if (peerId && addon.peerNode.hasLink(peerId)) {
            const byeSent = rdv.sendBye(peerId);
            if (!byeSent) {
                // The channel wasn't open (link interrupted/mid-repair): the
                // peer will see a plain link death, burn a repair episode,
                // and keep ringing a paused pair. Not fatal, but the log
                // must say so — "they hung up but I kept calling" reports
                // start exactly here.
                ArcadeDiag.log('bridge', `Hang Up ${deviceId}: bye could NOT be sent (channel not open) — the peer will treat this as a connection failure`);
            }
            // Give the bye frame a beat to flush before the pc closes under it.
            await new Promise((r) => setTimeout(r, 250));
        }
        if (peerId && addon.peerNode.hasLink(peerId)) {
            addon.peerNode.disconnectPeer(peerId);
        }
        return true;
    },

    /**
     * Calls this peer back: clears the paused flag and, for an auto-reconnect
     * peer, rings it through the dead-drop right now. The ring lands whenever
     * the other device has the arcade open with the pair enabled — it does
     * NOT require the other user to act, only to not have hung up themselves.
     * Returns false when there's no pairing secret on record to ring with,
     * so callers should keep a manual "get a new invite code" action
     * available alongside this either way.
     */
    async callKnownPeer(deviceId) {
        ArcadeDiag.log('bridge', `user action: Call ${deviceId}`);
        setKnownPeerPaused(deviceId, false);
        const known = readKnownPeers()[deviceId];
        if (known && known.autoReconnect) {
            await ensureAddon(); // rdv is only populated once the addon has loaded
            // Honest signal: resumePair() returns false when there's no
            // pairing secret on record to re-arm (e.g. it was never
            // established, or was forgotten before this peer's last manual
            // reconnect) — that must NOT be reported as "trying" when
            // nothing was actually attempted.
            const tried = await rdv.resumePair(deviceId).catch((e) => {
                ArcadeDiag.log('bridge', `Call ${deviceId} failed: ${e && e.message}`);
                return false;
            });
            if (!tried) ArcadeDiag.log('bridge', `Call ${deviceId}: no pairing secret on record — nothing rung`);
            return tried;
        }
        ArcadeDiag.log('bridge', `Call ${deviceId}: auto-reconnect is off for this peer — nothing rung`);
        return false;
    },

    /**
     * Wipes this connection back to a blank slate: drops any live link,
     * forgets its stashed session (no resume-in-place on the next
     * reconnect), and forgets the rendezvous pairing secret (auto-reconnect
     * flips off — there's nothing left for it to resume). The saved
     * name/history stay; only deleteKnownPeer() forgets those too.
     */
    async startOverKnownPeer(deviceId) {
        ArcadeDiag.log('bridge', `user action: Start Over ${deviceId} (forgetting session + pairing secret)`);
        await ensureAddon(); // rdv/addon are only populated once the addon has loaded
        const peerId = deviceIndex.get(deviceId);
        if (peerId) {
            addon.peerNode.disconnectPeer(peerId);
            addon.peerNode.forgetSession(peerId);
        }
        await rdv.disablePair(deviceId).catch(() => {});
        unbindDevice(deviceId);
        const known = readKnownPeers();
        if (known[deviceId]) {
            known[deviceId].autoReconnect = false;
            known[deviceId].paused = false;
            writeKnownPeers(known);
        }
        return true;
    },

    /**
     * Fires when a peer requests auto-reconnect pairing and this device has
     * no stored decision: fn({deviceId, name}). Answer by calling
     * enableAutoReconnect / disableAutoReconnect.
     */
    onPairRequest(fn) {
        pairRequestListeners.push(fn);
        return () => {
            const i = pairRequestListeners.indexOf(fn);
            if (i >= 0) pairRequestListeners.splice(i, 1);
        };
    },

    /**
     * Fires when a peer hangs up on purpose (its user tapped Hang Up):
     * fn({deviceId, name}). The link is already being dropped; this is for
     * UI feedback — distinguish "they hung up" from a connection failure.
     */
    onRemoteBye(fn) {
        remoteByeListeners.push(fn);
        return () => {
            const i = remoteByeListeners.indexOf(fn);
            if (i >= 0) remoteByeListeners.splice(i, 1);
        };
    },

    /**
     * Call at launcher startup: if a paired session was live recently, boot
     * the transport and let the rendezvous layer actively reconnect it —
     * this is what resumes a game after the browser was killed on both
     * ends. Outside that window, any auto-reconnect peer still gets a quiet
     * STANDBY (subscribe-only): this device initiates nothing, but a Call
     * from the other side reaches it for as long as the arcade is open.
     */
    async resumeRendezvous() {
        let ts = 0;
        try { ts = parseInt(localStorage.getItem(LAST_LIVE_SESSION_KEY) || '0', 10); } catch (e) {}
        const fresh = ts && Date.now() - ts <= RESUME_WINDOW_MS;
        if (!fresh) {
            const known = readKnownPeers();
            if (!Object.values(known).some((p) => p && p.autoReconnect && !p.paused)) {
                ArcadeDiag.log('bridge', 'resume-on-launch: no recent session and no callable auto-reconnect peer — staying cold');
                return false;
            }
            ArcadeDiag.log('bridge', `resume-on-launch: last live session ${ts ? Math.round((Date.now() - ts) / 60000) + 'm ago' : 'never'} (outside ${RESUME_WINDOW_MS / 3600000}h window) — arming quiet standby only`);
            await ensureAddon();
            await rdv.standbyAll();
            return true;
        }
        ArcadeDiag.log('bridge', `resume-on-launch: last live session ${Math.round((Date.now() - ts) / 60000)}m ago — actively resuming paired sessions`);
        await ensureAddon();
        await rdv.resumeAll();
        return true;
    },

    /** Test hook — the underlying P2PAddon (null until first use). */
    _addon() { return addon; },

    /** Test hook — the RendezvousManager (null until first use). */
    _rdv() { return rdv; },

    /** Test hook — identity/pinning policy, exercised directly by acceptance. */
    _recordPeerIdentity: recordPeerIdentity,

    /** Test hook — deviceId → direct-link peerId snapshot. */
    _identityLinks() { return Object.fromEntries(deviceIndex); },

    /** Test hook — deviceId → relay-tag snapshot (through-the-host peers). */
    _indirectPeers() { return Object.fromEntries(indirectPeers); }
};

export default ArcadeP2P;
