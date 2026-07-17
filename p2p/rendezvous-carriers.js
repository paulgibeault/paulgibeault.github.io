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
 *   CarrierPool     — ONE shared underlying carrier per device, handed out
 *                     as ref-counted leases that each speak the full
 *                     carrier interface. Every rendezvous episode used to
 *                     mint its own MultiCarrier (3 sockets per PAIR); the
 *                     pool makes it 3 sockets per DEVICE, however many
 *                     pairs are armed. A lease's close() releases its
 *                     topic subscriptions; the underlying carrier closes
 *                     only after the last lease is gone (plus a linger,
 *                     so settle→rearm churn doesn't redial brokers).
 */

// ---------------------------------------------------------------------------

// Grace for an outstanding MQTT PINGREQ before the socket is declared dead.
// Longer than any realistic broker round trip, so a merely non-zero-RTT broker
// isn't torn down by a ping that raced the 30s keepalive interval.
const PING_GRACE_MS = 10000;

// Redial backoff with jitter. Every device on a shared network loses its
// broker sockets at the same instant (router reboot, broker restart), and a
// fixed [1s,2s,5s,…] ladder has them all re-dialing in synchronized waves —
// exactly the thundering herd a free public broker punishes. Up to +40% of
// the base spreads the wave; the base ladder still bounds worst-case
// reconnect latency. Pure and exported for hermetic bound tests.
const REDIAL_BACKOFF_MS = [1000, 2000, 5000, 15000, 30000];
export function redialDelay(attempt, rand = Math.random()) {
    const base = REDIAL_BACKOFF_MS[Math.min(attempt, REDIAL_BACKOFF_MS.length - 1)];
    return Math.round(base + base * 0.4 * Math.min(Math.max(rand, 0), 1));
}

// Global brake on dial ATTEMPTS across every MqttCarrier in the page: a
// sliding window that defers (never cancels) dials past the cap. Sized so the
// normal worst case — all three broker legs down and cycling their early
// backoff slots — never trips it; it only catches pathological churn (a bug
// minting fresh carriers in a loop must not turn the device into a broker
// hammer). Deliberately rate-based, NOT a concurrency cap: two hung brokers
// each eat their full 15s dial guard, and a concurrency cap would let them
// block the third, working broker — legs must dial independently.
export function makeDialBrake({ windowMs = 60000, max = 20 } = {}) {
    const stamps = [];
    return {
        shouldDefer(now) {
            while (stamps.length && now - stamps[0] > windowMs) stamps.shift();
            return stamps.length >= max;
        },
        note(now) { stamps.push(now); }
    };
}
const dialBrake = makeDialBrake();

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
                if (!ok) {
                    // Incomplete varint: wait for more bytes — unless we
                    // already hold its 4-byte maximum, in which case a
                    // terminator can never arrive (MQTT 3.1.1 protocol
                    // violation) and there is no recoverable frame boundary.
                    // Drop the stream state rather than buffer hostile bytes
                    // forever; the carrier reconnects on broker silence.
                    if (buf.length >= 5) buf = new Uint8Array(0);
                    break;
                }
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
                    const topicLen = body.length >= 2 ? ((body[0] << 8) | body[1]) : -1;
                    if (topicLen < 0 || 2 + topicLen > body.length) {
                        // Declared topic length overruns the packet body (or
                        // the body can't even hold the length prefix): a
                        // protocol violation, not a decodable publish. Emit a
                        // typed benign packet; the common slice below keeps
                        // the stream frame-synced.
                        packets.push({ type: 'other', header: buf[0] });
                    } else {
                        const topic = new TextDecoder().decode(body.subarray(2, 2 + topicLen));
                        const payloadStart = 2 + topicLen + (qos > 0 ? 2 : 0);
                        const payload = new TextDecoder().decode(body.subarray(payloadStart));
                        packets.push({ type: 'publish', topic, payload });
                    }
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

/**
 * One shared underlying carrier per device, handed out as ref-counted LEASES.
 *
 * Each lease speaks the full carrier interface (connect / publish /
 * subscribe / close / ensureAlive / assignable onSessionUp), so the
 * rendezvous episode layer — and the acceptance harness's injected test
 * carrier — need zero changes: `carrierFactory()` simply returns
 * `pool.acquire()` instead of a fresh MultiCarrier.
 *
 * Lifecycle: the underlying carrier is built lazily by `factory()` on the
 * first lease that connects (or subscribes), which is also when the test
 * hook is consulted in the launcher — never at pool construction. A lease's
 * close() releases only ITS topic callbacks; a topic is unsubscribed from
 * the underlying carrier when its last callback goes, and the underlying
 * carrier itself closes only after the LAST lease releases plus `lingerMs` —
 * an episode that settles and immediately re-arms (the common repair churn)
 * must reuse warm sockets, not redial three brokers. A lease acquired during
 * the linger cancels it.
 *
 * Topics are per-pair HMAC ids, so cross-lease callback fan-out is normally
 * 1:1; the ref counting is for correctness, not an expected sharing pattern.
 */
export class CarrierPool {
    /**
     * @param {() => object} factory - builds the underlying carrier; called
     *   lazily, and again after a linger teardown (carrier instances are
     *   single-use once closed).
     * @param {object} [opts]
     * @param {number} [opts.lingerMs] - how long the underlying carrier
     *   outlives its last lease.
     * @param {(msg: string) => void} [opts.onLog] - pool-lifecycle
     *   diagnostics (build/linger/teardown). Never load-bearing.
     */
    constructor(factory, opts = {}) {
        this.factory = factory;
        this.lingerMs = opts.lingerMs === undefined ? 45000 : opts.lingerMs;
        this.onLog = typeof opts.onLog === 'function' ? opts.onLog : null;
        this.carrier = null;         // shared underlying carrier (lazily built)
        this.leases = new Set();
        this.topics = new Map();     // topic → { cbs: Set<cb>, unsub }
        this._lingerTimer = null;
    }

    _log(msg) {
        if (this.onLog) { try { this.onLog(msg); } catch (e) {} }
    }

    _materialize() {
        if (this.carrier) return this.carrier;
        this.carrier = this.factory();
        this._log('underlying carrier built');
        // Fan a session (re)establishment out to every lease that asked —
        // each episode republishes what QoS 0 lost in the dead socket.
        this.carrier.onSessionUp = () => {
            for (const lease of this.leases) {
                if (typeof lease.onSessionUp === 'function') {
                    try { lease.onSessionUp(); } catch (e) {}
                }
            }
        };
        return this.carrier;
    }

    _dropCb(topic, cb) {
        const entry = this.topics.get(topic);
        if (!entry || !entry.cbs.delete(cb)) return;
        if (entry.cbs.size === 0) {
            this.topics.delete(topic);
            try { entry.unsub(); } catch (e) {}
        }
    }

    _release(lease) {
        if (!this.leases.delete(lease)) return;
        for (const sub of lease._subs) this._dropCb(sub.topic, sub.cb);
        lease._subs.clear();
        if (this.leases.size === 0 && this.carrier && !this._lingerTimer) {
            this._log(`last lease released — closing the carrier in ${this.lingerMs}ms unless re-acquired`);
            this._lingerTimer = setTimeout(() => {
                this._lingerTimer = null;
                if (this.leases.size || !this.carrier) return;
                this._log('linger elapsed — underlying carrier closed');
                try { this.carrier.close(); } catch (e) {}
                this.carrier = null;
                this.topics.clear();
            }, this.lingerMs);
        }
    }

    acquire() {
        const pool = this;
        if (this._lingerTimer) { clearTimeout(this._lingerTimer); this._lingerTimer = null; }
        const lease = {
            onSessionUp: null,
            _subs: new Set(),
            _released: false,
            async connect() {
                if (this._released) throw new Error('carrier lease released');
                if (pool._lingerTimer) { clearTimeout(pool._lingerTimer); pool._lingerTimer = null; }
                return pool._materialize().connect();
            },
            async publish(topic, payload) {
                if (this._released) throw new Error('carrier lease released');
                if (!pool.carrier) throw new Error('carrier not connected');
                return pool.carrier.publish(topic, payload);
            },
            subscribe(topic, cb) {
                if (this._released) return () => {};
                let entry = pool.topics.get(topic);
                if (!entry) {
                    entry = { cbs: new Set(), unsub: null };
                    pool.topics.set(topic, entry);
                    entry.unsub = pool._materialize().subscribe(topic, (payload) => {
                        for (const fn of entry.cbs) { try { fn(payload); } catch (e) {} }
                    });
                }
                entry.cbs.add(cb);
                const sub = { topic, cb };
                this._subs.add(sub);
                return () => {
                    this._subs.delete(sub);
                    pool._dropCb(topic, cb);
                };
            },
            ensureAlive() {
                if (this._released || !pool.carrier) return;
                if (typeof pool.carrier.ensureAlive === 'function') {
                    try { pool.carrier.ensureAlive(); } catch (e) {}
                }
            },
            close() {
                if (this._released) return;
                this._released = true;
                pool._release(this);
            }
        };
        this.leases.add(lease);
        return lease;
    }

    /** Immediate teardown (tests / page shutdown): no linger, leases dead. */
    close() {
        for (const lease of [...this.leases]) { try { lease.close(); } catch (e) {} }
        // The last lease's release just armed the linger — this teardown is
        // immediate, so kill it after the loop, not before.
        if (this._lingerTimer) { clearTimeout(this._lingerTimer); this._lingerTimer = null; }
        this.leases.clear();
        this.topics.clear();
        if (this.carrier) {
            try { this.carrier.close(); } catch (e) {}
            this.carrier = null;
        }
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
        if (dialBrake.shouldDefer(Date.now())) {
            // Deferred, not dropped: retry shortly without consuming a
            // backoff slot (the brake is about page-wide rate, not this
            // broker's health).
            this._log('dial deferred (page-wide redial brake)');
            if (!this._redialTimer) {
                this._redialTimer = setTimeout(() => {
                    this._redialTimer = null;
                    this._dial();
                }, 1000 + Math.random() * 1000);
            }
            return;
        }
        dialBrake.note(Date.now());
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
        this._pingSentAt = 0;
        this.pingTimer = setInterval(() => {
            const now = Date.now();
            if (this._awaitingPong) {
                // Only declare the socket dead once the outstanding PINGREQ has
                // gone unanswered past the grace — NOT the instant this interval
                // happens to fire just after ensureAlive() sent a fresh ping on a
                // healthy, non-zero-RTT broker (that race tore down good sessions).
                if (now - this._pingSentAt > PING_GRACE_MS) { this._lost(ws); return; }
                return; // still within grace — keep waiting, don't double-ping
            }
            this._awaitingPong = true;
            this._pingSentAt = now;
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
        this._redialTimer = setTimeout(() => {
            this._redialTimer = null;
            this._dial();
        }, redialDelay(this._backoffIdx++));
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
        this._pingSentAt = Date.now();
        const sentAt = this._pingSentAt;
        setTimeout(() => {
            // Only if THIS ping is still the outstanding one and still unanswered.
            if (this.ws === ws && this._awaitingPong && this._pingSentAt === sentAt) this._lost(ws);
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
