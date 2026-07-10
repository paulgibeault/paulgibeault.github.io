/* rendezvous-carriers.js — pluggable dead-drop transports for the reconnect
 * rendezvous (PROTOCOL.md §7.6).
 *
 * Carrier interface (all a carrier ever does — it moves opaque sealed blobs):
 *   await carrier.connect()
 *   await carrier.publish(topic, payloadStr)
 *   const unsub = carrier.subscribe(topic, (payloadStr) => {})
 *   carrier.close()
 * Optional (the episode layer feature-detects both):
 *   carrier.ensureAlive()   - synchronous liveness kick: probe the socket
 *                             NOW instead of waiting for the ping cadence
 *   carrier.onSessionUp     - assignable callback, fired after each
 *                             (re)established session once subscriptions
 *                             are re-issued — the episode republishes there
 *
 * Topics are 32-hex-char pair/day rendezvous ids (never identifying);
 * payloads are AEAD-sealed base64url blobs. A carrier is UNTRUSTED by
 * design: it can only delay or drop, never read or forge (see the crypto
 * module). Implementations here:
 *
 *   LoopbackCarrier — BroadcastChannel; same-origin pages only. For tests
 *                     and same-device tabs.
 *   MqttCarrier     — minimal dependency-free MQTT 3.1.1 client over WSS,
 *                     for free public brokers (QoS 0 only; retries live in
 *                     the rendezvous episode layer, which republishes).
 *   MultiCarrier    — fans one carrier interface out across several legs
 *                     (one per broker): publish to every live leg,
 *                     subscribe on all, drop duplicate deliveries. The
 *                     rendezvous stays reachable while ANY one broker is
 *                     reachable from BOTH devices — a single flaky free
 *                     broker must never strand two paired devices again
 *                     (test.mosquitto.org was down a whole evening,
 *                     2026-07-09 field logs).
 */

// ---------------------------------------------------------------------------

export class LoopbackCarrier {
    constructor(name = 'qrp2p-rdv-loopback') {
        this.name = name;
        this.bc = null;
        this.subs = new Map(); // topic → Set<cb>
    }

    async connect() {
        if (this.bc) return;
        this.bc = new BroadcastChannel(this.name);
        this.bc.onmessage = (e) => {
            const { topic, payload } = e.data || {};
            const set = this.subs.get(topic);
            if (set) set.forEach(cb => { try { cb(payload); } catch (err) {} });
        };
    }

    async publish(topic, payload) {
        if (this.bc) this.bc.postMessage({ topic, payload });
    }

    subscribe(topic, cb) {
        if (!this.subs.has(topic)) this.subs.set(topic, new Set());
        this.subs.get(topic).add(cb);
        return () => { const s = this.subs.get(topic); if (s) s.delete(cb); };
    }

    close() {
        if (this.bc) { this.bc.close(); this.bc = null; }
        this.subs.clear();
    }
}

// ---------------------------------------------------------------------------
// Minimal MQTT 3.1.1 encoder/decoder — exported for hermetic unit tests.

const PKT = { CONNECT: 0x10, CONNACK: 0x20, PUBLISH: 0x30, SUBSCRIBE: 0x82, SUBACK: 0x90, PINGREQ: 0xC0, PINGRESP: 0xD0, DISCONNECT: 0xE0 };

function encodeVarint(n) {
    const out = [];
    do {
        let b = n % 128;
        n = Math.floor(n / 128);
        if (n > 0) b |= 0x80;
        out.push(b);
    } while (n > 0);
    return out;
}

function encodeString(str) {
    const bytes = new TextEncoder().encode(str);
    return [bytes.length >> 8, bytes.length & 0xff, ...bytes];
}

