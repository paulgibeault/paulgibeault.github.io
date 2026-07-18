import { SDPCodec } from './sdp-codec.js';

// Exported so the launcher can prepopulate its Advanced panel with the real
// default list — the user edits the actual defaults rather than divining them.
export const DEFAULT_ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun.services.mozilla.com' }
];
const STUN_SERVERS = { iceServers: DEFAULT_ICE_SERVERS };

// ==========================================
// UTILS: Compression & QR
// ==========================================
export class ConnectionUtils {
    static async compressData(dataStr) {
        const stream = new Blob([dataStr], {type: 'application/json'}).stream().pipeThrough(new CompressionStream('deflate-raw'));
        const blob = await new Response(stream).blob();
        const buffer = await blob.arrayBuffer();

        // Robust Uint8Array to base64 conversion that avoids call stack limits
        let binary = '';
        const bytes = new Uint8Array(buffer);
        const len = bytes.byteLength;
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        const b64 = btoa(binary);

        // Convert standard base64 to base64url (URL-Safe)
        return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    static async decompressData(b64Str) {
        try {
            // Convert URL-safe base64url back to standard base64
            let standardB64 = b64Str.replace(/-/g, '+').replace(/_/g, '/');
            while (standardB64.length % 4) {
                standardB64 += '=';
            }
            const bytes = Uint8Array.from(atob(standardB64), c => c.charCodeAt(0));
            const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
            const blob = await new Response(stream).blob();
            return await blob.text();
        } catch (e) {
            throw new Error(`Decompression failed: ${e.message}`);
        }
    }

    /**
     * Strips bulky/unnecessary lines from an SDP string to reduce QR code size.
     * Filters out TCP candidates, optionally mDNS (.local) and IPv6 (per
     * options), and keeps only the FIRST candidate per (type × address family)
     * category. Phones routinely gather several IPv6 privacy addresses and one
     * mDNS name per interface — each redundant candidate costs 7-19 packed
     * bytes, which is what pushes the QR past comfortably-scannable versions.
     * One candidate per category preserves every distinct connectivity path
     * (mDNS same-LAN, direct v4, direct v6, reflexive, relay); the duplicates
     * it drops were alternates for the SAME path.
     */
    static minifySDP(sdpStr, options = {}) {
        const allowLocal = options.allowLocalCandidates !== false;
        const allowIPv6 = options.allowIPv6Candidates !== false;
        const seenCategories = new Set();
        const lines = sdpStr.split('\r\n');
        const minified = lines.filter(line => {
            if (line.startsWith('a=candidate:')) {
                // Drop TCP candidates (UDP is preferred for WebRTC data)
                if (line.includes(' tcp ')) return false;

                // Drop mDNS candidates if not allowed
                if (!allowLocal && line.includes('.local')) return false;

                const parts = line.split(' ');
                const address = parts.length > 4 ? parts[4] : '';
                // Drop IPv6 candidates if not allowed
                if (!allowIPv6 && address.includes(':')) return false;

                const typIdx = parts.indexOf('typ');
                const type = typIdx >= 0 ? parts[typIdx + 1] : 'host';
                const family = address.endsWith('.local') ? 'mdns'
                    : (address.includes(':') ? 'v6' : 'v4');
                const category = `${type}/${family}`;
                if (seenCategories.has(category)) return false;
                seenCategories.add(category);
                return true;
            }
            return true;
        });
        return minified.join('\r\n');
    }

    /**
     * Encodes a signaling payload (JSON string or object) into the most
     * compact transferable string available. Prefers binary template packing
     * (see sdp-codec.js, ~130-180 chars); falls back to legacy deflate+base64url
     * if the SDP has a shape the packer doesn't understand.
     */
    static async encodePayload(payload) {
        const obj = typeof payload === 'string' ? JSON.parse(payload) : payload;
        try {
            return SDPCodec.pack(obj);
        } catch (e) {
            // Unexpected SDP shape — legacy deflate still works, just bigger.
            return await ConnectionUtils.compressData(
                typeof payload === 'string' ? payload : JSON.stringify(payload)
            );
        }
    }

    /**
     * Decodes a transferable string back into a validated payload object.
     * Accepts both the packed format ("1.<base64url>") and the legacy
     * deflate+base64url format.
     */
    static async decodePayload(str) {
        let obj;
        if (SDPCodec.isPacked(str)) {
            obj = SDPCodec.unpack(str);
        } else {
            const decompressed = await ConnectionUtils.decompressData(str);
            obj = JSON.parse(decompressed);
        }
        return ConnectionUtils.validatePayload(obj);
    }

    /**
     * Validates that a signaling payload has the expected structure before
     * passing it to WebRTC internals. Throws a descriptive Error on failure.
     * @param {*} data - The deserialized payload object.
     * @param {string[]} [requiredFields=['peerId','sessionDesc']] - Fields that must be present.
     * @returns {object} The validated data object (pass-through).
     */
    static validatePayload(data, requiredFields = ['peerId', 'sessionDesc']) {
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            throw new Error('Invalid payload: expected a plain object');
        }
        for (const field of requiredFields) {
            if (!(field in data)) {
                throw new Error(`Invalid payload: missing required field "${field}"`);
            }
        }
        if (data.sessionDesc && (typeof data.sessionDesc.type !== 'string' || typeof data.sessionDesc.sdp !== 'string')) {
            throw new Error('Invalid payload: sessionDesc must have string fields "type" and "sdp"');
        }
        return data;
    }
}

// ==========================================
// Persistent device identity (v1.8)
// ==========================================
// One ECDSA certificate per browser profile, stored in IndexedDB and passed
// to every RTCPeerConnection, so this device's DTLS fingerprint is STABLE
// across page loads. What that buys:
//   - peers can RECORD the fingerprint per known device and notice when it
//     changes (see the launcher's identity pinning),
//   - reconnect payloads can eventually omit/abbreviate the fingerprint for
//     known pairs (~60-char codes), and
//   - the future rendezvous layer gets a stable identity to bind to.
// Browsers cap certificate lifetime (~30 days), so the fingerprint rotates
// on that cadence — treat a changed fingerprint as "notify and re-record on
// a manual ceremony", never as a silent hard-fail. Storage failures (private
// browsing, etc.) fall back to a normal ephemeral certificate.

const IDENTITY_DB = 'qrp2p-identity';
const IDENTITY_STORE = 'identity';

