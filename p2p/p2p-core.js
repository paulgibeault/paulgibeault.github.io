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
            iceMode: options.iceMode === 'local' ? 'local' : 'anywhere'
        };
    }

    generateId() {
        return Math.random().toString(36).substring(2, 9);
    }

    initPeer(peerId, type) {
        if(this.peers.has(peerId)) {
            const existing = this.peers.get(peerId);
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
            type: type
        };
        this.peers.set(peerId, peerData);
        
        peerConnection.oniceconnectionstatechange = () => {
            const iceState = peerConnection.iceConnectionState;
            if (iceState === 'failed') {
                peerConnection.close();
                this.peers.delete(peerId);
                this.dispatchEvent(new CustomEvent('status', { detail: { peerId, status: 'failed' } }));
                return;
            }
            // FIELD-TEST LESSON (2026-07-04): ICE can reach 'connected' on the
            // JOINER before the host has even received the answer — the host's
            // ICE agent answers connectivity checks pre-answer. Reporting that
            // as "connected" hid the answer QR mid-ceremony and stranded the
            // host. App-level 'connected' therefore requires the DATA CHANNEL
            // to be open; until then ICE-connected surfaces as 'finalizing'.
            let status = iceState;
            if (iceState === 'connected' || iceState === 'completed') {
                const channelOpen = peerData.dataChannel && peerData.dataChannel.readyState === 'open';
                status = channelOpen ? 'connected' : 'finalizing';
                if (status === 'finalizing' && !peerData._finalizingLogged) {
                    peerData._finalizingLogged = true;
                    this.dispatchEvent(new CustomEvent('diagnostic', { detail: {
                        type: 'info',
                        msg: `Network path to ${peerId} established — waiting for the secure channel. If you are the JOINER, the host still needs your answer (reply link or QR).`
                    }}));
                }
            }
            peerData.status = status;
            this.dispatchEvent(new CustomEvent('status', { detail: { peerId, status } }));
        };

        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                const cstr = event.candidate.candidate;
                let typeMatch = cstr.match(/typ (\w+)/);
                let candType = typeMatch ? typeMatch[1] : 'unknown';
                let outStr = `[${candType.toUpperCase()}] ${event.candidate.address}:${event.candidate.port}`;
                this.dispatchEvent(new CustomEvent('diagnostic', {
                    detail: { type: 'ice', msg: `[Peer ${peerId}] ${outStr}` }
                }));
            } else {
                this.dispatchEvent(new CustomEvent('diagnostic', {
                    detail: { type: 'sys', msg: `ICE Gathering Complete for ${peerId}.` }
                }));
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
            peerData.status = 'connected';
            this.dispatchEvent(new CustomEvent('status', { detail: { peerId, status: 'connected' } }));
            this.dispatchEvent(new CustomEvent('chatState', { detail: { peerId, ready: true } }));
            this.dispatchEvent(new CustomEvent('diagnostic', { detail: { type: 'success', msg: `Data channel OPEN with ${peerId}!` }}));
        };
        peerData.dataChannel.onclose = () => {
            this.dispatchEvent(new CustomEvent('chatState', { detail: { peerId, ready: false } }));
            this.peers.delete(peerId);
            this.dispatchEvent(new CustomEvent('status', { detail: { peerId, status: 'disconnected' } }));
        };
        peerData.dataChannel.onmessage = (event) => {
            let data = event.data;
            let parsed = null;
            
            try {
                parsed = JSON.parse(data);
            } catch(e) {
                parsed = { text: data, from: peerId }; // legacy string fallback
            }

            // Host relays messages
            if (this.isHost && parsed.from !== this.myId) {
                this.broadcast(data, peerId);
            }

            // Destructure only the expected fields to avoid merging arbitrary keys
            const { text, from } = parsed;
            this.dispatchEvent(new CustomEvent('message', { 
                detail: { text, from, incoming: true, peerId } 
            }));
        };
    }

    broadcast(message, excludePeerId = null) {
        let sent = false;
        const msgStr = typeof message === 'string' ? message : JSON.stringify(message);

        this.peers.forEach((peerData, pId) => {
            if (pId !== excludePeerId && peerData.dataChannel && peerData.dataChannel.readyState === 'open') {
                peerData.dataChannel.send(msgStr);
                sent = true;
            }
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

    /**
     * Closes all peer connections and data channels, then clears the peers Map.
     * After destroy(), this instance should not be reused.
     */
    destroy() {
        this.peers.forEach((peerData) => {
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
                if (peerData.status !== 'connected') {
                    peerData.connection.close();
                    this.peers.delete(peerId);
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