export const mqttCodec = {
    connect(clientId, keepaliveSec = 60) {
        const variable = [...encodeString('MQTT'), 4 /* level */, 0x02 /* clean session */, keepaliveSec >> 8, keepaliveSec & 0xff, ...encodeString(clientId)];
        return Uint8Array.from([PKT.CONNECT, ...encodeVarint(variable.length), ...variable]);
    },
    subscribe(packetId, topic) {
        const variable = [packetId >> 8, packetId & 0xff, ...encodeString(topic), 0 /* QoS 0 */];
        return Uint8Array.from([PKT.SUBSCRIBE, ...encodeVarint(variable.length), ...variable]);
    },
    publish(topic, payloadStr) {
        const payload = new TextEncoder().encode(payloadStr);
        const variable = [...encodeString(topic), ...payload]; // QoS 0: no packet id
        return Uint8Array.from([PKT.PUBLISH, ...encodeVarint(variable.length), ...variable]);
    },
    pingreq() { return Uint8Array.from([PKT.PINGREQ, 0]); },
    disconnect() { return Uint8Array.from([PKT.DISCONNECT, 0]); },

    /**
     * Incremental parser. Feed it arbitrary byte chunks; it returns complete
     * packets [{type, topic?, payload?}] and buffers partials internally.
     */
    makeParser() {
        // Untrusted public brokers let anyone PUBLISH to any topic, so the
        // stream is attacker-controlled. Legitimate sealed rendezvous blobs are
        // ≤~2 KB; cap declared packet length well above that and DISCARD anything
        // larger without ever buffering it, so a giant-length PUBLISH can't drive
        // unbounded memory growth below the decrypt layer. `skip` remembers how
        // many bytes of an in-progress oversized packet still to drop, keeping
        // the stream frame-synced across chunk boundaries.
        const MAX_PACKET_BYTES = 16 * 1024;
        let buf = new Uint8Array(0);
        let skip = 0;
        return function feed(chunk) {
            if (skip > 0) {
                if (chunk.length <= skip) { skip -= chunk.length; return []; }
                chunk = chunk.subarray(skip);
                skip = 0;
            }
            const merged = new Uint8Array(buf.length + chunk.length);
            merged.set(buf, 0);
            merged.set(chunk, buf.length);
            buf = merged;
            const packets = [];
            while (true) {
                if (buf.length < 2) break;
                // remaining-length varint
                let len = 0, mult = 1, i = 1, ok = false;
                for (; i < Math.min(buf.length, 5); i++) {
                    len += (buf[i] & 0x7f) * mult;
                    mult *= 128;
                    if ((buf[i] & 0x80) === 0) { ok = true; i++; break; }
                }
                if (!ok) break; // varint incomplete
                if (len > MAX_PACKET_BYTES) {
                    // Oversized/hostile packet: consume and discard its bytes
                    // without retaining them; skip any part not yet received.
                    const total = i + len;
                    if (buf.length >= total) { buf = buf.slice(total); continue; }
                    skip = total - buf.length;
                    buf = new Uint8Array(0);
                    break;
                }
                if (buf.length < i + len) break; // packet incomplete
                const type = buf[0] & 0xf0;
                const body = buf.subarray(i, i + len);
                if (type === PKT.PUBLISH) {
                    const qos = (buf[0] >> 1) & 0x03;
                    const topicLen = (body[0] << 8) | body[1];
                    const topic = new TextDecoder().decode(body.subarray(2, 2 + topicLen));
                    const payloadStart = 2 + topicLen + (qos > 0 ? 2 : 0);
                    const payload = new TextDecoder().decode(body.subarray(payloadStart));
                    packets.push({ type: 'publish', topic, payload });
                } else if (type === PKT.CONNACK) {
                    packets.push({ type: 'connack', ok: body[1] === 0 });
                } else if (type === PKT.SUBACK) {
                    packets.push({ type: 'suback' });
                } else if (type === PKT.PINGRESP) {
                    packets.push({ type: 'pingresp' });
                } else {
                    packets.push({ type: 'other', header: buf[0] });
                }
                buf = buf.slice(i + len);
            }
            return packets;
        };
    }
};

// ---------------------------------------------------------------------------

/**
 * Fans the carrier interface out across several underlying carriers, one per
 * broker. Sealed blobs and unlinkable topics make brokers interchangeable
 * dead-drops, so redundancy is free correctness-wise: publishes go to EVERY
 * leg with a live session, subscriptions are issued on every leg, and the
 * same blob arriving via two brokers is delivered once (small per-topic
 * recency window; the episode layer's nonce checks also dedup, this just
 * keeps decrypt work and diagnostics quiet). connect() resolves on the
 * FIRST leg to get a session — the rest keep dialing in the background.
 */
export class MultiCarrier {
    constructor(carriers) {
        this.carriers = carriers;
        this.onSessionUp = null; // fan-in: any leg's (re)session fires it
        this._recent = new Map(); // topic → {set, fifo} recently delivered payloads
        for (const c of this.carriers) {
            c.onSessionUp = () => {
                if (this.onSessionUp) { try { this.onSessionUp(); } catch (e) {} }
            };
        }
    }

    connect() {
        return Promise.race(this.carriers.map(c => c.connect()));
    }

    ensureAlive() {
        for (const c of this.carriers) {
            try { if (typeof c.ensureAlive === 'function') c.ensureAlive(); } catch (e) {}
        }
    }

    async publish(topic, payload) {
        let sent = 0;
        for (const c of this.carriers) {
            try { await c.publish(topic, payload); sent++; } catch (e) {}
        }
        // Same contract as a single carrier: the episode's retry schedule
        // (and its "publish failed" diagnostic) owns the outage.
        if (!sent) throw new Error('carrier not connected (no live broker)');
    }

