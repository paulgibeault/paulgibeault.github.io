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
 *               terminal 'disconnected', or resumeAll() after a restart, or
 *               resumePair() (the app's explicit "call this peer now").
 *   EPISODE     caller: builds a SHADOW connection (live entry untouched),
 *               publishes the sealed offer on the day topics with backoff;
 *               listener: publishes a sealed RING (a doorbell asking the
 *               caller role for a fresh offer) and answers valid offers.
 *               First side to see the new channel open settles: ratchet,
 *               persist epoch, close the carrier.
 *   QUIET       after `episodeTimeoutMs` an episode DEMOTES instead of dying:
 *               it emits 'gave-up' (so UIs and wake locks release the active
 *               session claim) but stays subscribed and keeps a slow
 *               republish going (bounded by `resumeWindowMs` since the pair
 *               was last seen). A device with the app open therefore stays
 *               REACHABLE — the other side's ring or offer lands hours later.
 *   STANDBY     standbyAll() (or a received 'bye') arms subscribe-only
 *               episodes: nothing is initiated, but a ring provokes the
 *               caller role to arm and publish an offer, and an offer gets
 *               answered. This is what lets one side "call" a peer whose app
 *               is merely open. Privacy trade, documented in §7.5/§9: an
 *               enabled, disconnected pair keeps a standing (pseudonymous,
 *               daily-rotating) subscription on the carrier.
 *   ADOPTION    PeerManager.adoptConnection resumes the old session (seq
 *               counters + outbox) under the same peerId — apps just see
 *               interrupted → connected and queued traffic replays.
 *   BYE         sendBye(peerId) tells the remote this link is being closed
 *               ON PURPOSE (a hang-up, not a failure): the receiver cancels
 *               any repair, records rec.byeAt, and future episodes start as
 *               quiet STANDBY until the pair reconnects or the remote calls
 *               back. pausePair()/resumePair() are the local half: suspend
 *               repair without forgetting the secret / re-arm and try now.
 *               Both halves PERSIST (IndexedDB): a hung-up pair stays hung
 *               up across app restarts until its user calls again, and the
 *               stored secret keeps that call ceremony-free.
 *
 * Security invariants:
 *   - decrypt-then-parse: blobs that fail AEAD are silence, not errors.
 *   - AAD binds direction ('o'/'a'/'r') + epoch: reflected or replayed blobs
 *     never authenticate as a different frame kind or epoch.
 *   - Offers carry a random `n` (nonce) echoed by answers; rings carry their
 *     own. A blob replayed WITHIN its epoch window (the relay may delay or
 *     duplicate anything) can therefore never wedge an episode: stale
 *     answers fail the nonce check, duplicate offers/rings are dropped, and
 *     an answered offer that never connects is retired after
 *     `answerStallMs` instead of deafening the episode until timeout.
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

// Epoch acceptance window above the completed epoch (crash-recovery skew).
const EPOCH_WINDOW = 3;

export class RendezvousManager extends EventTarget {
    /**
     * @param {PeerManager} peerManager
     * @param {object} options
     * @param {() => Carrier} options.carrierFactory - REQUIRED. Fresh carrier per episode.
     * @param {number} [options.listenerDelayMs=15000]  - interrupted → listener episode
     * @param {number} [options.callerDelayMs=30000]    - interrupted → caller episode
     * @param {number} [options.episodeTimeoutMs=600000] - active phase → quiet demotion
     * @param {number[]} [options.retryScheduleMs]      - publish backoff; last entry repeats
     * @param {number} [options.resumeWindowMs=21600000] - resumeAll() freshness window (6h);
     *                                                     also bounds quiet-phase republishing
     * @param {number} [options.answerStallMs=30000]    - retire an exchange that never connects
     * @param {number} [options.rearmDelayMs=60000]     - retry delay after a hard episode error
     * @param {number} [options.standbyMaxAgeMs]        - standbyAll() skips pairs unseen this long (30d)
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
            resumeWindowMs: options.resumeWindowMs ?? 6 * 3600 * 1000,
            answerStallMs: options.answerStallMs ?? 30000,
            rearmDelayMs: options.rearmDelayMs ?? 60000,
            standbyMaxAgeMs: options.standbyMaxAgeMs ?? 30 * 24 * 3600 * 1000
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

    /**
     * Diagnostic stream (same shape as PeerManager's): human-readable
     * episode-lifecycle lines for a connection log. Never load-bearing.
     */
    _diag(msg, type = 'info') {
        this.dispatchEvent(new CustomEvent('diagnostic', { detail: { type, msg } }));
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
        // Bind the live link to the pair NOW, not just on completion: the
        // liveness checks (resumePair's "already connected", episode gating)
        // must see the current link, or they judge the pair by a stale
        // lastPeerId and arm pointless episodes against a connected peer.
        this.pairsByPeerId.set(peerId, pairId);
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

    /**
     * Suspends automatic repair for a pair WITHOUT forgetting its secret —
     * cancels any in-flight episode (including a quiet standby: a paused
     * device is deliberately unreachable) and clears `enabled` in storage,
     * so `_onStatus`/`resumeAll`/`standbyAll` skip it until resumePair()
     * re-arms it. This is the "pause a connection" primitive: unlike
     * disablePair(), a later resumePair() needs no new ceremony.
     */
    async pausePair(pairId) {
        this._cancelEpisode(pairId);
        const rec = await dbGet(pairId).catch(() => null);
        if (!rec) return false;
        rec.enabled = false;
        await dbPut(pairId, rec);
        return true;
    }

    /**
     * Re-arms a paused pair and immediately attempts a reconnect episode
     * against its last known peerId — the "call this peer now" primitive.
     * Clears any received bye (calling back overrides the remote's hang-up)
     * and supersedes a quiet/standby episode with a fully active one. The
     * attempt succeeds whenever the other device is reachable on the
     * dead-drop: actively repairing, quietly standing by, or merely having
     * the app open with the pair enabled.
     */
    async resumePair(pairId) {
        const rec = await dbGet(pairId).catch(() => null);
        if (!rec) {
            this._diag(`pair ${pairId}: resumePair found no stored secret — nothing to call with`, 'warn');
            return false;
        }
        rec.enabled = true;
        delete rec.byeAt;
        await dbPut(pairId, rec);
        if (rec.lastPeerId) {
            this.pairsByPeerId.set(rec.lastPeerId, pairId);
            if (this._connectedPeerIdFor(pairId)) {
                this._diag(`pair ${pairId}: resumePair (call) — already connected, nothing to ring`);
                return true;
            }
            const ep = this.episodes.get(pairId);
            if (ep && !ep.settled) {
                // An episode already holds this pair's carrier, subscriptions
                // and nonces — and the peer may be answering those nonces
                // RIGHT NOW (its answer takes seconds of ICE gathering).
                // Cancelling and restarting here would orphan that in-flight
                // exchange, so repeated Call presses used to chase each other
                // in circles (seen in field logs: three Calls in 8s, each
                // rotating the offer nonce the other side was answering).
                // Promote/republish the existing episode in place instead.
                this._diag(`pair ${pairId}: resumePair (call) — episode already running, promoting it in place`);
                ep.rec.enabled = true;
                delete ep.rec.byeAt;
                await this._promoteEpisode(pairId, ep);
            } else {
                this._diag(`pair ${pairId}: resumePair (call) — arming an active episode`);
                this._startEpisode(pairId, rec.lastPeerId);
            }
        }
        return true;
    }

    /**
     * Escalates an existing episode to fully-active on a user Call: quiet and
     * standby episodes start initiating, an active one just republishes now.
     * The carrier, subscriptions, dedup state and any in-flight exchange all
     * survive — a Call must never destroy the handshake it's asking for.
     */
    async _promoteEpisode(pairId, ep) {
        ep.standbyOnly = false;
        if (ep.phase !== 'active') {
            ep.phase = 'active';
            // A promoted episode earns a fresh active window before demoting.
            this._after(ep, this.options.episodeTimeoutMs, () => this._demoteEpisode(pairId, ep));
        }
        if (!ep.announced) {
            ep.announced = true;
            this._emit('reconnecting', { pairId, peerId: ep.peerId, role: ep.rec.role });
        }
        // An answer/adoption is in flight — let it finish; its stall timer
        // re-arms if it never connects.
        if (ep.exchanged) return;
        try {
            if (ep.rec.role === 'caller') {
                // Fresh shadow only if we have none or ours has aged (same
                // rule as a received ring) — a fresh nonce invalidates the
                // offer the listener may currently be answering.
                if (!ep.sealedOffer || Date.now() - ep.lastShadowAt > 30000) {
                    await this._armCallerOffer(pairId, ep);
                }
            } else if (!ep.sealedRing) {
                await this._armRing(pairId, ep);
            }
            this._schedulePublishes(pairId, ep);
            if (ep.publishOnce) await ep.publishOnce();
        } catch (e) {
            this._diag(`pair ${pairId}: could not arm/publish on promote (${e && e.message})`, 'warn');
        }
    }

    /**
     * Tells the device on `peerId` that this link is being closed ON PURPOSE
     * (a hang-up, not a failure), so it doesn't burn a repair episode on it.
     * Send BEFORE disconnecting the link — it rides the live control channel.
     */
    sendBye(peerId) {
        try { return this.pm.sendExt(peerId, 'rdv', { t: 'bye', v: 1 }); }
        catch (e) { return false; }
    }

    async _onExt({ peerId, ns, data }) {
        if (ns !== 'rdv' || !data) return;
        if (data.t === 'bye') { await this._onBye(peerId); return; }
        if (data.t !== 'pair') return;
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

    async _onBye(peerId) {
        const pairId = this.pairsByPeerId.get(peerId);
        if (!pairId) return;
        // The peer is hanging up deliberately: stop any repair, and remember
        // the bye so the teardown that follows starts a quiet STANDBY
        // (reachable for a call-back) instead of an active repair episode.
        this._diag(`pair ${pairId}: remote hung up on purpose (bye) — future episodes start as quiet standby`);
        this._cancelEpisode(pairId);
        const rec = await dbGet(pairId).catch(() => null);
        if (rec) {
            rec.byeAt = Date.now();
            await dbPut(pairId, rec).catch(() => {});
        }
        this._emit('remote-bye', { pairId, peerId });
    }

    async _completePairing(peerId, pairId, myRand, theirRand) {
        const base = await RC.derivePairBase(myRand, theirRand);
        const role = hex(myRand) < hex(theirRand) ? 'caller' : 'listener';
        const rec = {
            base, role, epoch: 0, enabled: true,
            pairedAt: Date.now(), lastPeerId: peerId, lastSeenAt: Date.now()
        };
        try {
            await dbPut(pairId, rec);
        } catch (e) {
            // A pair that can't persist can't auto-reconnect after a restart
            // (and the OTHER side thinks it can) — never let this be silent.
            this._diag(`pair ${pairId}: FAILED to persist pairing secret (${e && e.message}) — auto-reconnect will not work from this device`, 'error');
            throw e;
        }
        this.myRands.delete(peerId);
        this.pendingRands.delete(peerId);
        this.pairsByPeerId.set(peerId, pairId);
        // A fresh secret supersedes ANY in-flight episode: an episode armed
        // before this exchange still holds the OLD base/role/epoch, so its
        // publishes ride retired topics and keys — and worse, it occupies
        // the pair's one episode slot, blocking every future repair from
        // using the new secret until the app restarts. enablePair() cancels
        // on ITS side, but a resumePair() racing in between (seen in field
        // logs: the launcher's enable-auto-reconnect calls resumePair first)
        // re-arms with the old record; completion is the last safe gate.
        if (this.episodes.has(pairId)) {
            this._diag(`pair ${pairId}: fresh secret supersedes the in-flight episode (it held the old key) — cancelling it`);
            this._cancelEpisode(pairId);
        }
        this._diag(`pair ${pairId}: secret established (role=${role}, epoch 0)`);
        this._emit('pair-established', { pairId, peerId, role });
    }

    // ---- triggers ----------------------------------------------------------

    /**
     * The pair's CURRENTLY connected transport peerId, or null. A device
     * reconnected by a fresh manual ceremony gets a NEW peerId, so liveness
     * must be judged across every peerId ever mapped to the pair — checking
     * only rec.lastPeerId sees a dead link and arms pointless episodes.
     */
    _connectedPeerIdFor(pairId) {
        for (const [pid, pr] of this.pairsByPeerId) {
            if (pr !== pairId) continue;
            const p = this.pm.peers.get(pid);
            if (p && p.status === 'connected') return pid;
        }
        return null;
    }

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
                    delete rec.byeAt; // a live link supersedes any old hang-up
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
        this._diag(`pair ${pairId}: link interrupted — rendezvous episode in ${this.options.listenerDelayMs / 1000}s (listener) / ${this.options.callerDelayMs / 1000}s (caller) unless in-band repair wins`);
        // Give the v1.7 in-band machinery first claim on the repair. The
        // listener side is passive (subscribe + ring) so it starts sooner;
        // the caller's shadow offer waits longer.
        const t1 = setTimeout(async () => {
            this.delayTimers.delete(pairId);
            const rec = await dbGet(pairId).catch(() => null);
            if (!rec || !rec.enabled) return;
            if (this._connectedPeerIdFor(pairId)) return;
            if (rec.role === 'listener') {
                this._startEpisode(pairId, peerId);
            } else {
                const extra = Math.max(0, this.options.callerDelayMs - this.options.listenerDelayMs);
                const t2 = setTimeout(() => {
                    this.delayTimers.delete(pairId);
                    if (this._connectedPeerIdFor(pairId)) return;
                    this._startEpisode(pairId, peerId);
                }, extra);
                this.delayTimers.set(pairId, () => clearTimeout(t2));
            }
        }, this.options.listenerDelayMs);
        this.delayTimers.set(pairId, () => clearTimeout(t1));
    }

    /**
     * Call once at app startup: resumes ACTIVE repair for any enabled pair
     * seen recently — this is what reconnects two devices whose browsers
     * were both killed and reopened, with zero human involvement.
     */
    async resumeAll() {
        let entries = [];
        try { entries = await dbEntries(); } catch (e) {
            this._diag(`resumeAll: could not read pair store (${e && e.message}) — nothing to resume`, 'warn');
            return;
        }
        this._diag(`resumeAll: ${entries.length} stored pair(s)`);
        for (const [pairId, rec] of entries) {
            if (!rec || !rec.enabled || !rec.lastPeerId) {
                this._diag(`pair ${pairId}: skipped (${!rec ? 'empty record' : !rec.enabled ? 'disabled/paused' : 'never connected'})`);
                continue;
            }
            const age = Date.now() - (rec.lastSeenAt || 0);
            if (age > this.options.resumeWindowMs) {
                this._diag(`pair ${pairId}: outside resume window (last seen ${Math.round(age / 60000)}m ago) — not resumed`);
                continue;
            }
            this.pairsByPeerId.set(rec.lastPeerId, pairId);
            this._startEpisode(pairId, rec.lastPeerId);
        }
    }

    /**
     * Call at app startup when resumeAll()'s freshness window has lapsed:
     * arms subscribe-only STANDBY for every enabled pair, so this device can
     * be "called" (resumePair() on the other side) for as long as the app
     * stays open — without initiating anything itself.
     */
    async standbyAll() {
        let entries = [];
        try { entries = await dbEntries(); } catch (e) {
            this._diag(`standbyAll: could not read pair store (${e && e.message})`, 'warn');
            return;
        }
        this._diag(`standbyAll: ${entries.length} stored pair(s)`);
        for (const [pairId, rec] of entries) {
            if (!rec || !rec.enabled || !rec.lastPeerId) continue;
            if (Date.now() - (rec.lastSeenAt || 0) > this.options.standbyMaxAgeMs) continue;
            this.pairsByPeerId.set(rec.lastPeerId, pairId);
            this._startEpisode(pairId, rec.lastPeerId, { standbyOnly: true });
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

    /**
     * One episode per pair, from trigger until settle/cancel. Phases:
     *   active — initiating (offer or ring on the retry schedule) with the
     *            session publicly claimed ('reconnecting' emitted);
     *   quiet  — after episodeTimeoutMs: 'gave-up' emitted (UIs release the
     *            claim) but the subscription stays and the slow republish
     *            continues while the pair was seen within resumeWindowMs.
     * standbyOnly episodes start quiet and initiate nothing until a ring
     * (caller role) or an offer (listener role) provokes them. A received
     * bye forces standbyOnly regardless of opts.
     */
    async _startEpisode(pairId, peerId, opts = {}) {
        if (this.episodes.has(pairId) || !this.options.carrierFactory) return;
        const rec = await dbGet(pairId).catch(() => null);
        if (!rec || !rec.enabled) {
            this._diag(`pair ${pairId}: episode not started (${!rec ? 'no stored secret' : 'pair disabled/paused'})`);
            return;
        }
        if (this._connectedPeerIdFor(pairId)) return;
        const byed = !!(rec.byeAt && rec.byeAt > (rec.lastSeenAt || 0));
        const standbyOnly = !!opts.standbyOnly || byed;
        const quiet = !!opts.quiet || standbyOnly;
        const ep = {
            peerId, rec, settled: false, exchanged: false, usedEpoch: null,
            carrier: null, shadow: null, timers: [], unsubs: [],
            phase: quiet ? 'quiet' : 'active', standbyOnly, announced: false,
            offerNonce: null, sealedOffer: null, ringNonce: null, sealedRing: null,
            answeredNonce: null, deadNonces: new Set(), seenRings: new Set(),
            lastShadowAt: 0, publishOnce: null, publishScheduled: false, answering: false,
            ownBlobs: new Set(), undecryptable: 0
        };
        this.episodes.set(pairId, ep);
        this._diag(`pair ${pairId}: episode started — role=${rec.role}, epoch=${rec.epoch || 0}, phase=${ep.phase}${standbyOnly ? ' (standby-only' + (byed ? ', after bye' : '') + ')' : ''}`);
        try {
            ep.carrier = this.options.carrierFactory();
            ep.topicKey = await RC.deriveTopicKey(rec.base);
            ep.aeadKey = await RC.deriveAeadKey(rec.base);
            if (!quiet) {
                ep.announced = true;
                this._emit('reconnecting', { pairId, peerId, role: rec.role });
            }
            this._after(ep, this.options.episodeTimeoutMs, () => this._demoteEpisode(pairId, ep));
            // A hardened carrier resolves on its first successful session and
            // redials internally afterwards; episodes never die of carrier loss.
            await ep.carrier.connect();
            if (ep.settled) return; // cancelled while the carrier was dialing
            const topics = await this._topics(ep);
            for (const t of topics) {
                ep.unsubs.push(ep.carrier.subscribe(t, (blob) => {
                    this._onBlob(pairId, ep, blob).catch(() => {});
                }));
            }
            this._diag(`pair ${pairId}: carrier up, subscribed to ${topics.length} day-topic(s)`);
            if (!ep.standbyOnly) {
                if (rec.role === 'caller') await this._armCallerOffer(pairId, ep);
                else await this._armRing(pairId, ep);
                this._schedulePublishes(pairId, ep);
            }
        } catch (e) {
            this._failEpisode(pairId, ep, e.message);
        }
    }

    /**
     * (Re)builds the caller's shadow connection and sealed offer. Offers
     * carry a fresh random nonce; the matching answer must echo it, so an
     * answer to a superseded offer dies at the nonce check, never at the
     * ICE layer. Safe to call again mid-episode (a ring after the network
     * moved under a long-quiet shadow).
     */
    async _armCallerOffer(pairId, ep) {
        ep.usedEpoch = (ep.rec.epoch || 0) + 1;
        // Shadow connection: the live entry (possibly still self-repairing
        // in-band) is untouched until a sealed answer actually arrives.
        await this.pm._ensureCertificate();
        const pc = new RTCPeerConnection(this.pm._buildRtcConfig());
        const dc = pc.createDataChannel('data');
        if (ep.shadow && !ep.shadow.adopted) {
            try { ep.shadow.pc.close(); } catch (e) {}
        }
        ep.shadow = { pc, dc, adopted: false };
        ep.lastShadowAt = Date.now();
        ep.offerNonce = hex(RC.randBytes(8));
        await pc.setLocalDescription(await pc.createOffer());
        await waitGathering(pc);
        const payload = JSON.stringify({
            peerId: ep.peerId,
            n: ep.offerNonce,
            sessionDesc: { type: pc.localDescription.type, sdp: ConnectionUtils.minifySDP(pc.localDescription.sdp, this.pm.options) }
        });
        ep.sealedOffer = await RC.seal(ep.aeadKey, await ConnectionUtils.encodePayload(payload), 'o', ep.usedEpoch);
        this._diag(`pair ${pairId}: caller offer armed (epoch ${ep.usedEpoch}, nonce ${ep.offerNonce})`);
    }

    /** Seals the listener's ring — a doorbell asking for a fresh offer. */
    async _armRing(pairId, ep) {
        ep.ringNonce = hex(RC.randBytes(8));
        ep.sealedRing = await RC.seal(
            ep.aeadKey,
            JSON.stringify({ peerId: ep.peerId, n: ep.ringNonce }),
            'r', (ep.rec.epoch || 0) + 1
        );
        this._diag(`pair ${pairId}: listener ring armed (epoch ${(ep.rec.epoch || 0) + 1}, nonce ${ep.ringNonce})`);
    }

    /**
     * Installs the publish cadence: the retry schedule once, then its last
     * interval repeating. The blob is read per-publish so a re-armed
     * offer/ring is picked up. Publishing stops — leaving the episode
     * subscribe-only — once the pair hasn't been seen within
     * resumeWindowMs: reachability stays, standing spam doesn't.
     */
    _schedulePublishes(pairId, ep) {
        if (ep.publishScheduled) return;
        ep.publishScheduled = true;
        const kind = ep.rec.role === 'caller' ? 'offer' : 'ring';
        const currentBlob = ep.rec.role === 'caller' ? () => ep.sealedOffer : () => ep.sealedRing;
        const publishOnce = async () => {
            if (ep.settled || !currentBlob()) return;
            if (Date.now() - (ep.rec.lastSeenAt || 0) > this.options.resumeWindowMs) return;
            try {
                this._trackOwnBlob(ep, currentBlob());
                await ep.carrier.publish(await RC.topicForDay(ep.topicKey, RC.dayString(Date.now())), currentBlob());
                this._diag(`pair ${pairId}: ${kind} published`);
            } catch (e) {
                this._diag(`pair ${pairId}: ${kind} publish failed (${e && e.message}) — will retry on schedule`, 'warn');
            }
        };
        ep.publishOnce = publishOnce;
        const schedule = this.options.retryScheduleMs;
        schedule.forEach(ms => this._after(ep, ms, publishOnce));
        this._every(ep, schedule[schedule.length - 1] || 300000, publishOnce);
    }

    /**
     * Remembers a blob this episode published, so the carrier echoing it back
     * (MQTT delivers your own QoS-0 publishes to your own subscription) is
     * dropped silently instead of burning decrypt attempts and polluting the
     * undecryptable-blob diagnostics. Bounded: an episode re-arms rarely.
     */
    _trackOwnBlob(ep, blob) {
        if (!blob) return;
        ep.ownBlobs.add(blob);
        if (ep.ownBlobs.size > 16) {
            ep.ownBlobs.delete(ep.ownBlobs.values().next().value);
        }
    }

    /** Routes an incoming sealed blob by this side's role. */
    async _onBlob(pairId, ep, blob) {
        if (ep.settled) return;
        if (ep.ownBlobs.has(blob)) return; // our own publish echoed back
        let consumed;
        if (ep.rec.role === 'caller') {
            consumed = await this._onCallerAnswer(pairId, ep, blob)
                || await this._onCallerRing(pairId, ep, blob);
        } else {
            consumed = await this._onListenerOffer(pairId, ep, blob);
        }
        if (!consumed && !ep.exchanged) {
            // A blob on OUR pair topic that opens under none of the expected
            // AAD/epoch combinations. (While an exchange is in flight some
            // frame kinds are deliberately not tried — don't count those.)
            // Occasional relay junk is possible, but a steady stream of
            // these means the two sides' keys or epochs have diverged — the
            // reconnect can never complete until the pair re-ceremonies.
            ep.undecryptable++;
            if (ep.undecryptable <= 5 || ep.undecryptable % 20 === 0) {
                const base = ep.rec.epoch || 0;
                this._diag(`pair ${pairId}: sealed blob did not decrypt (#${ep.undecryptable}; tried epochs ${base + 1}–${base + EPOCH_WINDOW}) — repeated failures indicate key/epoch desync with the peer`, 'warn');
            }
        }
    }

    /** Caller ← answer. Returns true when the blob WAS an answer for us. */
    async _onCallerAnswer(pairId, ep, blob) {
        if (!ep.usedEpoch || !ep.shadow) return false;
        const packed = await RC.open(ep.aeadKey, blob, 'a', ep.usedEpoch);
        if (packed === null) return false;
        let payload;
        try { payload = await ConnectionUtils.decodePayload(packed); } catch (e) { return true; }
        if (payload.peerId !== ep.peerId) return true;
        // The nonce binds this answer to OUR current offer: a delayed or
        // replayed answer to any earlier offer is silence. (An absent nonce
        // is a pre-nonce peer — accepted for compatibility.)
        if (payload.n && ep.offerNonce && payload.n !== ep.offerNonce) {
            this._diag(`pair ${pairId}: answer for a superseded offer ignored (nonce ${payload.n} ≠ ${ep.offerNonce})`);
            return true;
        }
        if (ep.exchanged) return true; // already applying an answer
        if (ep.settled) return true;   // settled while the blob was decrypting
        const live = this.pm.peers.get(ep.peerId);
        if (live && live.status === 'connected') {
            // In-band repair won the race while the answer was in flight —
            // keep the healed link, drop the shadow, no ratchet.
            this._settleEpisode(pairId, ep);
            return true;
        }
        this._diag(`pair ${pairId}: answer received (epoch ${ep.usedEpoch}) — adopting shadow connection, waiting for the channel to open`);
        ep.exchanged = true;
        this.pm.adoptConnection(ep.peerId, ep.shadow.pc, ep.shadow.dc, { fallbackType: 'client' });
        ep.shadow.adopted = true;
        await this.pm.acceptAnswer(payload);
        // status 'connected' (channel open) settles + ratchets. If it never
        // comes (the answer rode a dead path), retire this exchange and
        // re-arm a fresh offer instead of staying deaf until timeout.
        this._after(ep, this.options.answerStallMs, async () => {
            if (ep.settled) return;
            const p = this.pm.peers.get(ep.peerId);
            if (p && p.status === 'connected') return;
            this._diag(`pair ${pairId}: adopted answer never connected within ${this.options.answerStallMs / 1000}s (ICE could not find a path?) — re-arming a fresh offer`, 'warn');
            ep.exchanged = false;
            try {
                await this._armCallerOffer(pairId, ep);
                if (ep.publishOnce) await ep.publishOnce();
            } catch (e) {}
        });
        return true;
    }

    /** Caller ← ring: the listener asks for a fresh offer, right now.
     *  Returns true when the blob WAS a ring for this pair. */
    async _onCallerRing(pairId, ep, blob) {
        if (ep.exchanged) return false;
        const base = ep.rec.epoch || 0;
        let txt = null;
        for (let e = base + 1; e <= base + EPOCH_WINDOW; e++) {
            txt = await RC.open(ep.aeadKey, blob, 'r', e);
            if (txt !== null) break;
        }
        if (txt === null) return false;
        let ring;
        try { ring = JSON.parse(txt); } catch (e) { return true; }
        if (ring.peerId !== ep.peerId) return true;
        if (ring.n) {
            if (ep.seenRings.has(ring.n)) return true; // replayed doorbell
            ep.seenRings.add(ring.n);
        }
        const live = this.pm.peers.get(ep.peerId);
        if (live && live.status === 'connected') return true;
        this._diag(`pair ${pairId}: ring received — the listener side is asking for a fresh offer`);
        ep.standbyOnly = false; // provoked: this standby now initiates
        try {
            // Fresh shadow if we have none or ours has aged (the network may
            // have moved under it); otherwise just republish what we have.
            if (!ep.sealedOffer || Date.now() - ep.lastShadowAt > 30000) {
                await this._armCallerOffer(pairId, ep);
            }
            this._schedulePublishes(pairId, ep);
            if (ep.publishOnce) await ep.publishOnce();
        } catch (e) {
            this._diag(`pair ${pairId}: could not arm/publish an offer after a ring (${e && e.message})`, 'warn');
        }
        return true;
    }

    /** Listener ← offer: answer it and adopt.
     *  Returns true when the blob WAS an offer for this pair. */
    async _onListenerOffer(pairId, ep, blob) {
        if (ep.answering) return true; // one adoption at a time; republishes retry
        const base = ep.rec.epoch || 0;
        let packed = null, usedEpoch = null;
        for (let e = base + 1; e <= base + EPOCH_WINDOW; e++) {
            packed = await RC.open(ep.aeadKey, blob, 'o', e);
            if (packed !== null) { usedEpoch = e; break; }
        }
        if (packed === null) return false;
        let payload;
        try { payload = await ConnectionUtils.decodePayload(packed); } catch (e) { return true; }
        if (typeof payload.peerId !== 'string') return true;
        if (payload.n && ep.deadNonces.has(payload.n)) return true; // retired exchange
        const live = this.pm.peers.get(payload.peerId);
        if (live && live.status === 'connected') return true; // in-band won / already connected
        if (ep.exchanged) {
            // An answer is in flight. The SAME offer again is a republish —
            // ignore it. A DIFFERENT nonce means the caller re-armed (fresh
            // shadow); supersede our stale attempt.
            if (!payload.n || payload.n === ep.answeredNonce) return true;
            this._diag(`pair ${pairId}: caller re-armed (nonce ${payload.n}) — superseding our in-flight answer`);
        }
        this._diag(`pair ${pairId}: offer received (epoch ${usedEpoch}, nonce ${payload.n || 'none'}) — answering`);
        ep.answering = true;
        try {
            ep.exchanged = true;
            ep.standbyOnly = false;
            ep.answeredNonce = payload.n || null;
            ep.usedEpoch = usedEpoch;
            ep.peerId = payload.peerId;
            this.pairsByPeerId.set(payload.peerId, pairId);

            await this.pm._ensureCertificate();
            const pc = new RTCPeerConnection(this.pm._buildRtcConfig());
            await pc.setRemoteDescription(new RTCSessionDescription(payload.sessionDesc));
            await pc.setLocalDescription(await pc.createAnswer());
            await waitGathering(pc);
            // The gathering wait is long (up to 10s): the in-band repair may
            // have healed the live link meanwhile — this offer then predates
            // the recovery, and adopting would CLOSE the healthy connection
            // and replace it with an exchange whose other end is already
            // gone (seen in field logs: a link recovered in-band died seconds
            // later when a stale-offer answer landed). Re-check before the
            // point of no return; likewise if the episode settled under us.
            const liveNow = this.pm.peers.get(payload.peerId);
            if (ep.settled || (liveNow && liveNow.status === 'connected')) {
                this._diag(`pair ${pairId}: link recovered while answering — discarding the answer, keeping the live link`);
                try { pc.close(); } catch (err) {}
                if (payload.n) ep.deadNonces.add(payload.n);
                ep.exchanged = false;
                ep.answeredNonce = null;
                return true;
            }
            // Adopt now so ondatachannel and the resilience handlers are wired
            // before connectivity completes. The caller committed by
            // publishing; any interrupted remnant (or a superseded earlier
            // attempt) is replaced.
            this.pm.adoptConnection(payload.peerId, pc, null, { fallbackType: 'host' });

            const answerPayload = JSON.stringify({
                peerId: payload.peerId,
                n: payload.n || undefined,
                sessionDesc: { type: pc.localDescription.type, sdp: ConnectionUtils.minifySDP(pc.localDescription.sdp, this.pm.options) }
            });
            const sealed = await RC.seal(ep.aeadKey, await ConnectionUtils.encodePayload(answerPayload), 'a', usedEpoch);
            this._trackOwnBlob(ep, sealed);
            const publishAnswer = async () => {
                if (ep.settled) return;
                try {
                    await ep.carrier.publish(await RC.topicForDay(ep.topicKey, RC.dayString(Date.now())), sealed);
                    this._diag(`pair ${pairId}: answer published (epoch ${usedEpoch})`);
                } catch (e) {
                    this._diag(`pair ${pairId}: answer publish failed (${e && e.message})`, 'warn');
                }
            };
            await publishAnswer();
            [3000, 10000, 30000].forEach(ms => this._after(ep, ms, publishAnswer));
            // If this exchange never connects (stale offer, dead path), retire
            // its nonce and unlatch so the next fresh offer gets answered.
            const staleNonce = ep.answeredNonce;
            this._after(ep, this.options.answerStallMs, () => {
                if (ep.settled) return;
                const p = this.pm.peers.get(ep.peerId);
                if (p && p.status === 'connected') return;
                this._diag(`pair ${pairId}: answered offer never connected within ${this.options.answerStallMs / 1000}s (ICE could not find a path?) — retiring it, will answer the caller's next fresh offer`, 'warn');
                if (staleNonce) ep.deadNonces.add(staleNonce);
                if (ep.answeredNonce === staleNonce) ep.exchanged = false;
            });
        } catch (e) {
            this._diag(`pair ${pairId}: answering the offer failed (${e && e.message})`, 'warn');
            ep.exchanged = false;
        } finally {
            ep.answering = false;
        }
        return true;
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
                this._diag(`pair ${pairId}: reconnected via sealed exchange — key ratcheted to epoch ${ep.usedEpoch}`);
            } else {
                this._diag(`pair ${pairId}: reconnected but fingerprints unavailable (own=${!!own}, theirs=${!!theirs}) — NOT ratcheting; if the peer ratcheted, the pair is now desynced`, 'warn');
            }
        } else {
            this._diag(`pair ${pairId}: link recovered in-band — episode closed without touching the key`);
        }
        ep.rec.lastPeerId = ep.peerId;
        ep.rec.lastSeenAt = Date.now();
        delete ep.rec.byeAt; // reconnected: any old hang-up is history
        try { await dbPut(pairId, ep.rec); } catch (e) {
            // The ratchet advanced in memory but not on disk: after a restart
            // this side is on the PREVIOUS base key while the peer moved on —
            // different AEAD keys AND different topics, so the pair is deaf
            // in both directions until the next manual ceremony re-mints the
            // secret. Surface it loudly.
            this._diag(`pair ${pairId}: FAILED to persist post-reconnect state (${e && e.message}) — the pair will desync across a restart (fix: Start Over + fresh invite on both devices)`, 'error');
        }
        this._cleanupEpisode(pairId, ep);
        this._emit(ep.exchanged ? 'reconnected' : 'recovered-inband', { pairId, peerId: ep.peerId });
    }

    /**
     * The active phase is over — 'gave-up' releases UI claims and wake locks
     * — but the episode LIVES ON quietly: still subscribed, still slowly
     * republishing (until the resumeWindowMs bound in _schedulePublishes).
     * The pair stays reachable for as long as the app is open.
     */
    _demoteEpisode(pairId, ep) {
        if (ep.settled || ep.phase === 'quiet') return;
        ep.phase = 'quiet';
        this._diag(`pair ${pairId}: active phase timed out after ${this.options.episodeTimeoutMs / 60000}min — going quiet (still subscribed and reachable)`);
        if (ep.announced) {
            this._emit('gave-up', { pairId, peerId: ep.peerId, why: 'timeout', standby: true });
        }
    }

    /**
     * Hard error path (carrier factory threw, RTC failure). Unlike the old
     * one-shot design, a failed episode re-arms itself: one transient error
     * must not strand the pair until the next app restart.
     */
    _failEpisode(pairId, ep, why) {
        if (ep.settled) return;
        ep.settled = true;
        this._diag(`pair ${pairId}: episode FAILED (${why}) — re-arming quietly in ${this.options.rearmDelayMs / 1000}s`, 'error');
        this._cleanupEpisode(pairId, ep);
        if (ep.announced) this._emit('gave-up', { pairId, peerId: ep.peerId, why });
        if (!this.delayTimers.has(pairId)) {
            const peerId = ep.peerId;
            const t = setTimeout(() => {
                this.delayTimers.delete(pairId);
                this._startEpisode(pairId, peerId, { quiet: true });
            }, this.options.rearmDelayMs);
            this.delayTimers.set(pairId, () => clearTimeout(t));
        }
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
