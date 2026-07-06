import { SDPCodec } from './sdp-codec.js';

const STUN_SERVERS = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun.services.mozilla.com' }
    ]
};

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
     * Specifically filters out TCP candidates and optionally mDNS (.local) and IPv6 based on options.
     */
    static minifySDP(sdpStr, options = {}) {
        const allowLocal = options.allowLocalCandidates !== false;
        const allowIPv6 = options.allowIPv6Candidates !== false;
        const lines = sdpStr.split('\r\n');
        const minified = lines.filter(line => {
            if (line.startsWith('a=candidate:')) {
                // Drop TCP candidates (UDP is preferred for WebRTC data)
                if (line.includes(' tcp ')) return false;

                // Drop mDNS candidates if not allowed
                if (!allowLocal && line.includes('.local')) return false;

                const parts = line.split(' ');
                // Drop IPv6 candidates if not allowed (address is part 4, 0-indexed)
                if (!allowIPv6 && parts.length > 4 && parts[4].includes(':')) return false;

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
export class PeerManager extends EventTarget {
    constructor(options = {}) {
        super();
        this.peers = new Map();
        this.isHost = false;
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
            // Resilience tuning (v1.7) — see the class comment.
            heartbeatIntervalMs: options.heartbeatIntervalMs || 5000,
            heartbeatTimeoutMs: options.heartbeatTimeoutMs || 12000,
            // Generous by default: an interrupted peer costs one idle
            // RTCPeerConnection, and a phone can easily sit suspended for
            // minutes before its player returns. UIs get 'interrupted' and can
            // offer a "give up" action (disconnectPeer) long before this fires.
            interruptedGraceMs: options.interruptedGraceMs || 300000,
            wakeProbeTimeoutMs: options.wakeProbeTimeoutMs || 3000,
            outboxLimit: options.outboxLimit || 1000
        };

        this._onVisibility = () => {
            if (!document.hidden) this._onWake();
        };
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', this._onVisibility);
        }
    }

    generateId() {
        return Math.random().toString(36).substring(2, 9);
    }

    initPeer(peerId, type) {
        if(this.peers.has(peerId)) {
            const existing = this.peers.get(peerId);
            this._clearPeerTimers(existing);
            existing._tearingDown = true;
            existing.connection.onicecandidate = null;
            existing.connection.close();
            this.peers.delete(peerId);
        }

        const rtcConfig = this.options.iceMode === 'local' ? { iceServers: [] } : STUN_SERVERS;
        const peerConnection = new RTCPeerConnection(rtcConfig);
        const peerData = {
            connection: peerConnection,
            dataChannel: null,
            status: 'new',
            type: type,
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
            heartbeatTimer: null,
            graceTimer: null,
            restartTimer: null,
            wakeProbeTimer: null,
            _tearingDown: false
        };
        this.peers.set(peerId, peerData);

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
            this._sendControl(peerId, { __p2pc: 'resync', have: peerData.lastInSeq });
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

        const msg = (parsed && typeof parsed === 'object') ? parsed : { text: raw, from: peerId }; // legacy string fallback

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

        // Host relays APP messages between clients — each destination link
        // gets its own reliability sequence. Control frames are never relayed.
        if (this.isHost && msg.from !== this.myId) {
            this.peers.forEach((destData, destId) => {
                if (destId !== peerId) this._sendAppTo(destId, { text: msg.text, from: msg.from });
            });
        }

        // Destructure only the expected fields to avoid merging arbitrary keys
        const { text, from } = msg;
        this.dispatchEvent(new CustomEvent('message', {
            detail: { text, from, incoming: true, peerId }
        }));
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
            case 'ack':
                if (typeof msg.upTo === 'number') {
                    peerData.outbox = peerData.outbox.filter(e => e.seq > msg.upTo);
                }
                break;
            case 'resync': {
                if (typeof msg.have !== 'number') break;
                peerData.outbox = peerData.outbox.filter(e => e.seq > msg.have);
                if (peerData.outbox.length && peerData.dataChannel && peerData.dataChannel.readyState === 'open') {
                    this.dispatchEvent(new CustomEvent('diagnostic', { detail: {
                        type: 'sys', msg: `Replaying ${peerData.outbox.length} buffered message(s) to ${peerId}.`
                    }}));
                    for (const entry of peerData.outbox) {
                        try { peerData.dataChannel.send(entry.wire); } catch(e) { break; }
                    }
                }
                break;
            }
            case 'signal':
                this._handleSignal(peerId, msg);
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
    _sendAppTo(peerId, msg) {
        const peerData = this.peers.get(peerId);
        if (!peerData) return false;
        const open = peerData.dataChannel && peerData.dataChannel.readyState === 'open';
        if (!open && peerData.status !== 'interrupted') return false;

        const seq = ++peerData.outSeq;
        const wire = JSON.stringify({ text: msg.text, from: msg.from, seq });
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
        if (open) {
            try { peerData.dataChannel.send(wire); } catch(e) { /* stays queued for resync */ }
        }
        return true;
    }

    broadcast(message, excludePeerId = null) {
        // Accepts {text, from} or a pre-stringified JSON of one.
        let msg = message;
        if (typeof message === 'string') {
            try { msg = JSON.parse(message); } catch(e) { msg = null; }
            if (!msg || typeof msg !== 'object') msg = { text: message, from: this.myId };
        }
        let sent = false;
        this.peers.forEach((peerData, pId) => {
            if (pId !== excludePeerId && this._sendAppTo(pId, msg)) sent = true;
        });
        return sent;
    }

    send(text) {
        const payload = { text, from: this.myId };
        const sent = this.broadcast(payload);

        if (sent) {
            this.dispatchEvent(new CustomEvent('message', { detail: { text, from: this.myId, incoming: false }}));
        } else {
            this.dispatchEvent(new CustomEvent('diagnostic', { detail: { type: 'error', msg: 'Cannot send, no channels open.' }}));
        }
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
                if (!this.peers.has(peerId)) return;
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
    }

    _teardownPeer(peerId, finalStatus) {
        const peerData = this.peers.get(peerId);
        if (!peerData) return;
        peerData._tearingDown = true;
        this._clearPeerTimers(peerData);
        try { peerData.dataChannel?.close(); } catch(_) {}
        try {
            peerData.connection.onicecandidate = null;
            peerData.connection.close();
        } catch(_) {}
        this.peers.delete(peerId);
        this.dispatchEvent(new CustomEvent('chatState', { detail: { peerId, ready: false } }));
        this.dispatchEvent(new CustomEvent('status', { detail: { peerId, status: finalStatus } }));
    }

    /** Deliberately drops one link (e.g. a UI "leave game" action). */
    disconnectPeer(peerId) {
        this._teardownPeer(peerId, 'disconnected');
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
    }

    async createOffer() {
        this.isHost = true;
        const peerId = this.generateId();
        const peerData = this.initPeer(peerId, 'client');
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

    async createAnswer(offerPayload) {
        this.isHost = false;
        const hostPeerId = offerPayload.peerId;
        const peerData = this.initPeer(hostPeerId, 'host');

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