    subscribe(topic, cb) {
        const deliver = (payload) => {
            let r = this._recent.get(topic);
            if (!r) { r = { set: new Set(), fifo: [] }; this._recent.set(topic, r); }
            if (r.set.has(payload)) return; // same blob via another broker
            r.set.add(payload);
            r.fifo.push(payload);
            if (r.fifo.length > 64) r.set.delete(r.fifo.shift());
            try { cb(payload); } catch (e) {}
        };
        const unsubs = this.carriers.map(c => c.subscribe(topic, deliver));
        return () => unsubs.forEach(u => { try { u(); } catch (e) {} });
    }

    close() {
        for (const c of this.carriers) { try { c.close(); } catch (e) {} }
        this._recent.clear();
    }
}

// ---------------------------------------------------------------------------

export class MqttCarrier {
    /**
     * Self-healing MQTT connection: one connect() call keeps a socket alive
     * until close() — redialing with backoff on failure or loss, re-issuing
     * every subscription on each reconnect, and treating a missed PINGRESP
     * as a dead socket (half-open WebSockets otherwise look healthy forever).
     * Free public brokers restart routinely; a rendezvous that outlives one
     * broker restart must keep listening, so socket loss is never surfaced
     * as an error — publish() during an outage throws, and the rendezvous
     * layer's republish schedule papers over the gap.
     *
     * @param {object} [opts]
     * @param {string} [opts.url] - WSS endpoint of a public MQTT broker.
     * @param {string} [opts.topicPrefix] - Namespace prefix on the broker.
     * @param {(msg: string) => void} [opts.onLog] - Socket-lifecycle
     *   diagnostics (dial/up/lost/redial). Never called for per-message
     *   traffic; never load-bearing.
     */
    constructor(opts = {}) {
        this.url = opts.url || 'wss://test.mosquitto.org:8081/mqtt';
        this.topicPrefix = opts.topicPrefix || 'qrp2p/r/v1/';
        this.onLog = typeof opts.onLog === 'function' ? opts.onLog : null;
        this.ws = null;             // the LIVE (post-CONNACK) socket only
        this.subs = new Map();      // full topic → Set<cb>
        this.pingTimer = null;
        this.packetId = 1;
        this._parser = null;
        this.closed = false;
        this._dialing = false;
        this._redialTimer = null;
        this._backoffIdx = 0;
        this._awaitingPong = false;
        this._firstUp = null;       // resolves the connect() promise
        this._connectPromise = null;
        this.onSessionUp = null;    // optional: fired on each (re)established session
    }

    /**
     * Starts the connection manager. Resolves on the FIRST successful broker
     * session; never rejects — if the broker is down, dialing continues with
     * backoff until close(). Publishers must rely on their own retry
     * schedule rather than on connect() having settled.
     */
    connect() {
        if (this.closed) return Promise.reject(new Error('carrier closed'));
        if (!this._connectPromise) {
            this._connectPromise = new Promise((resolve) => { this._firstUp = resolve; });
            this._dial();
        }
        return this._connectPromise;
    }

    _log(msg) {
        if (this.onLog) { try { this.onLog(msg); } catch (e) {} }
    }

    _dial() {
        if (this.closed || this.ws || this._dialing) return;
        this._dialing = true;
        this._log(`dialing ${this.url}…`);
        const dialedAt = Date.now();
        let ws;
        try {
            ws = new WebSocket(this.url, 'mqtt');
        } catch (e) {
            this._log(`WebSocket constructor failed (${e && e.message})`);
            this._dialing = false;
            this._scheduleRedial();
            return;
        }
        ws.binaryType = 'arraybuffer';
        this._parser = mqttCodec.makeParser();
        let done = false;
        const abort = () => {
            if (done) return;
            done = true;
            clearTimeout(guard);
            this._log(`dial failed after ${Date.now() - dialedAt}ms (socket error/closed/timeout)`);
            try { ws.close(); } catch (e) {}
            this._dialing = false;
            this._scheduleRedial();
        };
        const guard = setTimeout(abort, 15000);
        ws.onerror = abort;
        ws.onclose = abort;
        ws.onopen = () => {
            try { ws.send(mqttCodec.connect('qrp2p-' + Math.random().toString(36).slice(2, 10))); } catch (e) { abort(); }
        };
        ws.onmessage = (e) => {
            for (const pkt of this._parser(new Uint8Array(e.data))) {
                if (pkt.type !== 'connack') continue;
                if (done) return;
                done = true;
                clearTimeout(guard);
                if (!pkt.ok) {
                    this._log('broker refused the MQTT session (CONNACK != 0)');
                    try { ws.close(); } catch (err) {}
                    this._dialing = false;
                    this._scheduleRedial();
                    return;
                }
                this._log(`broker session up in ${Date.now() - dialedAt}ms (${this.subs.size} subscription(s) re-issued)`);
                this._dialing = false;
                this._backoffIdx = 0;
                this.ws = ws;
                ws.onmessage = (ev) => this._onFrame(new Uint8Array(ev.data));
                ws.onerror = null;
                ws.onclose = () => this._lost(ws);
                this._startPing(ws);
                // (Re-)issue every subscription on this fresh session.
                for (const full of this.subs.keys()) {
                    try { ws.send(mqttCodec.subscribe(this.packetId++ & 0xffff || 1, full)); } catch (err) {}
                }
                if (this._firstUp) { this._firstUp(); this._firstUp = null; }
                if (this.onSessionUp) { try { this.onSessionUp(); } catch (err) {} }
                return;
            }
        };
    }

