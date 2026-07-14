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
 *               both derive pairBase_0 and roles (lower random hex = caller)
 *               → key-confirmation MACs cross ('pair-confirm', v2) → each
 *               side persists {base, role, epoch} in IndexedDB only once
 *               the peer has PROVEN it derived the same base. (v1 peers
 *               send no confirmation and are committed immediately, with
 *               the old divergence risk.) The exchange is idempotent per
 *               link: repeat enablePair() calls re-send the SAME material,
 *               and a replayed random is answered, never re-minted against
 *               — minting twice is how the two sides used to commit two
 *               DIFFERENT bases (crossed exchanges), leaving the pair
 *               permanently deaf on disjoint topics.
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
 *   NUDGE       nudgeAll() — the app's "the world may have changed" kick
 *               (page became visible, network came back, a suspend was
 *               detected). Every live episode verifies its carrier socket
 *               right now and republishes immediately instead of waiting
 *               out the backoff schedule: a device thawing from a
 *               background freeze would otherwise spend its first minutes
 *               deaf (half-open socket) and mute (publishes that died in
 *               the frozen socket are not retried until the next slot).
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
 *     manually-ceremonied link, and are held only until the exchange
 *     commits (or its confirmation window lapses).
 *   - A pairing secret is persisted ONLY after key confirmation: both sides
 *     prove (HKDF-derived role-bound MAC) they hold the same base before
 *     either commits. A mismatch or a silent peer leaves the PREVIOUS
 *     secret untouched — a failed re-pair can never brick a working pair.
 */

import { RendezvousCrypto as RC } from './rendezvous-crypto.js';
import { ConnectionUtils } from './p2p-core.js';

// Bumped on every rendezvous protocol/behaviour change. The bridge prints
// this at boot: the FIRST question a connection log must answer is "which
// build produced this?" — field sessions have been burned diagnosing bugs
// that were already fixed but not actually loaded (stale caches).
export const RDV_BUILD = 'v2.4 pair-confirm/serialized/flap-resend/multi-broker';

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

// Persistent cross-episode replay cache (S-sec-4a). The signaling ratchet is
// frozen (see _settleEpisode), so `rec.epoch` never advances and the AEAD key
// lives for the pairing's life; per-episode deadNonces/seenRings reset each
// episode, so without this a broker could replay a recorded offer/ring in a
// LATER episode to provoke presence disclosure + publish spam. Each processed
// offer/ring nonce is remembered in a bounded FIFO on the pair record so a
// replay is dead on arrival regardless of episode. Cap keeps the record small;
// only fresh legitimate nonces are ever appended (replays are rejected first),
// so the list can't be pumped.
const SEEN_NONCE_CAP = 512;

