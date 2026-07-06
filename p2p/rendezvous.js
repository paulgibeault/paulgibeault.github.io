/* rendezvous.js — automatic reconnection through an untrusted dead-drop.
 * Formal description: PROTOCOL.md §7; design rationale: RECONNECT_RENDEZVOUS.md.
 *
 * A pair of devices that completed one manual ceremony can re-signal a fresh
 * connection through any carrier (public MQTT broker, BroadcastChannel, …)
 * without a human carrying the payloads: everything published is AEAD-sealed
 * with keys born on the original DTLS channel, topics are unlinkable daily
 * HMACs, epochs stop replays, and a ratchet retires the keys on every
 * successful reconnect.
 *
 * Lifecycle:
 *   PAIRING     enablePair(peerId, pairId) on BOTH sides while connected →
 *               32-byte randoms cross as 'rdv' extension control frames →
 *               both derive pairBase_0, roles (lower random hex = caller),
 *               and persist {base, role, epoch} in IndexedDB.
 *   TRIGGER     link 'interrupted' longer than a delay (listener 15s /
 *               caller 30s — gives v1.7 in-band repair first claim), or a
 *               terminal 'disconnected', or resumeAll() after a restart.
 *   EPISODE     caller: builds a SHADOW connection (live entry untouched),
 *               publishes the sealed offer on the day topics with backoff;
 *               listener: subscribes, answers valid offers, adopts.
 *               First side to see the new channel open settles: ratchet,
 *               persist epoch, close the carrier.
 *   ADOPTION    PeerManager.adoptConnection resumes the old session (seq
 *               counters + outbox) under the same peerId — apps just see
 *               interrupted → connected and queued traffic replays.
 *
 * Security invariants:
 *   - decrypt-then-parse: blobs that fail AEAD are silence, not errors.
 *   - AAD binds direction ('o'/'a') + epoch: reflected or replayed blobs
 *     never authenticate.
 *   - An episode ratchets ONLY when a sealed exchange actually completed
 *     (ep.exchanged) — an in-band recovery that wins the race must not
 *     advance the key on one side only.
 *   - Pairing randoms ride the DTLS-authenticated control channel of a
 *     manually-ceremonied link, and are held only until derivation.
 */

import { RendezvousCrypto as RC } from './rendezvous-crypto.js';
import { ConnectionUtils } from './p2p-core.js';

const DB_NAME = 'qrp2p-rendezvous';
const DB_STORE = 'pairs';