    _startPing(ws) {
        this._awaitingPong = false;
        this.pingTimer = setInterval(() => {
            if (this._awaitingPong) {
                // No PINGRESP since our last PINGREQ: the socket is dead even
                // if the WebSocket object doesn't know it yet.
                this._lost(ws);
                return;
            }
            this._awaitingPong = true;
            try { ws.send(mqttCodec.pingreq()); } catch (err) { this._lost(ws); }
        }, 30000);
    }

    _lost(ws) {
        if (this.ws !== ws) return;
        this.ws = null;
        if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
        this._log('broker session lost — redialing');
        try { ws.onclose = null; ws.close(); } catch (e) {}
        this._scheduleRedial();
    }

    _scheduleRedial() {
        if (this.closed || this._redialTimer || this.ws || this._dialing) return;
        const BACKOFF = [1000, 2000, 5000, 15000, 30000];
        const delay = BACKOFF[Math.min(this._backoffIdx++, BACKOFF.length - 1)];
        this._redialTimer = setTimeout(() => {
            this._redialTimer = null;
            this._dial();
        }, delay);
    }

    _onFrame(bytes) {
        for (const pkt of this._parser(bytes)) {
            if (pkt.type === 'pingresp') { this._awaitingPong = false; continue; }
            if (pkt.type !== 'publish') continue;
            const set = this.subs.get(pkt.topic);
            if (set) set.forEach(cb => { try { cb(pkt.payload); } catch (err) {} });
        }
    }

    /**
     * Immediate liveness check, for foreground/network-change nudges. A page
     * thawing from a suspend often holds a WebSocket object that still LOOKS
     * open while the broker dropped the session long ago (keepalive expiry),
     * and the regular 30s ping cadence — itself just thawed — is too slow
     * for a user actively watching a Call attempt. With no socket, dial NOW
     * (a suspended redial timer would otherwise wait out its full backoff);
     * with one, ping and give the broker 5s to answer before declaring the
     * socket dead and redialing.
     */
    ensureAlive() {
        if (this.closed) return;
        if (!this.ws) {
            if (this._redialTimer) { clearTimeout(this._redialTimer); this._redialTimer = null; }
            this._backoffIdx = 0;
            this._dial();
            return;
        }
        const ws = this.ws;
        try { ws.send(mqttCodec.pingreq()); } catch (e) { this._lost(ws); return; }
        this._awaitingPong = true;
        setTimeout(() => {
            if (this.ws === ws && this._awaitingPong) this._lost(ws);
        }, 5000);
    }

    async publish(topic, payload) {
        if (!this.ws) throw new Error('carrier not connected');
        this.ws.send(mqttCodec.publish(this.topicPrefix + topic, payload));
    }

    subscribe(topic, cb) {
        const full = this.topicPrefix + topic;
        if (!this.subs.has(full)) {
            this.subs.set(full, new Set());
            if (this.ws) {
                try { this.ws.send(mqttCodec.subscribe(this.packetId++ & 0xffff || 1, full)); } catch (e) {}
            }
        }
        this.subs.get(full).add(cb);
        return () => { const s = this.subs.get(full); if (s) s.delete(cb); };
    }

    close() {
        this.closed = true;
        if (this._redialTimer) { clearTimeout(this._redialTimer); this._redialTimer = null; }
        if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
        if (this.ws) {
            try { this.ws.send(mqttCodec.disconnect()); } catch (e) {}
            try { this.ws.onclose = null; this.ws.close(); } catch (e) {}
            this.ws = null;
        }
        if (this._firstUp) { this._firstUp(); this._firstUp = null; } // release any awaiter
        this.subs.clear();
    }
}