// How often a live episode re-checks its day-topic window. Publishers rotate to
// a new UTC-day HMAC topic at midnight; re-subscribing well within a day keeps a
// long-quiet/standby episode reachable across the rollover (B-rdv day-deafness).
const RENDEZVOUS_TOPIC_REFRESH_MS = 6 * 3600 * 1000;

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
        this.myRands = new Map();       // peerId → {pairId, rand, tag}
        this.pendingRands = new Map();  // peerId → {rand, v} (their opt-in awaiting ours)
        this.pairExchanges = new Map(); // peerId → completed exchange awaiting/holding confirmation
        this.earlyConfirms = new Map(); // peerId → mac (confirm that outran our async opt-in)
        this.confirmRetries = new Map();// peerId → count (crossed-exchange restarts)
        this.episodes = new Map();      // pairId → episode
        this._startingEpisodes = new Set(); // pairIds mid-_startEpisode, before the slot is claimed
        this._tombstoned = new Set();   // pairIds forgotten via disablePair — refuse stale re-persists
        this.delayTimers = new Map();   // pairId → clearFn
        this._peerLocks = new Map();    // peerId → queue tail (pairing ops serialized per peer)
        this._recWrites = new Map();    // pairId → queue tail (record writes serialized per pair)

        this._onExtBound = (e) => this._onExt(e.detail || {});
        this._onStatusBound = (e) => this._onStatus(e.detail || {});
        this.pm.addEventListener('control-ext', this._onExtBound);
        this.pm.addEventListener('status', this._onStatusBound);
    }

    destroy() {
        this._destroyed = true;
        this.pm.removeEventListener('control-ext', this._onExtBound);
        this.pm.removeEventListener('status', this._onStatusBound);
        for (const [pairId, ep] of this.episodes) this._cleanupEpisode(pairId, ep);
        for (const clear of this.delayTimers.values()) clear();
        this.delayTimers.clear();
        this.myRands.clear();
        this.pendingRands.clear();
        for (const ex of this.pairExchanges.values()) { if (ex.timer) ex.timer(); }
        this.pairExchanges.clear();
        this.earlyConfirms.clear();
        this.confirmRetries.clear();
    }

    _emit(type, detail) {
        this.dispatchEvent(new CustomEvent(type, { detail }));
    }

    /**
     * Per-key mutex: runs `fn` once every previously queued task for `key`
     * has settled. The pairing exchange spans several awaits, and its
     * handlers used to interleave — a pending random consumed by the wrong
     * completion, two record writes clobbering each other (both seen in
     * field logs). Everything touching one peer's exchange state, and every
     * write to one pair's stored record, goes through here.
     */
    _serial(map, key, fn) {
        const tail = map.get(key) || Promise.resolve();
        // A queued op that comes due AFTER destroy() must not run — it could
        // write a record back to IndexedDB post-teardown. Skip to undefined.
        const run = tail.catch(() => {}).then(() => (this._destroyed ? undefined : fn()));
        const settled = run.catch(() => {});
        map.set(key, settled);
        settled.then(() => { if (map.get(key) === settled) map.delete(key); });
        return run;
    }

    /**
     * Sends a pairing frame, surfacing failure: control frames ride no
     * outbox, so one sent into a closed/interrupted channel is silently
     * dropped — a lost pairing frame used to starve the exchange with no
     * trace in the log. _resumeExchangeLocked re-sends on the next link-up.
     */
    _sendFrame(peerId, frame, what) {
        const ok = this.pm.sendExt(peerId, 'rdv', frame);
        if (!ok) this._diag(`${what} could not be sent (control channel not open) — will re-send when the link returns`, 'warn');
        return ok;
    }

    /**
     * Serialized read-modify-write for a pair's stored record. Overlapping
     * get→put sequences clobber each other: a field log showed resumePair
     * resurrecting the base _commitPairing had just replaced — the device
     * rang on the retired key from then on. `mutate` receives the current
     * record (or null) and returns the record to store, or falsy to store
     * nothing. Resolves to the record now in force (or null).
     */
    _updateRec(pairId, mutate, opts) {
        return this._serial(this._recWrites, pairId, async () => {
            // A pair the user forgot via disablePair() must stay forgotten: a
            // settle/commit already queued when the delete landed would otherwise
            // re-persist the revoked secret. Only an explicit re-pairing
            // (resurrect) may write again, and it lifts the tombstone.
            if (this._tombstoned.has(pairId)) {
                if (opts && opts.resurrect) this._tombstoned.delete(pairId);
                else return null;
            }
            const rec = await dbGet(pairId).catch(() => null);
            const out = mutate(rec);
            if (out) await dbPut(pairId, out);
            return out || rec;
        });
    }

    /**
     * Remember a processed offer/ring nonce so a broker can't replay that frame
     * in a LATER episode (S-sec-4a). Adds to the episode's in-RAM mirror for
     * O(1) checks and persists a bounded FIFO on the pair record. The episode's
     * own `rec.seenNonces` is kept in sync so _settleEpisode's whole-record
     * write preserves the additions; a concurrent proactive _updateRec persists
     * them even if the episode never settles (e.g. the browser is killed).
     */
    _rememberNonce(pairId, ep, nonce) {
        if (!nonce || ep.seenNonceSet.has(nonce)) return;
        ep.seenNonceSet.add(nonce);
        if (!Array.isArray(ep.rec.seenNonces)) ep.rec.seenNonces = [];
        ep.rec.seenNonces.push(nonce);
        while (ep.rec.seenNonces.length > SEEN_NONCE_CAP) ep.rec.seenNonces.shift();
        this._updateRec(pairId, r => {
            if (!r) return null; // pair gone (forgotten mid-episode) — nothing to persist
            const list = Array.isArray(r.seenNonces) ? r.seenNonces : [];
            if (list.includes(nonce)) return r;
            list.push(nonce);
            while (list.length > SEEN_NONCE_CAP) list.shift();
            r.seenNonces = list;
            return r;
        }).catch(() => {});
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
    enablePair(peerId, pairId) {
        // Serialized with every other pairing op for this peer: the app has
        // several triggers for enabling a pair (identity handshake,
        // pair-request auto-accept, the user's toggle) and they fire in the
        // same instant.
        return this._serial(this._peerLocks, peerId, () => this._enablePairLocked(peerId, pairId));
    }

    async _enablePairLocked(peerId, pairId) {
        this._cancelEpisode(pairId); // a manual re-pair supersedes any repair attempt
        // Bind the live link to the pair NOW, not just on completion: the
        // liveness checks (resumePair's "already connected", episode gating)
        // must see the current link, or they judge the pair by a stale
        // lastPeerId and arm pointless episodes against a connected peer.
        this.pairsByPeerId.set(peerId, pairId);
        // Idempotent re-entry: minting a FRESH random on every call is what
        // used to split a pair onto two different bases — each side
        // committing a different crossed exchange — so a repeat call
        // re-sends the material already in flight instead.
        const outstanding = this.myRands.get(peerId);
        if (outstanding && outstanding.pairId === pairId) {
            this._diag(`pair ${pairId}: pairing already in progress — re-sending the same random (rand#${outstanding.tag})`);
            this._sendFrame(peerId, { t: 'pair', v: 2, rand: b64(outstanding.rand) }, `pair ${pairId}: pairing random`);
            return;
        }
        const ex = this.pairExchanges.get(peerId);
        if (ex && ex.pairId === pairId && !ex.committed) {
            this._diag(`pair ${pairId}: exchange awaiting the peer's key confirmation — re-sending ours, not minting a fresh random`);
            if (ex.myRandB64) this._sendFrame(peerId, { t: 'pair', v: 2, rand: ex.myRandB64 }, `pair ${pairId}: pairing random`);
            this._sendFrame(peerId, ex.confirmFrame, `pair ${pairId}: key confirmation`);
            return;
        }
        const rand = RC.randBytes(32);
        const tag = await RC.tag(rand);
        this.myRands.set(peerId, { pairId, rand, tag });
        this._diag(`pair ${pairId}: pairing random minted and sent (rand#${tag})`);
        this._sendFrame(peerId, { t: 'pair', v: 2, rand: b64(rand) }, `pair ${pairId}: pairing random`);
        const pending = this.pendingRands.get(peerId);
        if (pending) {
            await this._completePairing(peerId, pairId, rand, pending.rand, pending.v);
        }
    }

    /** Forgets the pair entirely (secret, role, epoch, in-flight exchange). */
    async disablePair(pairId) {
        this._cancelEpisode(pairId);
        for (const [pid, pr] of this.pairsByPeerId) {
            if (pr === pairId) this.pairsByPeerId.delete(pid);
        }
        for (const [pid, ex] of this.pairExchanges) {
            if (ex.pairId === pairId) {
                if (ex.timer) ex.timer();
                this.pairExchanges.delete(pid);
            }
        }
        // Delete through the SAME per-pair queue that record writes use, and
        // tombstone the pair first — otherwise a settle/commit already queued
        // ahead of us runs after the delete and resurrects the secret the user
        // just revoked (the read-modify-write clobber _recWrites exists to stop,
        // here on the revocation path where the stakes are "still callable").
        await this._serial(this._recWrites, pairId, async () => {
            this._tombstoned.add(pairId);
            await dbDelete(pairId);
        });
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
        const rec = await this._updateRec(pairId, r => {
            if (!r) return null;
            r.enabled = false;
            return r;
        });
        return !!rec;
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
        const rec = await this._updateRec(pairId, r => {
            if (!r) return null;
            r.enabled = true;
            delete r.byeAt;
            return r;
        });
        if (!rec) {
            this._diag(`pair ${pairId}: resumePair found no stored secret — nothing to call with`, 'warn');
            return false;
        }
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
     * Kicks every live episode RIGHT NOW: verifies the carrier socket is
     * actually alive and republishes the current offer/ring immediately
     * instead of waiting for the next backoff slot. Call when the page
     * returns to the foreground, the network comes back, or a suspend is
     * detected — a page thawing from a background freeze usually holds a
     * WebSocket that LOOKS open for another 30–90s while the broker has
     * long dropped the session, and its earlier publishes died inside the
     * frozen socket (QoS 0: nobody retries them but us). Per-episode
     * rate-limited so visibility flapping can't spam the relay. Standby
     * episodes only get the socket check — they must stay reachable, but
     * still initiate nothing.
     */
    nudgeAll(why = 'nudge') {
        for (const [pairId, ep] of this.episodes) {
            if (ep.settled) continue;
            this._nudgeEpisode(pairId, ep, why).catch(() => {});
        }
    }

    async _nudgeEpisode(pairId, ep, why) {
        try {
            if (ep.carrier && typeof ep.carrier.ensureAlive === 'function') ep.carrier.ensureAlive();
        } catch (e) {}
        // An answer/adoption in flight — let it finish (its stall timer
        // re-arms if it never connects); a standby stays passive.
        if (ep.standbyOnly || ep.exchanged || !ep.publishOnce) return;
        const now = Date.now();
        if (now - (ep.lastNudgeAt || 0) < 5000) return;
        ep.lastNudgeAt = now;
        this._diag(`pair ${pairId}: nudged (${why}) — checking the carrier and republishing now`);
        try {
            // Same freshness rule as a received ring: a suspend usually means
            // the network moved under the shadow's gathered candidates.
            if (ep.rec.role === 'caller' && (!ep.sealedOffer || now - ep.lastShadowAt > 30000)) {
                await this._armCallerOffer(pairId, ep);
            }
            await ep.publishOnce();
        } catch (e) {
            this._diag(`pair ${pairId}: nudge could not republish (${e && e.message})`, 'warn');
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
        if (data.t === 'pair-confirm') {
            if (typeof data.mac !== 'string') return;
            await this._serial(this._peerLocks, peerId, () => this._onPairConfirmLocked(peerId, data.mac));
            return;
        }
        if (data.t !== 'pair') return;
        const theirRand = typeof data.rand === 'string' ? unb64(data.rand) : null;
        if (!theirRand || theirRand.length !== 32) return;
        const theirV = typeof data.v === 'number' ? data.v : 1;
        // Enqueued in arrival order (nothing awaits before this point), and
        // handled one at a time — a burst of frames can no longer interleave
        // its handlers mid-exchange.
        await this._serial(this._peerLocks, peerId, () => this._onPairFrameLocked(peerId, theirRand, theirV));
    }

    async _onPairFrameLocked(peerId, theirRand, theirV) {
        const theirRandHex = hex(theirRand);
        const ex = this.pairExchanges.get(peerId);
        const pending = this.pendingRands.get(peerId);
        if ((ex && ex.theirRandHex === theirRandHex) ||
                (pending && hex(pending.rand) === theirRandHex)) {
            // The SAME random again is a replayed/duplicated frame, not a new
            // opt-in. Never mint against a replay — that is exactly the
            // double-mint that used to split a pair onto two bases. Re-send
            // our confirmation instead, in case theirs got lost.
            const dupOfEx = ex && ex.theirRandHex === theirRandHex;
            this._diag(`${dupOfEx ? `pair ${ex.pairId}: ` : ''}duplicate pairing random ignored (rand#${await RC.tag(theirRand)})${dupOfEx && !ex.legacy ? ' — re-sending our key confirmation' : ''}`);
            if (dupOfEx && !ex.legacy) this._sendFrame(peerId, ex.confirmFrame, `pair ${ex.pairId}: key confirmation`);
            return;
        }
        // A fresh random supersedes any stashed confirmation: the channel is
        // ordered, so a confirm sent BEFORE this random can only belong to
        // an older exchange.
        this.earlyConfirms.delete(peerId);
        const mine = this.myRands.get(peerId);
        if (mine) {
            this.myRands.delete(peerId); // consumed
            this._diag(`pair ${mine.pairId}: peer's pairing random received (rand#${await RC.tag(theirRand)}, v${theirV}) — completing the exchange`);
            await this._completePairing(peerId, mine.pairId, mine.rand, theirRand, theirV);
        } else {
            // Their side opted in; ours hasn't (yet). Hold the random and let
            // the app decide — enablePair() later completes the exchange.
            this.pendingRands.set(peerId, { rand: theirRand, v: theirV });
            this._diag(`pairing random received from ${peerId} (rand#${await RC.tag(theirRand)}, v${theirV}) — held pending until this side opts in`);
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
        await this._updateRec(pairId, r => {
            if (!r) return null;
            r.byeAt = Date.now();
            return r;
        }).catch(() => {});
        this._emit('remote-bye', { pairId, peerId });
    }

    /**
     * Both randoms have crossed: derive the base and HOLD it as an
     * uncommitted exchange while key confirmations cross. Nothing is
     * persisted here — commitment waits for the peer to prove it derived
     * the SAME base (v1 peers send no proof and are committed immediately).
     * A candidate that is never confirmed expires without touching the
     * previously stored secret.
     */
    async _completePairing(peerId, pairId, myRand, theirRand, theirV = 1) {
        // Consume the randoms BEFORE any await: another frame arriving while
        // the derivation is in flight must not pair our random a second time.
        this.myRands.delete(peerId);
        this.pendingRands.delete(peerId);
        const base = await RC.derivePairBase(myRand, theirRand);
        const role = hex(myRand) < hex(theirRand) ? 'caller' : 'listener';
        const check = await RC.keyCheck(base);
        const rec = {
            base, role, epoch: 0, enabled: true,
            pairedAt: Date.now(), lastPeerId: peerId, lastSeenAt: Date.now(),
            seenNonces: [] // bounded FIFO of processed offer/ring nonces (S-sec-4a)
        };
        const prev = this.pairExchanges.get(peerId);
        if (prev && prev.timer) prev.timer();
        const legacy = theirV < 2;
        const ex = {
            pairId, rec, check, legacy, committed: false, timer: null,
            theirRandHex: hex(theirRand),
            myRandB64: b64(myRand), // kept only until commit/expiry, for idempotent re-sends
            confirmFrame: { t: 'pair-confirm', v: 2, mac: await RC.confirmMac(base, role) }
        };
        this.pairExchanges.set(peerId, ex);
        this._sendFrame(peerId, ex.confirmFrame, `pair ${pairId}: key confirmation`);
        if (legacy) {
            // A pre-confirmation peer committed the moment the randoms
            // crossed — holding back here would only desync us from it.
            this._diag(`pair ${pairId}: peer speaks pairing v1 (no key confirmation) — committing unconfirmed (key check ${check})`, 'warn');
            await this._commitPairing(peerId, ex);
            return;
        }
        this._diag(`pair ${pairId}: secret derived (role=${role}, key check ${check}) — waiting for the peer to confirm the same key`);
        const t = setTimeout(() => {
            // Through the peer lock: the expiry must not fire in the middle
            // of a confirm/commit that is already handling this exchange.
            this._serial(this._peerLocks, peerId, () => {
                ex.timer = null;
                if (ex.committed || this.pairExchanges.get(peerId) !== ex) return;
                this._diag(`pair ${pairId}: peer never confirmed the pairing key — secret NOT saved, auto-reconnect keeps its previous state. Toggle auto-reconnect on both devices to retry`, 'error');
                this.pairExchanges.delete(peerId);
            });
        }, 20000);
        ex.timer = () => clearTimeout(t);
        // The peer's confirmation may already be here: our opt-in runs async
        // (the app's pair-request handler), so their confirm can outrun our
        // completion. Ordered channel — it can never LEGITIMATELY arrive
        // before their random, only before our own derivation finished.
        const early = this.earlyConfirms.get(peerId);
        if (early !== undefined) {
            this.earlyConfirms.delete(peerId);
            await this._onPairConfirmLocked(peerId, early);
        }
    }

    /**
     * The link to this peer is (back) up: re-send whatever half-finished
     * pairing material we hold, in case our earlier frames died in a closed
     * channel. Idempotent on the receiving side (duplicate randoms are
     * dropped, confirmations re-verify). Always entered under the peer lock.
     */
    async _resumeExchangeLocked(peerId) {
        const mine = this.myRands.get(peerId);
        if (mine) {
            this._diag(`pair ${mine.pairId}: link is up with the exchange unfinished — re-sending our pairing random (rand#${mine.tag})`);
            this._sendFrame(peerId, { t: 'pair', v: 2, rand: b64(mine.rand) }, `pair ${mine.pairId}: pairing random`);
            return;
        }
        const ex = this.pairExchanges.get(peerId);
        if (ex && !ex.committed) {
            this._diag(`pair ${ex.pairId}: link is up with the exchange awaiting confirmation — re-sending our material (key check ${ex.check})`);
            if (ex.myRandB64) this._sendFrame(peerId, { t: 'pair', v: 2, rand: ex.myRandB64 }, `pair ${ex.pairId}: pairing random`);
            this._sendFrame(peerId, ex.confirmFrame, `pair ${ex.pairId}: key confirmation`);
        }
    }

    /** Peer's key confirmation: commit on proof, refuse on mismatch.
     *  Always entered under the peer lock. */
    async _onPairConfirmLocked(peerId, mac) {
        const ex = this.pairExchanges.get(peerId);
        if (!ex) {
            this.earlyConfirms.set(peerId, mac);
            return;
        }
        const peerRole = ex.rec.role === 'caller' ? 'listener' : 'caller';
        const expected = await RC.confirmMac(ex.rec.base, peerRole);
        if (mac === expected) {
            if (!ex.committed) await this._commitPairing(peerId, ex);
            return;
        }
        if (ex.committed) {
            // Not for the committed key. Most likely it belongs to a re-key
            // exchange whose derivation is still in flight on our side —
            // stash it so _completePairing can consume it; a stash that
            // never matches anything is cleared by the next incoming random.
            this.earlyConfirms.set(peerId, mac);
            this._diag(`pair ${ex.pairId}: peer's key confirmation does not match the committed key (our check ${ex.check}) — holding it for an in-flight re-key`, 'warn');
            return;
        }
        // The two sides derived DIFFERENT bases — two exchanges crossed.
        // Neither side commits, so nothing bricks. BOTH sides restart: two
        // fresh randoms crossing converge (completion pairs each side's
        // latest mint with the other's, deriving the same base on both
        // ends), and the idempotent re-send paths absorb the duplicate
        // traffic. A single-side rule ("lower MAC restarts") is NOT safe
        // here — it assumes both sides compare the same two MAC values,
        // which is false exactly when candidates crossed: each side
        // compares a different pair, and both can conclude "wait" (seen in
        // a field log — the exchange then starved until it expired and no
        // secret was saved at all).
        if (ex.timer) { ex.timer(); ex.timer = null; }
        this.pairExchanges.delete(peerId);
        const retries = this.confirmRetries.get(peerId) || 0;
        if (retries >= 2) {
            this._diag(`pair ${ex.pairId}: key confirmation failed ${retries + 1} times — giving up; toggle auto-reconnect on both devices to retry`, 'error');
            this.confirmRetries.delete(peerId);
            return;
        }
        this.confirmRetries.set(peerId, retries + 1);
        this._diag(`pair ${ex.pairId}: key confirmation MISMATCH (our check ${ex.check}) — crossed exchanges, secret NOT saved; restarting the exchange (attempt ${retries + 1})`, 'warn');
        const pairId = ex.pairId;
        setTimeout(() => {
            if (this._destroyed) return;
            this.enablePair(peerId, pairId).catch(() => {});
        }, 750);
    }

    /** The exchange is proven (or the peer is v1): persist and announce. */
    async _commitPairing(peerId, ex) {
        if (ex.committed) return;
        ex.committed = true;
        if (ex.timer) { ex.timer(); ex.timer = null; }
        delete ex.myRandB64; // random hygiene: nothing left to re-send once committed
        const pairId = ex.pairId;
        try {
            // Through the record queue: a resumePair()/pausePair() racing
            // this commit must never write a stale read back over it. A fresh
            // manual pairing is the one write allowed to lift a disablePair
            // tombstone (the user is deliberately re-establishing the pair).
            await this._updateRec(pairId, () => ex.rec, { resurrect: true });
        } catch (e) {
            // A pair that can't persist can't auto-reconnect after a restart
            // (and the OTHER side thinks it can) — never let this be silent.
            this._diag(`pair ${pairId}: FAILED to persist pairing secret (${e && e.message}) — auto-reconnect will not work from this device`, 'error');
            throw e;
        }
        this.pairsByPeerId.set(peerId, pairId);
        this.confirmRetries.delete(peerId);
        // A fresh secret supersedes ANY in-flight episode: an episode armed
        // before this exchange still holds the OLD base/role/epoch, so its
        // publishes ride retired topics and keys — and worse, it occupies
        // the pair's one episode slot, blocking every future repair from
        // using the new secret until the app restarts. enablePair() cancels
        // on ITS side, but a resumePair() racing in between (seen in field
        // logs: the launcher's enable-auto-reconnect calls resumePair first)
        // re-arms with the old record; commitment is the last safe gate.
        if (this.episodes.has(pairId)) {
            this._diag(`pair ${pairId}: fresh secret supersedes the in-flight episode (it held the old key) — cancelling it`);
            this._cancelEpisode(pairId);
        }
        this._diag(`pair ${pairId}: secret established (role=${ex.rec.role}, epoch 0, key check ${ex.check})${ex.legacy ? '' : ' — confirmed by peer'}`);
        this._emit('pair-established', { pairId, peerId, role: ex.rec.role });
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
            // Pairing frames ride no outbox: anything sent while the link
            // was down is gone. If an exchange is still in flight for this
            // peer, re-send its material now — a link flap mid-pairing used
            // to starve the exchange until it expired with nothing saved.
            this._serial(this._peerLocks, peerId, () => this._resumeExchangeLocked(peerId)).catch(() => {});
            const ep = this.episodes.get(pairId);
            if (ep && !ep.settled) {
                this._settleEpisode(pairId, ep);
            } else {
                this._updateRec(pairId, rec => {
                    if (!rec) return null;
                    rec.lastPeerId = peerId;
                    rec.lastSeenAt = Date.now();
                    delete rec.byeAt; // a live link supersedes any old hang-up
                    return rec;
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
            // Serialized read so a just-queued pausePair/bye is observed before
            // we commit to a role/delay (_startEpisode re-validates too).
            const rec = await this._serial(this._recWrites, pairId, () => dbGet(pairId).catch(() => null));
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
     * Reconcile the episode's live subscriptions with the CURRENT day-topic
     * window (yesterday/today/tomorrow). Used for the initial subscribe (the
     * topicSubs map starts empty, so every current topic is added) and by the
     * periodic refresh timer, which subscribes newly-current day topics and
     * drops aged ones — the fix for long-lived episodes going deaf after a UTC
     * midnight rollover.
     */
    async _refreshTopics(pairId, ep) {
        if (ep.settled || !ep.carrier) return;
        const want = await this._topics(ep);
        if (ep.settled) return;
        const wantSet = new Set(want);
        let added = 0, dropped = 0;
        for (const t of want) {
            if (ep.topicSubs.has(t)) continue;
            const unsub = ep.carrier.subscribe(t, (blob) => {
                this._onBlob(pairId, ep, blob).catch(() => {});
            });
            ep.topicSubs.set(t, unsub);
            ep.unsubs.push(unsub);
            added++;
        }
        for (const [t, unsub] of [...ep.topicSubs]) {
            if (wantSet.has(t)) continue;
            try { unsub(); } catch (e) {}
            ep.topicSubs.delete(t);
            const i = ep.unsubs.indexOf(unsub);
            if (i >= 0) ep.unsubs.splice(i, 1);
            dropped++;
        }
        if (added && dropped) {
            this._diag(`pair ${pairId}: day-topic rollover — +${added}/-${dropped}, now on ${ep.topicSubs.size} topic(s)`);
        }
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
        if (this.episodes.has(pairId) || this._startingEpisodes.has(pairId) || !this.options.carrierFactory) return;
        // Claim the start synchronously, BEFORE the dbGet await below. Two
        // triggers racing through that window (a terminal 'disconnected' status
        // vs a user Call; the rearm timer vs a status event) would otherwise both
        // build an episode and the second would overwrite the first in the map —
        // orphaning the first's carriers (redialing forever) while it publishes a
        // DIFFERENT offer nonce than the survivor: the exact competing-nonce
        // failure _promoteEpisode was built to eliminate, plus a carrier leak.
        this._startingEpisodes.add(pairId);
        let ep = null;
        try {
            // Serialized read: observe any queued record write (a just-received
            // bye, a racing pausePair) rather than a stale snapshot, so we don't
            // arm a full active repair against a peer that deliberately hung up.
            const rec = await this._serial(this._recWrites, pairId, () => dbGet(pairId).catch(() => null));
            if (!rec || !rec.enabled) {
                this._diag(`pair ${pairId}: episode not started (${!rec ? 'no stored secret' : 'pair disabled/paused'})`);
                return;
            }
            if (this._connectedPeerIdFor(pairId)) return;
            if (this.episodes.has(pairId)) return; // a concurrent path claimed the slot
            const byed = !!(rec.byeAt && rec.byeAt > (rec.lastSeenAt || 0));
            const standbyOnly = !!opts.standbyOnly || byed;
            const quiet = !!opts.quiet || standbyOnly;
            ep = {
                peerId, rec, settled: false, exchanged: false, usedEpoch: null,
                carrier: null, shadow: null, timers: [], unsubs: [], topicSubs: new Map(),
                phase: quiet ? 'quiet' : 'active', standbyOnly, announced: false,
                offerNonce: null, sealedOffer: null, ringNonce: null, sealedRing: null,
                answeredNonce: null, deadNonces: new Set(), seenRings: new Set(),
                // Persistent cross-episode replay defense (S-sec-4a): seed from
                // the record's history so a replayed prior-episode offer/ring is
                // rejected on sight. Grows as this episode processes new nonces.
                seenNonceSet: new Set(Array.isArray(rec.seenNonces) ? rec.seenNonces : []),
                lastShadowAt: 0, publishOnce: null, publishScheduled: false, answering: false,
                ownBlobs: new Set(), undecryptable: 0, lastNudgeAt: 0, republishWindowLogged: false
            };
            this.episodes.set(pairId, ep);
            // Slot is now claimed in `episodes` — release the start-guard so the
            // long carrier-connect awaits below don't block a legitimate fresh
            // start (e.g. a manual re-pairing that supersedes this very episode).
            // From here the `episodes.has` guard alone is sufficient.
            this._startingEpisodes.delete(pairId);
            // The key check names the ROOM this episode meets in: two devices
            // logging different checks hold different bases and can never hear
            // each other — the one question a pair of connection logs must answer.
            let check = 'unknown';
            try { check = await RC.keyCheck(rec.base); } catch (e) {}
            this._diag(`pair ${pairId}: episode started — role=${rec.role}, epoch=${rec.epoch || 0}, key check ${check}, phase=${ep.phase}${standbyOnly ? ' (standby-only' + (byed ? ', after bye' : '') + ')' : ''}`);
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
                if (ep.settled) { // cancelled while the carrier was dialing
                    try { ep.carrier.close(); } catch (e) {}
                    return;
                }
                await this._refreshTopics(pairId, ep); // initial subscribe (topicSubs empty)
                this._diag(`pair ${pairId}: carrier up, subscribed to ${ep.topicSubs.size} day-topic(s)`);
                // Publishers rotate to a new UTC-day topic at midnight. Without
                // resubscribing, a long-quiet/standby episode is left subscribed
                // only to topics nobody publishes on and goes silently deaf within
                // ~24-48h — breaking the "app open ⇒ reachable" promise. Re-check
                // topics every few hours so a new day-topic is always covered.
                this._every(ep, RENDEZVOUS_TOPIC_REFRESH_MS, () => this._refreshTopics(pairId, ep).catch(() => {}));
            // A broker session that comes BACK mid-episode (socket died in a
            // suspend, broker restarted) re-issues the subscriptions inside
            // the carrier — but everything we published into the dead socket
            // is gone (QoS 0), so republish the moment the session is up
            // instead of waiting out the current backoff slot. Unset until
            // after the FIRST session (connect() above), so the initial
            // schedule isn't doubled.
            ep.carrier.onSessionUp = () => {
                if (ep.settled || !ep.publishOnce) return;
                this._diag(`pair ${pairId}: carrier session restored — republishing now`);
                Promise.resolve(ep.publishOnce()).catch(() => {});
            };
                if (!ep.standbyOnly) {
                    if (rec.role === 'caller') await this._armCallerOffer(pairId, ep);
                    else await this._armRing(pairId, ep);
                    this._schedulePublishes(pairId, ep);
                }
            } catch (e) {
                this._failEpisode(pairId, ep, e.message);
            }
        } finally {
            this._startingEpisodes.delete(pairId);
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
            if (Date.now() - (ep.rec.lastSeenAt || 0) > this.options.resumeWindowMs) {
                // The only silent way out of the republish cadence — say so
                // ONCE, or a log reader sees "armed" and then nothing.
                if (!ep.republishWindowLogged) {
                    ep.republishWindowLogged = true;
                    this._diag(`pair ${pairId}: ${kind} republishing stopped — pair last seen over ${Math.round(this.options.resumeWindowMs / 3600000)}h ago (staying subscribe-only)`, 'warn');
                }
                return;
            }
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
        // Rate-limit decrypt work: an untrusted broker streaming ≤16 KB junk
        // blobs could otherwise buy unbounded AES-GCM attempts (up to EPOCH_WINDOW
        // per blob). Legitimate rendezvous is a few blobs/min, so a small token
        // bucket never touches real traffic. (Date.now is fine here — browser code.)
        const now = Date.now();
        if (ep._dtAt === undefined) { ep._dtTokens = 20; ep._dtAt = now; }
        ep._dtTokens = Math.min(20, ep._dtTokens + ((now - ep._dtAt) / 1000) * 10);
        ep._dtAt = now;
        if (ep._dtTokens < 1) {
            if (!ep._dtWarned) {
                ep._dtWarned = true;
                this._diag(`pair ${pairId}: decrypt rate limit hit — dropping excess sealed blobs (possible hostile/noisy broker)`, 'warn');
            }
            return;
        }
        ep._dtTokens -= 1;
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
            // Replayed doorbell — this episode (seenRings) or any prior one
            // (persistent seenNonceSet). A recorded ring must not re-provoke.
            if (ep.seenRings.has(ring.n) || ep.seenNonceSet.has(ring.n)) return true;
            ep.seenRings.add(ring.n);
            this._rememberNonce(pairId, ep, ring.n);
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
        // Retired this episode (deadNonces) or seen in any prior one
        // (persistent seenNonceSet) — a recorded offer replayed later is silence.
        if (payload.n && (ep.deadNonces.has(payload.n) || ep.seenNonceSet.has(payload.n))) return true;
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
        // Persist this offer's nonce now (not at retirement): the winning offer
        // never enters deadNonces, so recording here is what makes a replay of
        // it in a future episode dead on arrival. A same-nonce republish this
        // episode is caught by the seenNonceSet check above (ignored, correct).
        this._rememberNonce(pairId, ep, payload.n);
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
        // NOTE: the per-reconnect key ratchet is intentionally DISABLED.
        //
        // The old design advanced `rec.base` (and `rec.epoch`) on every sealed
        // reconnect. But each side decided to ratchet independently, from a
        // purely LOCAL condition (were both DTLS fingerprints available at the
        // instant this side settled?). There is no agreement step, so any
        // divergence — one side adopts the sealed connection while the other's
        // link heals in-band, or fingerprints populate a tick later on one end
        // — leaves the two sides on DIFFERENT base keys. Because the AEAD key
        // AND the daily topic both derive from `base`, a base split makes the
        // pair permanently deaf in both directions (the epoch window cannot
        // rescue a wrong key on a wrong topic): auto-reconnect bricks the pair
        // until a manual Start Over + fresh invite on BOTH devices.
        //
        // Freezing the secret removes that failure mode outright: both sides
        // always hold the exact key minted over DTLS at the last MANUAL
        // ceremony (`_establishPair` re-derives base and resets epoch 0 on both
        // ends simultaneously — symmetric by construction), and it never
        // changes underneath either of them during unattended reconnects. The
        // trade is forward secrecy on the rendezvous *signaling* keys between
        // manual pairings: those keys now rotate only on an in-person re-pair,
        // not on every auto-heal. Game traffic is unaffected (separately DTLS-
        // protected) and topics still rotate daily. Re-enabling a CORRECT
        // ratchet requires a two-sided commit over the live channel so both
        // ends advance together or neither does — tracked in the security-
        // hardening issue, deferred past the current "test what we have" phase.
        this._diag(ep.exchanged
            ? `pair ${pairId}: reconnected via sealed exchange — secret held stable (ratchet disabled)`
            : `pair ${pairId}: link recovered in-band — episode closed without touching the key`);
        ep.rec.lastPeerId = ep.peerId;
        ep.rec.lastSeenAt = Date.now();
        delete ep.rec.byeAt; // reconnected: any old hang-up is history
        try { await this._updateRec(pairId, () => ep.rec); } catch (e) {
            this._diag(`pair ${pairId}: FAILED to persist post-reconnect state (${e && e.message})`, 'error');
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