function dbOpen() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}
async function dbGet(key) {
    const db = await dbOpen();
    try {
        return await new Promise((resolve, reject) => {
            const req = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    } finally { db.close(); }
}
async function dbPut(key, value) {
    const db = await dbOpen();
    try {
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(DB_STORE, 'readwrite');
            tx.objectStore(DB_STORE).put(value, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } finally { db.close(); }
}
async function dbDelete(key) {
    const db = await dbOpen();
    try {
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(DB_STORE, 'readwrite');
            tx.objectStore(DB_STORE).delete(key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } finally { db.close(); }
}
async function dbEntries() {
    const db = await dbOpen();
    try {
        return await new Promise((resolve, reject) => {
            const store = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE);
            const keysReq = store.getAllKeys();
            const valsReq = store.getAll();
            let keys = null, vals = null;
            const done = () => { if (keys && vals) resolve(keys.map((k, i) => [k, vals[i]])); };
            keysReq.onsuccess = () => { keys = keysReq.result; done(); };
            valsReq.onsuccess = () => { vals = valsReq.result; done(); };
            keysReq.onerror = () => reject(keysReq.error);
            valsReq.onerror = () => reject(valsReq.error);
        });
    } finally { db.close(); }
}

function b64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
}
function unb64(str) {
    try {
        const bin = atob(str);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    } catch (e) { return null; }
}
function hex(bytes) {
    return Array.from(bytes, x => x.toString(16).padStart(2, '0')).join('');
}

function waitGathering(pc, timeoutMs = 10000) {
    return new Promise((resolve) => {
        if (pc.iceGatheringState === 'complete') return resolve();
        let timer;
        const check = () => {
            if (pc.iceGatheringState === 'complete') {
                pc.removeEventListener('icegatheringstatechange', check);
                clearTimeout(timer);
                resolve();
            }
        };
        pc.addEventListener('icegatheringstatechange', check);
        timer = setTimeout(() => {
            pc.removeEventListener('icegatheringstatechange', check);
            resolve();
        }, timeoutMs);
    });
}

export class RendezvousManager extends EventTarget {
    /**
     * @param {PeerManager} peerManager
     * @param {object} options
     * @param {() => Carrier} options.carrierFactory - REQUIRED. Fresh carrier per episode.
     * @param {number} [options.listenerDelayMs=15000]  - interrupted → listener episode
     * @param {number} [options.callerDelayMs=30000]    - interrupted → caller episode
     * @param {number} [options.episodeTimeoutMs=600000]
     * @param {number[]} [options.retryScheduleMs]      - caller publish backoff; last entry repeats
     * @param {number} [options.resumeWindowMs=21600000] - resumeAll() freshness window (6h)
     */
    constructor(peerManager, options = {}) {
        super();
        this.pm = peerManager;
        this.options = {
            carrierFactory: options.carrierFactory || null,
            listenerDelayMs: options.listenerDelayMs ?? 15000,
            callerDelayMs: options.callerDelayMs ?? 30000,
            episodeTimeoutMs: options.episodeTimeoutMs ?? 600000,
            retryScheduleMs: options.retryScheduleMs || [0, 5000, 30000, 120000, 300000],
            resumeWindowMs: options.resumeWindowMs ?? 6 * 3600 * 1000
        };
        this.pairsByPeerId = new Map(); // peerId → pairId
        this.myRands = new Map();       // peerId → {pairId, rand}
        this.pendingRands = new Map();  // peerId → {pairId, rand} (their offer awaiting our opt-in)
        this.episodes = new Map();      // pairId → episode
        this.delayTimers = new Map();   // pairId → clearFn

        this._onExtBound = (e) => this._onExt(e.detail || {});
        this._onStatusBound = (e) => this._onStatus(e.detail || {});
        this.pm.addEventListener('control-ext', this._onExtBound);
        this.pm.addEventListener('status', this._onStatusBound);
    }

    destroy() {
        this.pm.removeEventListener('control-ext', this._onExtBound);
        this.pm.removeEventListener('status', this._onStatusBound);
        for (const [pairId, ep] of this.episodes) this._cleanupEpisode(pairId, ep);
        for (const clear of this.delayTimers.values()) clear();
        this.delayTimers.clear();
        this.myRands.clear();
        this.pendingRands.clear();
    }

    _emit(type, detail) {
        this.dispatchEvent(new CustomEvent(type, { detail }));
    }

    // ---- pairing -----------------------------------------------------------

    /**
     * Establishes (or refreshes) the pair secret with the device on `peerId`,
     * stored locally under `pairId` — an app-chosen LOCAL label (the launcher
     * uses the REMOTE device's id, so the two sides naturally use different
     * labels; the exchange correlates by link, never by label). BOTH sides
     * must call this — completion happens when both randoms have crossed.
     * Re-running on a later manual ceremony mints a fresh secret (every
     * physical meeting is a new trust event).
     */
    async enablePair(peerId, pairId) {
        this._cancelEpisode(pairId); // a manual re-pair supersedes any repair attempt
        const rand = RC.randBytes(32);
        this.myRands.set(peerId, { pairId, rand });
        this.pm.sendExt(peerId, 'rdv', { t: 'pair', v: 1, rand: b64(rand) });
        const pending = this.pendingRands.get(peerId);
        if (pending) {
            await this._completePairing(peerId, pairId, rand, pending.rand);
        }
    }

    /** Forgets the pair entirely (secret, role, epoch). */
    async disablePair(pairId) {
        this._cancelEpisode(pairId);
        for (const [pid, pr] of this.pairsByPeerId) {
            if (pr === pairId) this.pairsByPeerId.delete(pid);
        }
        await dbDelete(pairId);
        this._emit('pair-removed', { pairId });
    }

    async _onExt({ peerId, ns, data }) {
        if (ns !== 'rdv' || !data || data.t !== 'pair') return;
        const theirRand = typeof data.rand === 'string' ? unb64(data.rand) : null;
        if (!theirRand || theirRand.length !== 32) return;
        const mine = this.myRands.get(peerId);
        if (mine) {
            await this._completePairing(peerId, mine.pairId, mine.rand, theirRand);
        } else {
            // Their side opted in; ours hasn't (yet). Hold the random and let
            // the app decide — enablePair() later completes the exchange.
            this.pendingRands.set(peerId, { rand: theirRand });
            this._emit('pair-request', { peerId });
        }
    }

    async _completePairing(peerId, pairId, myRand, theirRand) {
        const base = await RC.derivePairBase(myRand, theirRand);
        const role = hex(myRand) < hex(theirRand) ? 'caller' : 'listener';
        const rec = {
            base, role, epoch: 0, enabled: true,
            pairedAt: Date.now(), lastPeerId: peerId, lastSeenAt: Date.now()
        };
        await dbPut(pairId, rec);
        this.myRands.delete(peerId);
        this.pendingRands.delete(peerId);
        this.pairsByPeerId.set(peerId, pairId);
        this._emit('pair-established', { pairId, peerId, role });
    }

    // ---- triggers ----------------------------------------------------------

    _onStatus({ peerId, status }) {
        const pairId = this.pairsByPeerId.get(peerId);
        if (!pairId) return;
        if (status === 'connected') {
            this._clearDelay(pairId);
            const ep = this.episodes.get(pairId);
            if (ep && !ep.settled) {
                this._settleEpisode(pairId, ep);
            } else {
                dbGet(pairId).then(rec => {
                    if (!rec) return;
                    rec.lastPeerId = peerId;
                    rec.lastSeenAt = Date.now();
                    return dbPut(pairId, rec);
                }).catch(() => {});
            }
        } else if (status === 'interrupted') {
            this._scheduleEpisode(pairId, peerId);
        } else if (status === 'disconnected' || status === 'failed' || status === 'closed') {
            this._clearDelay(pairId);
            this._startEpisode(pairId, peerId);
        }
    }

    _clearDelay(pairId) {
        const clear = this.delayTimers.get(pairId);
        if (clear) { clear(); this.delayTimers.delete(pairId); }
    }

    _scheduleEpisode(pairId, peerId) {
        if (this.delayTimers.has(pairId) || this.episodes.has(pairId)) return;
        // Give the v1.7 in-band machinery first claim on the repair. The
        // listener side is passive (subscribe only) so it starts sooner; the
        // caller's shadow offer waits longer.
        const t1 = setTimeout(async () => {
            this.delayTimers.delete(pairId);
            const rec = await dbGet(pairId).catch(() => null);
            if (!rec || !rec.enabled) return;
            const live = this.pm.peers.get(peerId);
            if (live && live.status === 'connected') return;
            if (rec.role === 'listener') {
                this._startEpisode(pairId, peerId);
            } else {
                const extra = Math.max(0, this.options.callerDelayMs - this.options.listenerDelayMs);
                const t2 = setTimeout(() => {
                    this.delayTimers.delete(pairId);
                    const nowLive = this.pm.peers.get(peerId);
                    if (nowLive && nowLive.status === 'connected') return;
                    this._startEpisode(pairId, peerId);
                }, extra);
                this.delayTimers.set(pairId, () => clearTimeout(t2));
            }
        }, this.options.listenerDelayMs);
        this.delayTimers.set(pairId, () => clearTimeout(t1));
    }

    /**
     * Call once at app startup: resumes repair for any enabled pair seen
     * recently — this is what reconnects two devices whose browsers were
     * both killed and reopened, with zero human involvement.
     */
    async resumeAll() {
        let entries = [];
        try { entries = await dbEntries(); } catch (e) { return; }
        for (const [pairId, rec] of entries) {
            if (!rec || !rec.enabled || !rec.lastPeerId) continue;
            if (Date.now() - (rec.lastSeenAt || 0) > this.options.resumeWindowMs) continue;
            this.pairsByPeerId.set(rec.lastPeerId, pairId);
            this._startEpisode(pairId, rec.lastPeerId);
        }
    }

    // ---- episodes ----------------------------------------------------------

    _after(ep, ms, fn) {
        const id = setTimeout(fn, ms);
        ep.timers.push(() => clearTimeout(id));
    }
    _every(ep, ms, fn) {
        const id = setInterval(fn, ms);
        ep.timers.push(() => clearInterval(id));
    }

    async _topics(ep) {
        const days = RC.daysAround(Date.now());
        const out = [];
        for (const d of days) out.push(await RC.topicForDay(ep.topicKey, d));
        return [...new Set(out)];
    }

    async _startEpisode(pairId, peerId) {
        if (this.episodes.has(pairId) || !this.options.carrierFactory) return;
        const rec = await dbGet(pairId).catch(() => null);
        if (!rec || !rec.enabled) return;
        const ep = {
            peerId, rec, settled: false, exchanged: false, usedEpoch: null,
            carrier: null, shadow: null, timers: [], unsubs: []
        };
        this.episodes.set(pairId, ep);
        try {
            ep.carrier = this.options.carrierFactory();
            await ep.carrier.connect();
            ep.topicKey = await RC.deriveTopicKey(rec.base);
            ep.aeadKey = await RC.deriveAeadKey(rec.base);
            this._emit('reconnecting', { pairId, peerId, role: rec.role });
            if (rec.role === 'caller') await this._runCaller(pairId, ep);
            else await this._runListener(pairId, ep);
            this._after(ep, this.options.episodeTimeoutMs, () => this._failEpisode(pairId, ep, 'timeout'));
        } catch (e) {
            this._failEpisode(pairId, ep, e.message);
        }
    }

    async _runCaller(pairId, ep) {
        ep.usedEpoch = (ep.rec.epoch || 0) + 1;
        // Shadow connection: the live entry (possibly still self-repairing
        // in-band) is untouched until a sealed answer actually arrives.
        await this.pm._ensureCertificate();
        const pc = new RTCPeerConnection(this.pm._buildRtcConfig());
        const dc = pc.createDataChannel('data');
        ep.shadow = { pc, dc, adopted: false };
        await pc.setLocalDescription(await pc.createOffer());
        await waitGathering(pc);
        const payload = JSON.stringify({
            peerId: ep.peerId,
            sessionDesc: { type: pc.localDescription.type, sdp: ConnectionUtils.minifySDP(pc.localDescription.sdp, this.pm.options) }
        });
        ep.sealedOffer = await RC.seal(ep.aeadKey, await ConnectionUtils.encodePayload(payload), 'o', ep.usedEpoch);

        for (const t of await this._topics(ep)) {
            ep.unsubs.push(ep.carrier.subscribe(t, (blob) => { this._onCallerBlob(pairId, ep, blob); }));
        }
        const publishOnce = async () => {
            if (ep.settled) return;
            try {
                await ep.carrier.publish(await RC.topicForDay(ep.topicKey, RC.dayString(Date.now())), ep.sealedOffer);
            } catch (e) {}
        };
        const schedule = this.options.retryScheduleMs;
        schedule.forEach(ms => this._after(ep, ms, publishOnce));
        this._every(ep, schedule[schedule.length - 1] || 300000, publishOnce);
    }

    async _onCallerBlob(pairId, ep, blob) {
        if (ep.settled || ep.exchanged) return;
        const packed = await RC.open(ep.aeadKey, blob, 'a', ep.usedEpoch);
        if (packed === null) return; // not for us / tampered / our own offer echoed — silence
        let payload;
        try { payload = await ConnectionUtils.decodePayload(packed); } catch (e) { return; }
        if (payload.peerId !== ep.peerId) return;
        const live = this.pm.peers.get(ep.peerId);
        if (live && live.status === 'connected') {
            // In-band repair won the race while the answer was in flight —
            // keep the healed link, drop the shadow, no ratchet.
            this._settleEpisode(pairId, ep);
            return;
        }
        ep.exchanged = true;
        this.pm.adoptConnection(ep.peerId, ep.shadow.pc, ep.shadow.dc, { fallbackType: 'client' });
        ep.shadow.adopted = true;
        await this.pm.acceptAnswer(payload);
        // status 'connected' (channel open) settles + ratchets.
    }

    async _runListener(pairId, ep) {
        for (const t of await this._topics(ep)) {
            ep.unsubs.push(ep.carrier.subscribe(t, (blob) => { this._onListenerBlob(pairId, ep, blob); }));
        }
    }

    async _onListenerBlob(pairId, ep, blob) {
        if (ep.settled || ep.exchanged) return;
        // Accept a small epoch window: if we crashed after a success before
        // persisting, the caller may be one or two epochs ahead of our record.
        const base = ep.rec.epoch || 0;
        let packed = null, usedEpoch = null;
        for (let e = base + 1; e <= base + 3; e++) {
            packed = await RC.open(ep.aeadKey, blob, 'o', e);
            if (packed !== null) { usedEpoch = e; break; }
        }
        if (packed === null) return;
        let payload;
        try { payload = await ConnectionUtils.decodePayload(packed); } catch (e) { return; }
        ep.exchanged = true;
        ep.usedEpoch = usedEpoch;
        ep.peerId = payload.peerId;
        this.pairsByPeerId.set(payload.peerId, pairId);

        await this.pm._ensureCertificate();
        const pc = new RTCPeerConnection(this.pm._buildRtcConfig());
        await pc.setRemoteDescription(new RTCSessionDescription(payload.sessionDesc));
        await pc.setLocalDescription(await pc.createAnswer());
        await waitGathering(pc);
        // Adopt now so ondatachannel and the resilience handlers are wired
        // before connectivity completes. The caller committed by publishing;
        // any interrupted remnant is superseded.
        this.pm.adoptConnection(payload.peerId, pc, null, { fallbackType: 'host' });

        const answerPayload = JSON.stringify({
            peerId: payload.peerId,
            sessionDesc: { type: pc.localDescription.type, sdp: ConnectionUtils.minifySDP(pc.localDescription.sdp, this.pm.options) }
        });
        const sealed = await RC.seal(ep.aeadKey, await ConnectionUtils.encodePayload(answerPayload), 'a', usedEpoch);
        const publishAnswer = async () => {
            if (ep.settled) return;
            try {
                await ep.carrier.publish(await RC.topicForDay(ep.topicKey, RC.dayString(Date.now())), sealed);
            } catch (e) {}
        };
        await publishAnswer();
        [3000, 10000, 30000].forEach(ms => this._after(ep, ms, publishAnswer));
    }

    async _settleEpisode(pairId, ep) {
        if (ep.settled) return;
        ep.settled = true;
        if (ep.exchanged) {
            // Ratchet — but ONLY for a reconnect that actually went through
            // the sealed exchange, so both sides advance in lockstep.
            const own = this.pm.getOwnFingerprint(ep.peerId);
            const theirs = this.pm.getPeerFingerprint(ep.peerId);
            if (own && theirs) {
                ep.rec.base = await RC.ratchet(ep.rec.base, await RC.transcriptHash(own, theirs));
                ep.rec.epoch = ep.usedEpoch;
            }
        }
        ep.rec.lastPeerId = ep.peerId;
        ep.rec.lastSeenAt = Date.now();
        try { await dbPut(pairId, ep.rec); } catch (e) {}
        this._cleanupEpisode(pairId, ep);
        this._emit(ep.exchanged ? 'reconnected' : 'recovered-inband', { pairId, peerId: ep.peerId });
    }

    _failEpisode(pairId, ep, why) {
        if (ep.settled) return;
        ep.settled = true;
        this._cleanupEpisode(pairId, ep);
        this._emit('gave-up', { pairId, peerId: ep.peerId, why });
    }

    _cancelEpisode(pairId) {
        this._clearDelay(pairId);
        const ep = this.episodes.get(pairId);
        if (ep) {
            ep.settled = true;
            this._cleanupEpisode(pairId, ep);
        }
    }

    _cleanupEpisode(pairId, ep) {
        for (const clear of ep.timers) clear();
        ep.timers = [];
        for (const unsub of ep.unsubs) { try { unsub(); } catch (e) {} }
        ep.unsubs = [];
        if (ep.shadow && !ep.shadow.adopted) {
            try { ep.shadow.pc.close(); } catch (e) {}
        }
        if (ep.carrier) { try { ep.carrier.close(); } catch (e) {} ep.carrier = null; }
        this.episodes.delete(pairId);
    }
}

export default RendezvousManager;