function identityDbOpen() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDENTITY_DB, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(IDENTITY_STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function identityDbGet(key) {
    const db = await identityDbOpen();
    try {
        return await new Promise((resolve, reject) => {
            const req = db.transaction(IDENTITY_STORE, 'readonly').objectStore(IDENTITY_STORE).get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    } finally { db.close(); }
}

async function identityDbPut(key, value) {
    const db = await identityDbOpen();
    try {
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(IDENTITY_STORE, 'readwrite');
            tx.objectStore(IDENTITY_STORE).put(value, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } finally { db.close(); }
}

// ==========================================
// CORE: WebRTC Manager
// ==========================================
//
// RESILIENCE (v1.7): a link is not torn down the moment it wobbles.
//
//   new → checking → finalizing → connected ⇄ interrupted → disconnected
//                                                            (terminal)
//
// 'interrupted' means "the session is alive, the path is being repaired":
// ICE went disconnected/failed, or the peer stopped answering heartbeats
// (typically a phone that switched apps or got a notification). While
// interrupted, outbound app messages are QUEUED (per-link outbox) and
// replayed on recovery; inbound duplicates are dropped by sequence number,
// so apps see exactly-once delivery across a blip. Only after
// `interruptedGraceMs` with no recovery does the link become 'disconnected'
// and the peer entry is dropped.
//
// Repair machinery, in escalation order:
//   1. ICE self-healing — 'disconnected' usually recovers on its own once
//      the suspended tab wakes; we simply wait instead of destroying state.
//   2. Heartbeat (ping/pong control frames) — detects a stalled peer faster
//      than ICE, proves recovery the moment any frame arrives, and keeps
//      NAT bindings warm. Paused while OUR tab is hidden so a backgrounded
//      device never misjudges its peers.
//   3. Wake probe — on visibilitychange→visible we ping immediately and mark
//      the link interrupted if nothing answers, instead of waiting for ICE.
//   4. In-band ICE restart — after the first ceremony the DATA CHANNEL is the
//      signaling channel. restartIce() offers travel as control frames using
//      the perfect-negotiation pattern (the JOINER side is polite), so
//      network changes heal without a new QR/link ceremony. Frames queue in
//      SCTP while the path is down and deliver the moment it revives.
//
// Control frames ride the data channel as JSON with a `__p2pc` discriminator:
//   {__p2pc:'ping'|'pong', t}  {__p2pc:'ack', upTo}  {__p2pc:'resync', have}
//   {__p2pc:'signal', desc|cand}
// SECURITY INVARIANTS: control frames are only ever honored from the direct
// link they arrived on and are NEVER relayed by the host; applications cannot
// forge them (app payloads are always wrapped under the `text` key by
// send()/broadcast()); 'signal' payloads are shape-validated before touching
// any RTCPeerConnection API. Renegotiation grants a peer nothing it did not
// already have — it can only renegotiate the one link it is an endpoint of.
//
// TARGETED SENDS (v1.11): sendTo(peerId, text) is the public single-link
// send. App frames may carry `noRelay: true` — the host's relay loop skips
// such frames, so a targeted frame sent to the host is never fanned out to
// the other clients. Targeted frames ride the same per-link outbox (and the
// session stash of a dead-but-repairing link), so exactly-once replay across
// blips and rendezvous repairs applies to them unchanged. The transport
// knows nothing about WHO a target is beyond its transient peerId — any
// higher-level addressing (stable device identity) lives in the layer above.
//
// PARTIES (v1.13): links group into disjoint local "parties" — one
// ceremony-star each. The node's role is PER-PARTY ('leader' fans app frames
// between that party's links; 'member' holds one link to its leader),
// replacing the node-global isHost/relay pair, so one node can lead a party
// while being a member of others (and hold utility links that relay
// nothing). Party ids are LOCAL-ONLY and never travel on the wire: a frame's
// party is the party of the link it arrived on, which is what keeps relay —
// and the forged-`relayed` strip — from ever crossing party boundaries.
// `isHost` survives as a deprecated single-party mirror for legacy
// party-less callers (createOffer()/createAnswer() with no party opts) and
// hand-rolled embedder state; nothing inside this class keys behavior on it
// except as a fallback for links that carry no partyId.
export class PeerManager extends EventTarget {
    constructor(options = {}) {
        super();
        this.peers = new Map();
        this.isHost = false;
        // partyId → { role: 'leader' | 'member' }. Ids come from generateId()
        // and exist only in this node's RAM (see the PARTIES class comment).
        this.parties = new Map();
        // The party legacy party-less entry points operate on — the v1.12
        // single-party world reduces to "the default party is the only one".
        this.defaultPartyId = null;
        this.myId = this.generateId();

        // Configuration options
        this.options = {
            allowLocalCandidates: options.allowLocalCandidates !== false,
            allowIPv6Candidates: options.allowIPv6Candidates !== false,
            connectionTimeoutMs: options.connectionTimeoutMs || 300000, // 5 minutes default
            // 'anywhere' = public STUN (no data/signaling transits it, it only
            //              reflects your public IP; enables cross-network play).
            // 'local'    = zero ICE servers; nothing external is ever contacted;
            //              connections work on the same LAN only.
            iceMode: options.iceMode === 'local' ? 'local' : 'anywhere',
            // Custom ICE servers (RTCIceServer[]: {urls, username?, credential?}).
            // Replaces the built-in public STUN list when non-empty — the only
            // way to get TURN. Ignored entirely in 'local' mode. Validation is
            // the caller's job (see arcade-p2p.js's iceServersConfig).
            iceServers: Array.isArray(options.iceServers) ? options.iceServers : null,
            // Resilience tuning (v1.7) — see the class comment.
            heartbeatIntervalMs: options.heartbeatIntervalMs || 5000,
            heartbeatTimeoutMs: options.heartbeatTimeoutMs || 12000,
            // Generous by default: an interrupted peer costs one idle
            // RTCPeerConnection, and a phone can easily sit suspended for
            // minutes before its player returns. UIs get 'interrupted' and can
            // offer a "give up" action (disconnectPeer) long before this fires.
            interruptedGraceMs: options.interruptedGraceMs || 300000,
            wakeProbeTimeoutMs: options.wakeProbeTimeoutMs || 3000,
            outboxLimit: options.outboxLimit || 1000,
            // Largest single app frame accepted off a link (measured as wire
            // string length). Bounds the host relay's per-frame fan-out to the
            // other N-1 clients — an amplification vector otherwise. Generous:
            // real game-state frames sit far below this; big transfers go
            // through the SDK's chunked sendBlob path, not send().
            maxAppFrameBytes: options.maxAppFrameBytes || 256 * 1024,
            // A stashed dead session is only resumable for this long. Beyond it
            // the buffered outbox is stale and the entry is discarded rather
            // than replayed. Generous enough for a same-day rendezvous resume.
            maxStashAgeMs: options.maxStashAgeMs || 12 * 3600 * 1000,
            // Stable DTLS identity across sessions (v1.8) — see the identity
            // section above. Opt out with persistentIdentity: false.
            persistentIdentity: options.persistentIdentity !== false
        };
        this._certificate = null;
        this._certPromise = null;

        // Sessions of terminally-dead links, kept so a later reconnect (e.g.
        // the rendezvous layer) can resume seq counters and replay the outbox
        // as if the link had merely been interrupted. Bounded LRU.
        this.sessionStash = new Map(); // peerId → {type, outSeq, lastInSeq, outbox, outboxOverflowed, stashedAt}

        this._onVisibility = () => {
            if (!document.hidden) this._onWake();
        };
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', this._onVisibility);
        }
    }

    generateId() {
        // Unguessable link identity. The session stash (outbox + seq counters)
        // is keyed by peerId, so a guessable id would let a peer that learns/
        // brute-forces one resume — and inherit the buffered outbox of — a
        // session that isn't theirs. 96 bits from a CSPRNG closes that.
        const g = (typeof crypto !== 'undefined' && crypto.getRandomValues) ? crypto : null;
        if (g) {
            const bytes = new Uint8Array(12);
            g.getRandomValues(bytes);
            let s = '';
            for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(36).padStart(2, '0');
            return s;
        }
        // Non-crypto environment (should not occur in a browser): fall back to
        // a doubled Math.random id — weaker, but never worse than the prior one.
        return Math.random().toString(36).substring(2, 9) + Math.random().toString(36).substring(2, 9);
    }

    /**
     * Loads (or mints) this device's persistent certificate so every
     * connection presents the same DTLS fingerprint. Resolves to null when
     * disabled or unavailable — connections then use a normal ephemeral cert.
     * Regenerates ahead of expiry: browsers cap certificate lifetime (~30
     * days), so fingerprint rotation on that cadence is expected and pinning
     * layers must treat it as notify-and-re-record, not as an attack.
     */
    async _ensureCertificate() {
        if (!this.options.persistentIdentity ||
            typeof RTCPeerConnection.generateCertificate !== 'function') return null;
        if (!this._certPromise) {
            this._certPromise = (async () => {
                try {
                    let cert = await identityDbGet('certificate');
                    if (!cert || !cert.expires || cert.expires < Date.now() + 24 * 3600 * 1000) {
                        cert = await RTCPeerConnection.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256' });
                        await identityDbPut('certificate', cert);
                        this.dispatchEvent(new CustomEvent('diagnostic', { detail: {
                            type: 'sys', msg: 'New device identity certificate generated (previous one missing or near expiry).'
                        }}));
                    }
                    this._certificate = cert;
                    return cert;
                } catch (e) {
                    this.dispatchEvent(new CustomEvent('diagnostic', { detail: {
                        type: 'warn', msg: `Persistent identity unavailable (${e.message}) — using an ephemeral certificate this session.`
                    }}));
                    this._certificate = null;
                    return null;
                }
            })();
        }
        return this._certPromise;
    }

    /** DTLS fingerprint value from an SDP string (uppercase hex:hex:…), or null. */
    static extractFingerprint(sdp) {
        const m = /a=fingerprint:\S+\s+([0-9A-Fa-f:]+)/.exec(sdp || '');
        return m ? m[1].toUpperCase() : null;
    }

    /**
     * The REMOTE device's DTLS fingerprint on one link — its transferable
     * identity. Stable across sessions when the peer runs with
     * persistentIdentity (rotates with its ~monthly certificate renewal).
     */
    getPeerFingerprint(peerId) {
        const peerData = this.peers.get(peerId);
        const desc = peerData && peerData.connection.remoteDescription;
        return desc ? PeerManager.extractFingerprint(desc.sdp) : null;
    }

    _buildRtcConfig() {
        const custom = this.options.iceServers;
        const rtcConfig = this.options.iceMode === 'local'
            ? { iceServers: [] }
            : { iceServers: (custom && custom.length) ? custom : STUN_SERVERS.iceServers };
        if (this._certificate) rtcConfig.certificates = [this._certificate];
        return rtcConfig;
    }

    _sessionSnapshot(peerData) {
        const desc = peerData.connection && peerData.connection.remoteDescription;
        return {
            type: peerData.type,
            partyId: peerData.partyId || null,
            outSeq: peerData.outSeq,
            lastInSeq: peerData.lastInSeq,
            outbox: peerData.outbox,
            outboxOverflowed: peerData.outboxOverflowed,
            stashedAt: Date.now(),
            // The remote device's DTLS fingerprint at the time we stashed. On
            // resume we require the reconnected link to present the same one —
            // the outbox is only replayed to the identity it was queued for.
            peerFingerprint: desc ? PeerManager.extractFingerprint(desc.sdp) : null
        };
    }

    /**
     * Decides whether a stashed/live session may be inherited by a reconnecting
     * link. Refuses (returns false → fresh session) when the stash has aged out,
     * or when both sides present a DTLS fingerprint and they disagree — the
     * latter means the reconnected link belongs to a different device than the
     * one whose outbox was buffered, so replaying it would leak queued frames.
     * Absent fingerprints (e.g. before a remote description is set) can't prove
     * a mismatch, so they're allowed: this gate only rejects on positive
     * evidence, never on ignorance.
     */
    _sessionResumable(inherited, adoptConnection) {
        if (!inherited) return false;
        if (typeof inherited.stashedAt === 'number' &&
            Date.now() - inherited.stashedAt > this.options.maxStashAgeMs) {
            this.dispatchEvent(new CustomEvent('diagnostic', { detail: {
                type: 'warn', msg: 'A stashed session aged out before reconnect — starting a fresh session instead of replaying stale buffered messages.'
            }}));
            return false;
        }
        const desc = adoptConnection && adoptConnection.remoteDescription;
        const newFp = desc ? PeerManager.extractFingerprint(desc.sdp) : null;
        if (inherited.peerFingerprint && newFp && inherited.peerFingerprint !== newFp) {
            this.dispatchEvent(new CustomEvent('diagnostic', { detail: {
                type: 'warn', msg: 'Reconnected link presents a different device fingerprint than the stashed session — refusing to replay its buffered outbox (fresh session instead).'
            }}));
            return false;
        }
        return true;
    }

    initPeer(peerId, type, opts = {}) {
        // With preserveSession, the reliability state (seq counters + unacked
        // outbox) carries over from a live entry or the stash, so the resync
        // exchange on channel-open replays anything the peer missed.
        let inherited = null;
        let priorPartyId = null;
        if(this.peers.has(peerId)) {
            const existing = this.peers.get(peerId);
            priorPartyId = existing.partyId || null;
            if (opts.preserveSession) inherited = this._sessionSnapshot(existing);
            this._clearPeerTimers(existing);
            existing._tearingDown = true;
            existing.connection.onicecandidate = null;
            existing.connection.close();
            this.peers.delete(peerId);
        } else if (opts.preserveSession && this.sessionStash.has(peerId)) {
            inherited = this.sessionStash.get(peerId);
            priorPartyId = inherited.partyId || null;
            this.sessionStash.delete(peerId);
        }
        // Only resume a session onto a link that proves it's the same remote
        // device (fingerprint) and hasn't gone stale — otherwise drop it and
        // start fresh, so a mis-keyed or hijacked reconnect can't inherit
        // another session's buffered outbox.
        if (inherited && !this._sessionResumable(inherited, opts.adoptConnection)) {
            inherited = null;
        }

        // opts.adoptConnection: install an externally-prepared connection
        // (rendezvous shadow) instead of minting one — all handlers below
        // attach to it exactly as they would to a fresh connection.
        const peerConnection = opts.adoptConnection || new RTCPeerConnection(this._buildRtcConfig());
        const peerData = {
            connection: peerConnection,
            dataChannel: null,
            status: 'new',
            type: type,
            // A repaired link rejoins the party its session belonged to; a
            // fresh link takes the ceremony's party. null only for
            // hand-rolled legacy state (see the PARTIES class comment).
            partyId: (inherited && inherited.partyId) || opts.partyId || null,
            // Resilience state (v1.7) — see the class comment.
            polite: type === 'host',   // the JOINER defers during offer glare
            canRenegotiate: false,     // true once the data channel first opens
            everConnected: false,
            makingOffer: false,
            ignoreOffer: false,
            lastAliveAt: 0,
            outSeq: 0,                 // last app seq we assigned on this link
            lastInSeq: 0,              // last app seq we delivered from this link
            outbox: [],                // unacked {seq, wire} awaiting replay
            outboxOverflowed: false,
            resyncFlushed: false,      // sends transmit only after the peer's resync is processed
            resyncTimer: null,
            heartbeatTimer: null,
            graceTimer: null,
            restartTimer: null,
            wakeProbeTimer: null,
            _tearingDown: false
        };
        if (inherited) {
            peerData.outSeq = inherited.outSeq;
            peerData.lastInSeq = inherited.lastInSeq;
            peerData.outbox = inherited.outbox;
            peerData.outboxOverflowed = !!inherited.outboxOverflowed;
        }
        this.peers.set(peerId, peerData);
        // Replacing a link can strand its old party (e.g. a stale stash whose
        // session was refused resumption into a different ceremony).
        if (priorPartyId && priorPartyId !== peerData.partyId) this._gcParty(priorPartyId);

        peerConnection.oniceconnectionstatechange = () => {
            const pd = this.peers.get(peerId);
            if (!pd || pd.connection !== peerConnection) return; // stale/replaced link
            const iceState = peerConnection.iceConnectionState;

            if (iceState === 'failed' || iceState === 'disconnected') {
                this._onLinkTrouble(peerId, iceState);
                return;
            }
            // FIELD-TEST LESSON (2026-07-04): ICE can reach 'connected' on the
            // JOINER before the host has even received the answer — the host's
            // ICE agent answers connectivity checks pre-answer. Reporting that
            // as "connected" hid the answer QR mid-ceremony and stranded the
            // host. App-level 'connected' therefore requires the DATA CHANNEL
            // to be open; until then ICE-connected surfaces as 'finalizing'.
            if (iceState === 'connected' || iceState === 'completed') {
                const channelOpen = pd.dataChannel && pd.dataChannel.readyState === 'open';
                if (channelOpen) {
                    this._markConnected(peerId);
                } else {
                    this._setStatus(peerId, pd, 'finalizing');
                    if (!pd._finalizingLogged) {
                        pd._finalizingLogged = true;
                        this.dispatchEvent(new CustomEvent('diagnostic', { detail: {
                            type: 'info',
                            msg: `Network path to ${peerId} established — waiting for the secure channel. If you are the JOINER, the host still needs your answer (reply link or QR).`
                        }}));
                    }
                }
                return;
            }
            this._setStatus(peerId, pd, iceState);
        };

        peerConnection.onicecandidate = (event) => {
            const pd = this.peers.get(peerId);
            if (event.candidate) {
                const cstr = event.candidate.candidate;
                let typeMatch = cstr.match(/typ (\w+)/);
                let candType = typeMatch ? typeMatch[1] : 'unknown';
                let outStr = `[${candType.toUpperCase()}] ${event.candidate.address}:${event.candidate.port}`;
                this.dispatchEvent(new CustomEvent('diagnostic', {
                    detail: { type: 'ice', msg: `[Peer ${peerId}] ${outStr}` }
                }));
                // Post-ceremony candidates (ICE restart) trickle in-band; the
                // initial ceremony ships them inside the QR/link SDP instead.
                if (pd && pd.canRenegotiate && pd.connection === peerConnection) {
                    this._sendSignal(peerId, { cand: event.candidate.toJSON ? event.candidate.toJSON() : {
                        candidate: event.candidate.candidate,
                        sdpMid: event.candidate.sdpMid,
                        sdpMLineIndex: event.candidate.sdpMLineIndex,
                        usernameFragment: event.candidate.usernameFragment
                    }});
                }
            } else {
                this.dispatchEvent(new CustomEvent('diagnostic', {
                    detail: { type: 'sys', msg: `ICE Gathering Complete for ${peerId}.` }
                }));
            }
        };

        // Fires when restartIce() (or any renegotiation) needs a fresh offer.
        // Inert during the initial ceremony, which is driven manually by
        // createOffer/createAnswer.
        peerConnection.onnegotiationneeded = async () => {
            const pd = this.peers.get(peerId);
            if (!pd || pd.connection !== peerConnection || !pd.canRenegotiate) return;
            try {
                pd.makingOffer = true;
                await peerConnection.setLocalDescription();
                this._sendSignal(peerId, { desc: {
                    type: peerConnection.localDescription.type,
                    sdp: peerConnection.localDescription.sdp
                }});
            } catch (e) {
                this.dispatchEvent(new CustomEvent('diagnostic', { detail: { type: 'error', msg: `Renegotiation offer failed: ${e.message}` }}));
            } finally {
                pd.makingOffer = false;
            }
        };

        peerConnection.ondatachannel = (event) => {
            this.dispatchEvent(new CustomEvent('diagnostic', { detail: { type: 'sys', msg: `Data channel inbound from ${peerId}.` }}));
            this.setupDataChannel(peerId, event.channel);
        };

        return peerData;
    }

    setupDataChannel(peerId, channel) {
        const peerData = this.peers.get(peerId);
        if(!peerData) return;

        peerData.dataChannel = channel;
        peerData.dataChannel.onopen = () => {
            // The data channel opening is the ONLY thing that means "connected".
            peerData.canRenegotiate = true;
            peerData.lastAliveAt = Date.now();
            this._startHeartbeat(peerId);
            // Tell the peer the last app seq we delivered so it can replay
            // anything we missed while the link was down (no-op on first open).
            // Until THEIR resync arrives, our new sends only queue — a fresh
            // frame transmitted ahead of the replay would advance the peer's
            // cumulative dedup counter past the gap and the replayed frames
            // would be dropped as duplicates. Strict per-link order or nothing.
            peerData.resyncFlushed = false;
            this._sendControl(peerId, { __p2pc: 'resync', have: peerData.lastInSeq });
            peerData.resyncTimer = setTimeout(() => this._flushOutbox(peerId), 2500); // pre-v1.7 peers never send one
            this._markConnected(peerId);
            this.dispatchEvent(new CustomEvent('chatState', { detail: { peerId, ready: true } }));
            this.dispatchEvent(new CustomEvent('diagnostic', { detail: { type: 'success', msg: `Data channel OPEN with ${peerId}!` }}));
        };
        peerData.dataChannel.onclose = () => {
            if (peerData._tearingDown) return;
            // A closed channel is unrecoverable in-band — it WAS our signaling
            // path. Recovery from here is a fresh ceremony.
            this._teardownPeer(peerId, 'disconnected');
        };
        peerData.dataChannel.onmessage = (event) => {
            this._onChannelMessage(peerId, event.data);
        };
    }

    _onChannelMessage(peerId, raw) {
        const peerData = this.peers.get(peerId);
        if (!peerData) return;
        peerData.lastAliveAt = Date.now();
        // Any inbound frame proves the path works again.
        if (peerData.status === 'interrupted') this._markConnected(peerId);

        let parsed = null;
        try { parsed = JSON.parse(raw); } catch(e) {}

        if (parsed && typeof parsed === 'object' && parsed.__p2pc) {
            this._handleControl(peerId, parsed);
            return;
        }

        // Cap app-frame size before it can be relayed to the other N-1 clients
        // or dispatched locally. One client sending a multi-megabyte frame would
        // otherwise be fanned out by the host as an amplification vector; real
        // frames are small (large transfers use the SDK's chunked sendBlob).
        // Dropped without an ack so we never pretend to have delivered it — the
        // sender's own outbox cap bounds any retry.
        if (raw.length > this.options.maxAppFrameBytes) {
            this.dispatchEvent(new CustomEvent('diagnostic', { detail: {
                type: 'warn', msg: `Dropped an oversized app frame from ${peerId} (${raw.length} > ${this.options.maxAppFrameBytes} bytes).`
            }}));
            return;
        }

        const msg = (parsed && typeof parsed === 'object') ? parsed : { text: raw, from: peerId }; // legacy string fallback

        // Relay authority is PER-PARTY (v1.13): it comes from the ARRIVAL
        // LINK's party, never from a node-global flag — a node that leads
        // party A while a member of party B relays frames arriving on A's
        // links and treats frames arriving on B's hub link like any joiner.
        // Links without a party (hand-rolled legacy state) fall back to the
        // deprecated isHost mirror.
        const arrivalPartyId = peerData.partyId || null;
        const leadsArrivalParty = arrivalPartyId
            ? this.partyRole(arrivalPartyId) === 'leader'
            : this.isHost;

        // The party's leader is the ONLY node that stamps `relayed` — every
        // frame the leader receives arrived on a direct link from its origin,
        // so an inbound relayed:true on a link we lead is always forged.
        // Strip it before it can reach the relay loop or local dispatch (a
        // sender could otherwise launder its frames into "arrived through the
        // hub" and defeat relay-tag attribution in the layer above).
        if (leadsArrivalParty && msg.relayed) delete msg.relayed;

        // Reliability: dedup by link sequence, acknowledge what we've seen.
        if (typeof msg.seq === 'number') {
            if (msg.seq <= peerData.lastInSeq) {
                // Duplicate from a replay — re-ack so the sender prunes it.
                this._sendControl(peerId, { __p2pc: 'ack', upTo: peerData.lastInSeq });
                return;
            }
            peerData.lastInSeq = msg.seq;
            this._sendControl(peerId, { __p2pc: 'ack', upTo: msg.seq });
        }

        // The leader relays APP messages between its party's spokes — each
        // destination link gets its own reliability sequence, and the relay
        // marks the frame so receivers know it did NOT originate from their
        // direct link partner (identity/fingerprint claims must never bind
        // through a relay). The leader always stamps relayed:true itself, so
        // a sender cannot launder a relayed frame into looking direct.
        //
        // `from` is stamped with the source LINK's peerId — the leader-assigned
        // identifier of the data channel this frame actually arrived on — NOT
        // the sender-supplied `msg.from`. A client controls its own `msg.from`,
        // so relaying it verbatim would let any joiner post a message that the
        // other peers attribute to a different peer. peerId cannot be forged:
        // it is the key under which this inbound channel is registered.
        // (Inbound frames are always from a remote client, never the leader, so
        // there is no leader-origin frame to exclude here.)
        //
        // Frames marked `noRelay` are targeted (v1.11) — the sender aimed
        // them at this device alone, so the hub must not fan them out.
        //
        // A frame is NEVER relayed across parties (v1.13): only links and
        // stashes of the arrival link's own party receive the fan-out.
        if (leadsArrivalParty && !msg.noRelay) {
            const relayFrame = { text: msg.text, from: peerId, relayed: true };
            this.peers.forEach((destData, destId) => {
                if (destId === peerId) return;
                if ((destData.partyId || null) !== arrivalPartyId) return;
                this._sendAppTo(destId, relayFrame);
            });
            // A joiner whose link is terminally dead and mid-rendezvous-adoption
            // is not in `peers` — mirror broadcast()'s stash handling so the
            // frames other joiners send during the repair window replay on
            // adoption, keeping the exactly-once guarantee that direct traffic
            // has (otherwise these frames live in no outbox and are lost).
            // Same-party stashes only: a repairing seat of ANOTHER party must
            // never inherit this party's frames.
            this.sessionStash.forEach((stash, destId) => {
                if (destId === peerId) return;
                if ((stash.partyId || null) !== arrivalPartyId) return;
                this._stashAppend(stash, relayFrame);
            });
        }

        // Destructure only the expected fields to avoid merging arbitrary keys
        const { text, from, relayed } = msg;
        this.dispatchEvent(new CustomEvent('message', {
            detail: { text, from, relayed: !!relayed, incoming: true, peerId }
        }));
    }

    // Validates a peer-supplied ack/resync sequence number: it must be a
    // non-negative integer, clamped to the highest seq we've actually assigned
    // on this link. Returns the clamped value, or null when unusable.
    _clampSeq(n, outSeq) {
        if (!Number.isInteger(n) || n < 0) return null;
        return Math.min(n, outSeq);
    }

    _handleControl(peerId, msg) {
        const peerData = this.peers.get(peerId);
        if (!peerData) return;
        switch (msg.__p2pc) {
            case 'ping':
                this._sendControl(peerId, { __p2pc: 'pong', t: msg.t });
                break;
            case 'pong':
                break; // lastAliveAt already refreshed in _onChannelMessage
            case 'ack': {
                // Validate + clamp to what we've actually assigned. The bare
                // `typeof === 'number'` guard let NaN through (NaN is a number),
                // and `filter(e => e.seq > NaN)` is always false — silently
                // wiping the outbox and defeating replay. Clamping also caps a
                // huge value at outSeq: a peer can only ack seqs we sent.
                const upTo = this._clampSeq(msg.upTo, peerData.outSeq);
                if (upTo !== null) {
                    peerData.outbox = peerData.outbox.filter(e => e.seq > upTo);
                }
                break;
            }
            case 'resync': {
                const have = this._clampSeq(msg.have, peerData.outSeq);
                if (have === null) break;
                peerData.outbox = peerData.outbox.filter(e => e.seq > have);
                this._flushOutbox(peerId);
                break;
            }
            case 'signal':
                this._handleSignal(peerId, msg);
                break;
            case 'ext':
                // Namespaced extension frames for optional layers (rendezvous
                // pairing, future capabilities). Same trust as all control
                // frames: direct link only, never relayed.
                if (typeof msg.ns === 'string') {
                    this.dispatchEvent(new CustomEvent('control-ext', { detail: { peerId, ns: msg.ns, data: msg.data } }));
                }
                break;
        }
    }

    /**
     * Perfect negotiation over the data channel (in-band ICE restart). The
     * polite side (joiner) rolls back on glare; the impolite side (host)
     * ignores colliding offers. Payloads are shape-validated first — a peer
     * can only ever renegotiate the single link it is an endpoint of.
     */
    async _handleSignal(peerId, msg) {
        const peerData = this.peers.get(peerId);
        if (!peerData) return;
        const pc = peerData.connection;
        try {
            if (msg.desc) {
                const d = msg.desc;
                if ((d.type !== 'offer' && d.type !== 'answer') || typeof d.sdp !== 'string') {
                    throw new Error('malformed session description');
                }
                const collision = d.type === 'offer' && (peerData.makingOffer || pc.signalingState !== 'stable');
                peerData.ignoreOffer = !peerData.polite && collision;
                if (peerData.ignoreOffer) {
                    this.dispatchEvent(new CustomEvent('diagnostic', { detail: { type: 'sys', msg: `Renegotiation glare with ${peerId} — offer ignored (impolite side).` }}));
                    return;
                }
                await pc.setRemoteDescription(d); // implicit rollback on the polite side
                if (d.type === 'offer') {
                    await pc.setLocalDescription();
                    this._sendSignal(peerId, { desc: {
                        type: pc.localDescription.type,
                        sdp: pc.localDescription.sdp
                    }});
                }
            } else if (msg.cand) {
                if (typeof msg.cand !== 'object' || typeof msg.cand.candidate !== 'string') {
                    throw new Error('malformed ICE candidate');
                }
                try {
                    await pc.addIceCandidate(msg.cand);
                } catch (e) {
                    if (!peerData.ignoreOffer) throw e; // candidates for an ignored offer are expected noise
                }
            }
        } catch (e) {
            this.dispatchEvent(new CustomEvent('diagnostic', { detail: { type: 'error', msg: `In-band renegotiation error with ${peerId}: ${e.message}` }}));
        }
    }

    _sendSignal(peerId, fields) {
        this._sendControl(peerId, Object.assign({ __p2pc: 'signal' }, fields));
    }

    _sendControl(peerId, obj) {
        const peerData = this.peers.get(peerId);
        if (!peerData || !peerData.dataChannel || peerData.dataChannel.readyState !== 'open') return false;
        try {
            peerData.dataChannel.send(JSON.stringify(obj));
            return true;
        } catch (e) {
            return false;
        }
    }

    /**
     * Sends an app message ({text, from}) on one link with a fresh sequence
     * number, buffering it for replay until acked. While the link is
     * 'interrupted' the message is queued (and SCTP itself buffers anything
     * already in flight), so a suspended peer misses nothing.
     * Returns true if the message was sent or queued on a live link.
     */
    // Serializes an app frame for the wire. Whitelist, not passthrough:
    // only the fields every peer understands may travel, so a sender cannot
    // smuggle arbitrary keys into another peer's message handler.
    _appWire(msg, seq) {
        const frame = { text: msg.text, from: msg.from, seq };
        if (msg.relayed) frame.relayed = true;
        if (msg.noRelay) frame.noRelay = true;
        return JSON.stringify(frame);
    }

    // Appends an app frame to a stashed (dead-but-repairing) session's
    // outbox so the post-adoption resync replays it. Same cap as live links.
    _stashAppend(stash, msg) {
        const seq = ++stash.outSeq;
        stash.outbox.push({ seq, wire: this._appWire(msg, seq) });
        if (stash.outbox.length > this.options.outboxLimit) {
            stash.outbox.splice(0, stash.outbox.length - this.options.outboxLimit);
        }
    }

    _sendAppTo(peerId, msg) {
        const peerData = this.peers.get(peerId);
        if (!peerData) return false;
        const open = peerData.dataChannel && peerData.dataChannel.readyState === 'open';
        if (!open && peerData.status !== 'interrupted') return false;

        const seq = ++peerData.outSeq;
        const wire = this._appWire(msg, seq);
        peerData.outbox.push({ seq, wire });
        if (peerData.outbox.length > this.options.outboxLimit) {
            peerData.outbox.splice(0, peerData.outbox.length - this.options.outboxLimit);
            if (!peerData.outboxOverflowed) {
                peerData.outboxOverflowed = true;
                this.dispatchEvent(new CustomEvent('diagnostic', { detail: {
                    type: 'warn', msg: `Outbox overflow for ${peerId} — oldest unacknowledged messages dropped. High-rate games should resync their own state after recovery.`
                }}));
            }
        }
        if (open && peerData.resyncFlushed) {
            try { peerData.dataChannel.send(wire); } catch(e) { /* stays queued for resync */ }
        }
        // Not yet flushed: the frame waits in the outbox so the post-resync
        // flush transmits everything in strict seq order.
        return true;
    }

    /**
     * Transmits the (pruned) outbox in seq order and opens the gate for
     * immediate sends. Runs when the peer's resync arrives, or after a grace
     * for pre-v1.7 peers that will never send one.
     */
    _flushOutbox(peerId) {
        const peerData = this.peers.get(peerId);
        if (!peerData) return;
        if (peerData.resyncTimer) { clearTimeout(peerData.resyncTimer); peerData.resyncTimer = null; }
        peerData.resyncFlushed = true;
        if (!peerData.dataChannel || peerData.dataChannel.readyState !== 'open') return;
        if (peerData.outbox.length) {
            this.dispatchEvent(new CustomEvent('diagnostic', { detail: {
                type: 'sys', msg: `Replaying ${peerData.outbox.length} buffered message(s) to ${peerId}.`
            }}));
            for (const entry of peerData.outbox) {
                try { peerData.dataChannel.send(entry.wire); } catch(e) { break; }
            }
        }
    }

    broadcast(message, excludePeerId = null, opts = {}) {
        // Accepts {text, from} or a pre-stringified JSON of one.
        let msg = message;
        if (typeof message === 'string') {
            try { msg = JSON.parse(message); } catch(e) { msg = null; }
            if (!msg || typeof msg !== 'object') msg = { text: message, from: this.myId };
        }
        // opts.partyId scopes the fan-out to one party's links and stashes
        // (v1.13). Omitted → every link, exactly the pre-party behavior —
        // right for device-level traffic (identity announce), wrong for
        // game traffic on a multi-party node, whose layer passes the party.
        const partyFilter = opts.partyId !== undefined ? (opts.partyId || null) : undefined;
        let sent = false;
        this.peers.forEach((peerData, pId) => {
            if (pId === excludePeerId) return;
            if (partyFilter !== undefined && (peerData.partyId || null) !== partyFilter) return;
            if (this._sendAppTo(pId, msg)) sent = true;
        });
        // Terminally-dead sessions awaiting adoption (rendezvous repair) keep
        // accepting sends into their stashed outbox — the resync on the
        // reconnected channel replays them, so a repair-in-progress loses
        // nothing. Bounded by the same outbox cap.
        this.sessionStash.forEach((stash, pId) => {
            if (pId === excludePeerId) return;
            if (partyFilter !== undefined && (stash.partyId || null) !== partyFilter) return;
            this._stashAppend(stash, msg);
            sent = true;
        });
        return sent;
    }

    /**
     * Public single-link send (v1.11). Wraps `text` like send() but delivers
     * to ONE peer, with the frame marked `noRelay` (default) so a receiving
     * host never fans it out. Rides the same per-link outbox as broadcast —
     * queued while 'interrupted', appended to the session stash while a
     * dead link awaits rendezvous adoption — so replay is exactly-once.
     * Returns true when sent or queued, false when the peerId is unknown.
     */
    sendTo(peerId, text, { noRelay = true } = {}) {
        const msg = { text, from: this.myId };
        if (noRelay) msg.noRelay = true;
        if (this.peers.has(peerId)) return this._sendAppTo(peerId, msg);
        const stash = this.sessionStash.get(peerId);
        if (stash) {
            this._stashAppend(stash, msg);
            return true;
        }
        return false;
    }

    send(text) {
        const payload = { text, from: this.myId };
        const sent = this.broadcast(payload);

        if (sent) {
            this.dispatchEvent(new CustomEvent('message', { detail: { text, from: this.myId, incoming: false }}));
        } else {
            this.dispatchEvent(new CustomEvent('diagnostic', { detail: { type: 'error', msg: 'Cannot send, no channels open.' }}));
        }
        // True when the frame was sent or queued on at least one link — lets
        // callers that must not lose a frame (identity announce) detect the
        // no-links case instead of firing and forgetting.
        return sent;
    }

    // ---- link lifecycle (v1.7) -------------------------------------------

    _setStatus(peerId, peerData, status) {
        if (peerData.status === status) return;
        peerData.status = status;
        this.dispatchEvent(new CustomEvent('status', { detail: { peerId, status } }));
    }

    _markConnected(peerId) {
        const peerData = this.peers.get(peerId);
        if (!peerData) return;
        this._clearRecoveryTimers(peerData);
        peerData.everConnected = true;
        const wasInterrupted = peerData.status === 'interrupted';
        this._setStatus(peerId, peerData, 'connected');
        if (wasInterrupted) {
            this.dispatchEvent(new CustomEvent('diagnostic', { detail: { type: 'success', msg: `Connection to ${peerId} recovered.` }}));
        }
    }

    _onLinkTrouble(peerId, iceState) {
        const peerData = this.peers.get(peerId);
        if (!peerData) return;
        if (!peerData.canRenegotiate) {
            // Mid-ceremony trouble: there is no session to preserve and no
            // in-band signaling path — keep the historical fail-fast behavior.
            if (iceState === 'failed') {
                this._teardownPeer(peerId, 'failed');
            } else {
                this._setStatus(peerId, peerData, iceState);
            }
            return;
        }
        // 'disconnected' usually self-heals when a suspended tab wakes, so give
        // ICE a moment before restarting; 'failed' needs the restart now.
        this._scheduleRestart(peerId, iceState === 'failed' ? 0 : 3000);
        this._markInterrupted(peerId, `ICE ${iceState}`);
    }

    _markInterrupted(peerId, why) {
        const peerData = this.peers.get(peerId);
        if (!peerData || peerData._tearingDown) return;
        if (peerData.status !== 'interrupted') {
            this.dispatchEvent(new CustomEvent('diagnostic', { detail: {
                type: 'warn', msg: `Connection to ${peerId} interrupted (${why}) — holding the session and repairing.`
            }}));
        }
        this._setStatus(peerId, peerData, 'interrupted');
        if (!peerData.graceTimer) {
            peerData.graceTimer = setTimeout(() => {
                peerData.graceTimer = null;
                this._teardownPeer(peerId, 'disconnected');
            }, this.options.interruptedGraceMs);
        }
    }

    _scheduleRestart(peerId, delayMs) {
        const peerData = this.peers.get(peerId);
        if (!peerData || !peerData.canRenegotiate || peerData.restartTimer) return;
        peerData.restartTimer = setTimeout(async () => {
            peerData.restartTimer = null;
            if (!this.peers.has(peerId)) return;
            const ice = peerData.connection.iceConnectionState;
            if (ice === 'connected' || ice === 'completed' || peerData.connection.signalingState === 'closed') return;
            this.dispatchEvent(new CustomEvent('diagnostic', { detail: { type: 'sys', msg: `Attempting ICE restart for ${peerId}…` }}));
            try {
                if (typeof peerData.connection.restartIce === 'function') {
                    peerData.connection.restartIce(); // → onnegotiationneeded → in-band offer
                } else {
                    const offer = await peerData.connection.createOffer({ iceRestart: true });
                    await peerData.connection.setLocalDescription(offer);
                    this._sendSignal(peerId, { desc: {
                        type: peerData.connection.localDescription.type,
                        sdp: peerData.connection.localDescription.sdp
                    }});
                }
            } catch (e) {
                this.dispatchEvent(new CustomEvent('diagnostic', { detail: { type: 'error', msg: `ICE restart failed: ${e.message}` }}));
            }
            // Keep retrying while interrupted; the grace timer bounds this.
            this._scheduleRestart(peerId, 10000);
        }, delayMs);
    }

    _startHeartbeat(peerId) {
        const peerData = this.peers.get(peerId);
        if (!peerData) return;
        if (peerData.heartbeatTimer) clearInterval(peerData.heartbeatTimer);
        peerData.heartbeatTimer = setInterval(() => this._heartbeatTick(peerId), this.options.heartbeatIntervalMs);
    }

    _heartbeatTick(peerId) {
        const peerData = this.peers.get(peerId);
        if (!peerData) return;
        if (!peerData.dataChannel || peerData.dataChannel.readyState !== 'open') return;
        // A hidden tab has throttled timers and a paused peer is expected to
        // miss pongs — never judge liveness while WE are the backgrounded side.
        if (typeof document !== 'undefined' && document.hidden) return;
        this._sendControl(peerId, { __p2pc: 'ping', t: Date.now() });
        if (peerData.status === 'connected' &&
            Date.now() - peerData.lastAliveAt > this.options.heartbeatTimeoutMs) {
            // No ICE restart here: the path may be fine and the peer merely
            // suspended (its ICE agent still answers checks while JS sleeps).
            // Recovery is proven by the first frame that arrives.
            this._markInterrupted(peerId, 'peer unresponsive');
        }
    }

    _onWake() {
        const wokeAt = Date.now();
        let probed = 0;
        this.peers.forEach((peerData, peerId) => {
            if (!peerData.canRenegotiate) return;
            probed++;
            this._sendControl(peerId, { __p2pc: 'ping', t: wokeAt });
            if (peerData.wakeProbeTimer) clearTimeout(peerData.wakeProbeTimer);
            peerData.wakeProbeTimer = setTimeout(() => {
                peerData.wakeProbeTimer = null;
                // Identity guard, not mere membership: if this peerId was
                // replaced by a fresh link since the probe was armed, the new
                // link's own aliveness governs — don't mark it interrupted on
                // the stale entry's timestamp.
                if (this.peers.get(peerId) !== peerData) return;
                if (peerData.lastAliveAt >= wokeAt) return; // heard from them since waking
                this._markInterrupted(peerId, 'no response after waking');
            }, this.options.wakeProbeTimeoutMs);
        });
        if (probed > 0) {
            this.dispatchEvent(new CustomEvent('diagnostic', { detail: { type: 'sys', msg: `Woke from background — probing ${probed} peer link(s).` }}));
        }
    }

    _clearRecoveryTimers(peerData) {
        if (peerData.graceTimer) { clearTimeout(peerData.graceTimer); peerData.graceTimer = null; }
        if (peerData.restartTimer) { clearTimeout(peerData.restartTimer); peerData.restartTimer = null; }
        if (peerData.wakeProbeTimer) { clearTimeout(peerData.wakeProbeTimer); peerData.wakeProbeTimer = null; }
    }

    _clearPeerTimers(peerData) {
        this._clearRecoveryTimers(peerData);
        if (peerData.heartbeatTimer) { clearInterval(peerData.heartbeatTimer); peerData.heartbeatTimer = null; }
        if (peerData.resyncTimer) { clearTimeout(peerData.resyncTimer); peerData.resyncTimer = null; }
    }

    _teardownPeer(peerId, finalStatus) {
        const peerData = this.peers.get(peerId);
        if (!peerData) return;
        peerData._tearingDown = true;
        this._clearPeerTimers(peerData);
        // Keep the session so a reconnect (rendezvous or otherwise) can resume
        // it seamlessly. Bounded: drop the oldest beyond 8 entries.
        if (peerData.everConnected) {
            this.sessionStash.set(peerId, this._sessionSnapshot(peerData));
            while (this.sessionStash.size > 8) {
                const evictId = this.sessionStash.keys().next().value;
                const evicted = this.sessionStash.get(evictId);
                this.sessionStash.delete(evictId);
                if (evicted && evicted.partyId) this._gcParty(evicted.partyId);
            }
        }
        try { peerData.dataChannel?.close(); } catch(_) {}
        try {
            peerData.connection.onicecandidate = null;
            peerData.connection.close();
        } catch(_) {}
        this.peers.delete(peerId);
        // A stashed session (everConnected above) still references the party,
        // so this only collects a party whose last trace is truly gone.
        this._gcParty(peerData.partyId);
        this.dispatchEvent(new CustomEvent('chatState', { detail: { peerId, ready: false } }));
        this.dispatchEvent(new CustomEvent('status', { detail: { peerId, status: finalStatus } }));
    }

    /** Deliberately drops one link (e.g. a UI "leave game" action). */
    disconnectPeer(peerId) {
        this._teardownPeer(peerId, 'disconnected');
    }

    // ==========================================
    // READ MODEL (v1.12) — the supported way for the layers above (launcher
    // glue, ceremony UI) to observe transport state. `isHost` and the public
    // methods are API; `peers`, `sessionStash` and `options` are internal —
    // never reach into them from outside this file.
    // ==========================================

    /**
     * Connection-liveness snapshot for UI, so callers don't reach into the
     * internal `peers`/`sessionStash`/`isHost` state to derive it themselves.
     */
    statusSummary() {
        let connected = 0, interrupted = 0, finalizing = 0, pending = 0;
        this.peers.forEach((p) => {
            if (p.status === 'connected') connected++;
            else if (p.status === 'interrupted') interrupted++;
            else if (p.status === 'finalizing') finalizing++;
            else pending++;
        });
        const stashed = this.sessionStash.size;
        // Per-party breakdown (v1.13). The aggregate fields above and the
        // deprecated isHost mirror stay for single-party consumers.
        const parties = [];
        this.parties.forEach((party, partyId) => {
            const ps = { partyId, role: party.role, isDefault: partyId === this.defaultPartyId,
                connected: 0, interrupted: 0, finalizing: 0, pending: 0, stashed: 0 };
            this.peers.forEach((p) => {
                if ((p.partyId || null) !== partyId) return;
                if (p.status === 'connected') ps.connected++;
                else if (p.status === 'interrupted') ps.interrupted++;
                else if (p.status === 'finalizing') ps.finalizing++;
                else ps.pending++;
            });
            this.sessionStash.forEach((s) => { if ((s.partyId || null) === partyId) ps.stashed++; });
            parties.push(ps);
        });
        return {
            connected, interrupted, finalizing, pending, stashed,
            established: this.peers.size > 0 || stashed > 0,
            isHost: this.isHost,
            parties,
        };
    }

    /** The partyId a link (live entry first, then stash) belongs to, or null. */
    partyOf(peerId) {
        const p = this.peers.get(peerId);
        if (p) return p.partyId || null;
        const s = this.sessionStash.get(peerId);
        return s ? (s.partyId || null) : null;
    }

    /** 'leader' | 'member' for a known party, null otherwise. */
    partyRole(partyId) {
        const party = this.parties.get(partyId);
        return party ? party.role : null;
    }

    /**
     * One party's links: [{peerId, status, live}] — a stashed (repairing/
     * dead) session reports status 'stashed' with live:false.
     */
    partyPeers(partyId) {
        const out = [];
        this.peers.forEach((p, peerId) => {
            if ((p.partyId || null) === partyId) out.push({ peerId, status: p.status, live: true });
        });
        this.sessionStash.forEach((s, peerId) => {
            if ((s.partyId || null) === partyId) out.push({ peerId, status: 'stashed', live: false });
        });
        return out;
    }

    /**
     * A member party's single hub link id (live first, then stashed during a
     * repair window). Null for a party this node leads, or an unknown party.
     */
    hubLinkId(partyId) {
        if (this.partyRole(partyId) !== 'member') return null;
        for (const [pid, p] of this.peers) {
            if (p.type === 'host' && (p.partyId || null) === partyId) return pid;
        }
        for (const [pid, s] of this.sessionStash) {
            if (s.type === 'host' && (s.partyId || null) === partyId) return pid;
        }
        return null;
    }

    /**
     * Ends one party locally: drops its live links (terminal status events
     * fire per link) and forgets its stashed sessions, so nothing lingers to
     * repair into it. The party record itself is collected with the last
     * reference. A member "leaves the party"; a leader ends it for everyone
     * it is directly linked to.
     */
    closeParty(partyId) {
        const liveIds = [];
        this.peers.forEach((p, id) => { if ((p.partyId || null) === partyId) liveIds.push(id); });
        liveIds.forEach((id) => this.disconnectPeer(id)); // may stash — swept next
        const stashIds = [];
        this.sessionStash.forEach((s, id) => { if ((s.partyId || null) === partyId) stashIds.push(id); });
        stashIds.forEach((id) => this.sessionStash.delete(id));
        this._gcParty(partyId);
    }

    /** True while this peerId holds a live entry (any status, pre- or post-connect). */
    hasLink(peerId) {
        return this.peers.has(peerId);
    }

    /**
     * One link's transport status ('connected' | 'interrupted' | 'finalizing'
     * | 'connecting' | ...), or null when the peerId holds no live entry.
     */
    linkStatus(peerId) {
        const p = this.peers.get(peerId);
        return p ? p.status : null;
    }

    /** True while a terminally-dead link's session is stashed for resumption. */
    hasStashedSession(peerId) {
        return this.sessionStash.has(peerId);
    }

    /**
     * A joiner's single direct link is by definition the host. Prefers the
     * live entry typed 'host'; during a stash-repair window (entry torn down,
     * outbox stashed) the stash preserves the link type, so it is checked
     * next. Null on a host node (its links are all joiners) or when no host
     * link exists in either place.
     */
    hostLinkId() {
        if (this.isHost) return null;
        for (const [pid, p] of this.peers) {
            if (p.type === 'host') return pid;
        }
        for (const [pid, s] of this.sessionStash) {
            if (s.type === 'host') return pid;
        }
        return null;
    }

    /**
     * Abandons unfinished ceremonies — drops each link that never reached
     * 'connected'. An 'interrupted' peer is an established session mid-repair,
     * not a failed attempt, so it survives. Routes through disconnectPeer so a
     * terminal 'status' event reaches every listener (a bare peers.delete()
     * would wedge the layers above). Pass a partyId to abandon only that
     * party's pending ceremonies (v1.13) — omitted, every party's.
     */
    abandonPending(partyId) {
        this.peers.forEach((p, id) => {
            if (partyId !== undefined && (p.partyId || null) !== partyId) return;
            if (p.status !== 'connected' && p.status !== 'interrupted') {
                this.disconnectPeer(id);
            }
        });
    }

    /**
     * Replay-queue visibility across live links and stashed sessions:
     * { depth, limit, overflowed }. depth is the deepest per-link outbox;
     * overflowed means the oldest unacked frames were already dropped and the
     * layers above should resync state after recovery.
     */
    outboxSnapshot() {
        let depth = 0, overflowed = false;
        this.peers.forEach((p) => {
            depth = Math.max(depth, (p.outbox || []).length);
            if (p.outboxOverflowed) overflowed = true;
        });
        this.sessionStash.forEach((s) => {
            depth = Math.max(depth, (s.outbox || []).length);
            if (s.outboxOverflowed) overflowed = true;
        });
        return { depth, limit: this.options.outboxLimit, overflowed };
    }

    /** Read-only copy of the tuning knobs (mutating it changes nothing). */
    getConfig() {
        return { ...this.options };
    }

    // The only externally-tunable knobs (the ceremony UI's settings panel).
    // Everything else in `options` is fixed at construction.
    static get TUNABLE_OPTIONS() {
        return ['allowLocalCandidates', 'allowIPv6Candidates', 'connectionTimeoutMs', 'iceMode'];
    }

    /**
     * Applies a partial update of the tunable knobs; unknown keys are ignored.
     * Returns the resulting config snapshot. New values apply to future
     * connections/timers; established links keep the values they started with.
     */
    setConfig(partial = {}) {
        for (const key of PeerManager.TUNABLE_OPTIONS) {
            if (!(key in partial)) continue;
            if (key === 'iceMode') {
                this.options.iceMode = partial.iceMode === 'local' ? 'local' : 'anywhere';
            } else {
                this.options[key] = partial[key];
            }
        }
        return this.getConfig();
    }

    /** Drops one peer's stashed session, if any — a deliberate "start over". */
    forgetSession(peerId) {
        const stash = this.sessionStash.get(peerId);
        this.sessionStash.delete(peerId);
        if (stash && stash.partyId) this._gcParty(stash.partyId);
    }

    /**
     * Installs an externally-negotiated connection under a peerId, resuming
     * that link's session (seq counters + outbox) from the live entry or the
     * stash. This is how the rendezvous layer swaps a freshly re-signaled
     * connection in WITHOUT the apps above noticing anything beyond
     * interrupted → connected: on channel-open the standard resync exchange
     * replays whatever was queued when the old link died.
     *
     * @param {string} peerId - The link identity both sides key the session by.
     * @param {RTCPeerConnection} connection - Prepared connection (offer/answer already set).
     * @param {RTCDataChannel} [channel] - The caller side passes the channel it
     *        created; the answerer side omits it (ondatachannel delivers it).
     * @param {object} [opts] - {fallbackType} when no prior session exists
     *        (e.g. after a full browser restart): 'client' → impolite, 'host' → polite.
     */
    adoptConnection(peerId, connection, channel, opts = {}) {
        const prior = this.peers.get(peerId) || this.sessionStash.get(peerId);
        const type = (prior && prior.type) || opts.fallbackType || 'client';
        // Party continuity (v1.13): a repaired link rejoins the party its
        // session belonged to. With no prior session (full browser restart),
        // the layer above may pass opts.partyId (persisted membership);
        // otherwise derive a party from the link type. Leader-side fallbacks
        // COALESCE into one adopted leader party — correct for the
        // single-party world this fallback serves, and what restores hub
        // relay after a hub restart (pre-v1.13, isHost was never re-derived
        // on resume, so a restarted hub silently stopped relaying). A
        // multi-party restart resume must pass opts.partyId explicitly.
        let partyId = (prior && prior.partyId) || opts.partyId || null;
        if (!partyId) {
            if (type === 'host') {
                partyId = this.generateId();
                this.parties.set(partyId, { role: 'member' });
            } else {
                if (!this._adoptedLeaderPartyId || !this.parties.has(this._adoptedLeaderPartyId)) {
                    this._adoptedLeaderPartyId = this.createParty();
                }
                partyId = this._adoptedLeaderPartyId;
            }
            if (!this.defaultPartyId) {
                this.defaultPartyId = partyId;
                this.isHost = type !== 'host'; // deprecated single-party mirror
            }
        }
        const peerData = this.initPeer(peerId, type, { preserveSession: true, adoptConnection: connection, partyId });
        if (channel) this.setupDataChannel(peerId, channel);
        this.dispatchEvent(new CustomEvent('diagnostic', { detail: {
            type: 'sys', msg: `Adopted a reconnected link for ${peerId}${prior ? ' (session resumed)' : ' (fresh session)'}.`
        }}));
        return peerData;
    }

    /** This side's DTLS fingerprint on one link (from its local description). */
    getOwnFingerprint(peerId) {
        const peerData = this.peers.get(peerId);
        const desc = peerData && peerData.connection.localDescription;
        return desc ? PeerManager.extractFingerprint(desc.sdp) : null;
    }

    /**
     * Sends a namespaced extension frame to one peer over the control channel
     * (e.g. the rendezvous pairing handshake). Extension frames inherit every
     * control-frame guarantee: DTLS-authenticated, direct-link only, never
     * relayed, unforgeable by apps.
     */
    sendExt(peerId, ns, data) {
        return this._sendControl(peerId, { __p2pc: 'ext', ns, data });
    }

    /**
     * Closes all peer connections and data channels, then clears the peers Map.
     * After destroy(), this instance should not be reused.
     */
    destroy() {
        if (typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', this._onVisibility);
        }
        this.peers.forEach((peerData) => {
            peerData._tearingDown = true;
            this._clearPeerTimers(peerData);
            try { peerData.dataChannel?.close(); } catch(_) {}
            try { peerData.connection.close(); } catch(_) {}
        });
        this.peers.clear();
        this.parties.clear();
        this.defaultPartyId = null;
    }

    // ---- parties (v1.13) --------------------------------------------------

    /**
     * Mints a fresh party this node LEADS. Returns its local partyId — pass
     * it to createOffer({partyId}) to invite players into it. Party identity
     * never travels on the wire (PROTOCOL §5.6): a frame's party is always
     * derived from the link it arrived on.
     */
    createParty() {
        const partyId = this.generateId();
        this.parties.set(partyId, { role: 'leader' });
        return partyId;
    }

    /** True while any live link or stashed session references the party. */
    _partyEstablished(partyId) {
        for (const p of this.peers.values()) if ((p.partyId || null) === partyId) return true;
        for (const s of this.sessionStash.values()) if ((s.partyId || null) === partyId) return true;
        return false;
    }

    /**
     * Collects a party whose last link/stash reference is gone. Deliberately
     * NOT run against never-used parties (createParty() before its first
     * ceremony) — those are collected once a link joins and later leaves.
     */
    _gcParty(partyId) {
        if (!partyId || !this.parties.has(partyId)) return;
        if (this._partyEstablished(partyId)) return;
        this.parties.delete(partyId);
        if (this.defaultPartyId === partyId) this.defaultPartyId = null;
    }

    async createOffer(opts = {}) {
        // Party resolution replaces the pre-v1.13 node-global role-flip
        // guard. The invariant is per-party: only a party's LEADER mints
        // invites for it. Starting a NEW party is always allowed — being a
        // member elsewhere no longer blocks hosting (the 2026-07-18
        // field-test limitation).
        let partyId = opts.partyId;
        if (partyId !== undefined) {
            const party = this.parties.get(partyId);
            if (party && party.role === 'member') {
                throw new Error('Only the party leader can invite new players — start a new party instead.');
            }
            // Unknown (or already-collected) id: revive it as a fresh party,
            // so a caller retrying an abandoned ceremony keeps its handle.
            if (!party) this.parties.set(partyId, { role: 'leader' });
        } else {
            // Legacy party-less call: v1.12 single-party semantics — operate
            // on the default party, refuse while it is one we JOINED
            // (flipping would corrupt that star; see PROTOCOL §5.6).
            const dflt = this.defaultPartyId ? this.parties.get(this.defaultPartyId) : null;
            if (dflt && dflt.role === 'member') {
                throw new Error('Cannot host while joined to another player — start over first.');
            }
            if (!dflt) this.defaultPartyId = this.createParty();
            partyId = this.defaultPartyId;
            this.isHost = true; // deprecated single-party mirror
        }
        await this._ensureCertificate();
        const peerId = this.generateId();
        const peerData = this.initPeer(peerId, 'client', { partyId });
        this.setupDataChannel(peerId, peerData.connection.createDataChannel('data'));

        try {
            const offer = await peerData.connection.createOffer();
            await peerData.connection.setLocalDescription(offer);
            await this.waitForIceGathering(peerId);
            this._warnIfNoCandidates(peerId);

            setTimeout(() => {
                // Only reap links that never completed the ceremony — a link
                // that connected and later got interrupted is the resilience
                // machinery's job, not this timeout's.
                if (!peerData.everConnected && this.peers.get(peerId) === peerData) {
                    this._teardownPeer(peerId, 'failed');
                    this.dispatchEvent(new CustomEvent('diagnostic', {
                        detail: { type: 'warn', msg: `Connection attempt to ${peerId} timed out.` }
                    }));
                }
            }, this.options.connectionTimeoutMs);

            const minifiedSDP = ConnectionUtils.minifySDP(peerData.connection.localDescription.sdp, this.options);

            return JSON.stringify({
                peerId: peerId,
                sessionDesc: {
                    type: peerData.connection.localDescription.type,
                    sdp: minifiedSDP
                }
            });
        } catch (e) {
            this.dispatchEvent(new CustomEvent('diagnostic', { detail: { type: 'error', msg: `Offer creation failed: ${e.message}` }}));
            throw e;
        }
    }

    async createAnswer(offerPayload, opts = {}) {
        // Joining always forms a FRESH party (role member, one hub link) —
        // the inviter leads it on their side. What varies is only the legacy
        // guard: a party-less call keeps the v1.12 refusal while the default
        // party is one this node LEADS with links alive or repairing
        // (dropping the relay would silently orphan its members); an
        // explicit {newParty:true} call never conflicts with existing
        // parties, so nothing blocks it.
        if (!opts.newParty) {
            const dflt = this.defaultPartyId ? this.parties.get(this.defaultPartyId) : null;
            if (dflt && dflt.role === 'leader' && this._partyEstablished(this.defaultPartyId)) {
                throw new Error('Cannot join while hosting — start over first.');
            }
        }
        const partyId = this.generateId();
        this.parties.set(partyId, { role: 'member' });
        if (!opts.newParty || !this.defaultPartyId) {
            this.defaultPartyId = partyId;
            this.isHost = false; // deprecated single-party mirror
        }
        await this._ensureCertificate();
        const hostPeerId = offerPayload.peerId;
        const peerData = this.initPeer(hostPeerId, 'host', { partyId });

        try {
            await peerData.connection.setRemoteDescription(new RTCSessionDescription(offerPayload.sessionDesc));
            const answer = await peerData.connection.createAnswer();
            await peerData.connection.setLocalDescription(answer);
            await this.waitForIceGathering(hostPeerId);
            this._warnIfNoCandidates(hostPeerId);

            const minifiedSDP = ConnectionUtils.minifySDP(peerData.connection.localDescription.sdp, this.options);

            return JSON.stringify({
                peerId: hostPeerId,
                sessionDesc: {
                    type: peerData.connection.localDescription.type,
                    sdp: minifiedSDP
                }
            });
        } catch(e) {
            this.dispatchEvent(new CustomEvent('diagnostic', { detail: { type: 'error', msg: `Answer creation failed: ${e.message}` }}));
            throw e;
        }
    }

    async acceptAnswer(answerPayload) {
        const peerId = answerPayload.peerId;
        const peerData = this.peers.get(peerId);

        if (!peerData) {
            this.dispatchEvent(new CustomEvent('diagnostic', { detail: { type: 'error', msg: `Peer ${peerId} not found to accept answer.` }}));
            return;
        }

        if (peerData.connection.signalingState !== 'have-local-offer') {
            this.dispatchEvent(new CustomEvent('diagnostic', { detail: { type: 'sys', msg: `Answer already processed for ${peerId}` }}));
            return;
        }

        try {
            await peerData.connection.setRemoteDescription(new RTCSessionDescription(answerPayload.sessionDesc));
            this.dispatchEvent(new CustomEvent('diagnostic', { detail: { type: 'sys', msg: `Answer accepted from ${peerId}` }}));
        } catch(e) {
            this.dispatchEvent(new CustomEvent('diagnostic', { detail: { type: 'error', msg: `Accepting answer failed: ${e.message}` }}));
        }
    }

    /**
     * Safari/WebKit withholds host ICE candidates until the page holds a
     * device-capture permission, and gathers nothing at all in 'local' mode
     * (no STUN, no camera). Detect the empty-candidate case and tell the user
     * why the connection cannot possibly succeed, instead of failing silently.
     */
    _warnIfNoCandidates(peerId) {
        const peerData = this.peers.get(peerId);
        if (!peerData || !peerData.connection.localDescription) return;
        const count = (peerData.connection.localDescription.sdp.match(/a=candidate:/g) || []).length;
        if (count === 0) {
            this.dispatchEvent(new CustomEvent('diagnostic', {
                detail: {
                    type: 'warn',
                    msg: 'No ICE candidates gathered! On Safari, "Same Wi-Fi only" mode requires camera permission — switch to "Anywhere" mode or use the QR scan flow.'
                }
            }));
        }
    }

    async waitForIceGathering(peerId) {
        const peerData = this.peers.get(peerId);
        if (!peerData) return;

        return new Promise((resolve) => {
            if (peerData.connection.iceGatheringState === 'complete') {
                resolve();
            } else {
                let timeout;
                const checkState = () => {
                    if (peerData.connection.iceGatheringState === 'complete') {
                        peerData.connection.removeEventListener('icegatheringstatechange', checkState);
                        clearTimeout(timeout);
                        resolve();
                    }
                };
                peerData.connection.addEventListener('icegatheringstatechange', checkState);

                // 10 second timeout
                timeout = setTimeout(() => {
                    peerData.connection.removeEventListener('icegatheringstatechange', checkState);
                    this.dispatchEvent(new CustomEvent('diagnostic', { detail: { type: 'warn', msg: `ICE Gathering Timeout for ${peerId}. Proceeding.` }}));
                    resolve();
                }, 10000);
            }
        });
    }
}
