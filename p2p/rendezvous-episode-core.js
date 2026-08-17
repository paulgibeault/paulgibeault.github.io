/* rendezvous-episode-core.js — the per-pair episode lifecycle as a pure,
 * Node-testable state machine.
 *
 * WHAT THIS IS. rendezvous.js used to spread each episode's state across a
 * plain object of booleans (settled/exchanged/announced/answering/…) with
 * transitions scattered over ~15 methods and every async gap patched by an
 * ad-hoc `if (ep.settled)` re-check. This module is that same behavior,
 * modeled: one machine per PAIR (not per episode object — the machine's
 * lifecycle starts at 'idle' and includes the pre-episode delay window, so
 * the old delayTimers/_startingEpisodes concurrency guards become states),
 * a single `transition(machine, event, cfg, now)` entry point, and effects
 * returned as data for the shell (RendezvousManager) to execute.
 *
 * PURITY CONTRACT. No I/O, no timers, no crypto, no Date.now() in here —
 * `now` and all randomness/crypto results arrive in event payloads. The
 * machine object passed in IS mutated (its Sets and counters are working
 * state); determinism holds for (machine, event, cfg, now) → effects.
 *
 * WIRE INVARIANCE. Nothing in this module touches bytes: sealing, epochs,
 * topics, payload shapes and cadences all stay in the shell. The machine
 * only decides WHAT happens next, never how it is encoded.
 *
 * ── Lifecycle states ────────────────────────────────────────────────────
 *   idle       no episode, no pending delay (pair may or may not be paired)
 *   scheduled  a delay timer owns the pair (legacy delayTimers):
 *                delayStage 'listener-wait' — the initial post-interrupt
 *                  grace (in-band repair gets first claim);
 *                'checking' — T_DELAY fired, the serialized record read is
 *                  in flight (legacy: the async body of the t1 callback);
 *                'caller-extra' — caller role waits out the extra delay;
 *                'rearm' — post-failure quiet re-arm (legacy _failEpisode)
 *   starting   beginSetup issued; the record read that decides whether an
 *              episode may claim the slot is in flight (legacy
 *              _startingEpisodes + the dbGet in _startEpisode)
 *   live       the episode slot is claimed (legacy episodes.set) — carrier
 *              build may still be in flight (setupPending) — until settle/
 *              cancel/fail. Presence (phase/standbyOnly) and exchange
 *              (exchanged/answering) run as context inside 'live'.
 *   (settled is TRANSIENT: settle/cancel/fail transitions emit cleanup
 *   effects and land back on 'idle' — or 'scheduled'(rearm) after a fail —
 *   in the same dispatch. The legacy `ep.settled = true` flag's job of
 *   killing in-flight async work is done by the generation counter below.)
 *
 * ── Generation counter ──────────────────────────────────────────────────
 * Every async effect the core issues (readRecord, beginSetup, armOffer,
 * armRing, buildAnswer) is stamped with machine.gen, and its completion
 * event must echo it. gen bumps whenever the work a completion belongs to
 * is superseded: entering starting, issuing a delay read, and every
 * settle/cancel/fail. A completion with a stale gen is dropped — this is
 * the principled form of the legacy post-await `if (ep.settled)` checks
 * (rendezvous.js used them at ~6 sites; races through those gaps are
 * documented field bugs, see the comment at _startEpisode).
 *
 * ── What deliberately stays in the shell ────────────────────────────────
 *   - Publish cadence timers (retrySchedule/_every): pure plumbing around
 *     `publishOnce`; the DECISIONS — may this pair still republish?
 *     (canPublish) and which cadence, active or standby? (the
 *     schedulePublishes effect's `standby` flag) — are the core's. Modeling
 *     each tick would add table rows with no decisions in them.
 *   - Day-topic refresh + carrier onSessionUp republish: carrier plumbing
 *     guarded by liveness the shell already knows.
 *   - ownBlobs echo-drop: blob-string identity bookkeeping.
 *   - All diagnostics text (never load-bearing); the core returns effect
 *     markers where a diag line belongs.
 *
 * ── Effects vocabulary (executed by the shell IN ORDER, awaited) ────────
 *   startTimer{id,ms} cancelTimer{id}       — id: 'delay'|'demote'|
 *                                             'stall'|`lstall:${nonce}`
 *   readRecord{gen}                          — serialized dbGet → DELAY_READ
 *   beginSetup{gen,opts}                     — dbGet + guards → SETUP_READ
 *   buildEpisode{gen}                        — carrier/keys/subscribe →
 *                                              SETUP_DONE | SETUP_FAILED
 *   emit{event,payload}                      — RendezvousManager events
 *   armOffer{gen} armRing{gen}               — → OFFER_ARMED | RING_ARMED
 *   schedulePublishes{standby} publishNow{} — standby picks the slow cadence
 *   adoptShadow{} acceptAnswer{payload}      — caller adoption pair
 *   buildAnswer{gen,payload}                 — → ANSWER_BUILD_READY|FAILED
 *   commitAnswer{} discardAnswer{}           — adopt+publish vs close pc
 *   rememberNonce{n}                         — persist to rec.seenNonces
 *   mapPeer{peerId}                          — pairsByPeerId binding
 *   ensureAlive{}                            — carrier socket check
 *   persistTouch{peerId}                     — lastSeen record write
 *   persistSettle{}                          — settle record write
 *   cleanup{}                                — timers/subs/shadow/carrier
 *   diagUndecryptable{count} diagIllegal{state,event}
 *
 * Formal protocol description: PROTOCOL.md §7.5. Behavior is modeled from
 * rendezvous.js v2.4 line by line; the legacy line references in the
 * handlers below are the audit trail.
 */

export const LIFECYCLE = Object.freeze(['idle', 'scheduled', 'starting', 'live']);

export const EVENTS = Object.freeze([
    // transport status (per pair)
    'INTERRUPTED', 'TERMINAL', 'CONNECTED',
    // scheduling / setup completions
    'T_DELAY', 'DELAY_READ', 'SETUP_READ', 'SETUP_DONE', 'SETUP_FAILED',
    // api triggers
    'RESUME', 'STANDBY', 'PROMOTE', 'NUDGE', 'CANCEL',
    // exchange (post-decrypt) + completions
    'ANSWER_OPENED', 'RING_OPENED', 'OFFER_OPENED', 'BLOB_UNOPENED',
    'OFFER_ARMED', 'RING_ARMED', 'ANSWER_BUILD_READY', 'ANSWER_BUILD_FAILED',
    // timers
    'T_DEMOTE', 'T_ANSWER_STALL', 'T_LISTENER_STALL',
]);

/** Fresh machine for one pair. */
export function initialMachine() {
    return {
        lifecycle: 'idle',
        gen: 0,              // async-completion generation (see header)
        delayStage: null,    // scheduled: 'listener-wait'|'checking'|'caller-extra'|'rearm'
        peerId: null,        // the transport peerId this cycle repairs
        startOpts: null,     // {standbyOnly, quiet} carried into beginSetup
        // live context (legacy ep.* flags)
        setupPending: false,
        role: null,
        phase: null,         // 'active' | 'quiet'
        standbyOnly: false,
        // This standby exists because the PEER said goodbye, not because we
        // launched cold. Both look identical from standbyOnly alone, and
        // they want opposite things from the listener's ring (see SETUP_DONE).
        byed: false,
        announced: false,
        exchanged: false,
        answering: false,
        // Something concrete asked this episode to initiate: a sealed frame
        // from the peer landed, or the user tapped Call. It is the difference
        // between shouting into the void and answering a doorbell, and it is
        // what canPublish() uses to pick a bound (see there).
        provoked: false,
        publishScheduled: false,
        offerArmed: false,   // legacy: !!ep.sealedOffer
        ringArmed: false,    // legacy: !!ep.sealedRing
        offerNonce: null,
        answeredNonce: null,
        lastShadowAt: 0,
        lastNudgeAt: 0,
        republishWindowLogged: false,
        undecryptable: 0,
        dtTokens: 20,        // decrypt token bucket (legacy ep._dtTokens)
        dtAt: null,
        dtWarned: false,
        deadNonces: new Set(),
        seenRings: new Set(),
        seenNonceSet: new Set(),  // seeded from rec.seenNonces at SETUP_READ
    };
}

// ── pure helpers used by the shell outside transition() ─────────────────

/**
 * Decrypt-work token bucket (legacy _onBlob lines: 20 tokens, +10/s).
 * Mutates the bucket fields; returns {allow, warnOnce} — warnOnce is true
 * exactly once, on the first exhausted hit.
 */
export function takeDecryptToken(m, now) {
    if (m.dtAt === null) { m.dtTokens = 20; m.dtAt = now; }
    m.dtTokens = Math.min(20, m.dtTokens + ((now - m.dtAt) / 1000) * 10);
    m.dtAt = now;
    if (m.dtTokens < 1) {
        const warnOnce = !m.dtWarned;
        m.dtWarned = true;
        return { allow: false, warnOnce };
    }
    m.dtTokens -= 1;
    return { allow: true, warnOnce: false };
}

/**
 * Which sealed-frame kinds are worth an AEAD attempt for this blob, in
 * order. Mirrors the legacy pre-decrypt guards exactly:
 *   caller  → 'answer' only while an offer is armed (usedEpoch + shadow —
 *             legacy _onCallerAnswer:1320); 'ring' only while no exchange
 *             is in flight (legacy _onCallerRing:1367). Note an exchanged
 *             caller still TRIES 'answer' (and ignores the result) — that
 *             token spend is legacy behavior, kept.
 *   listener→ 'offer' only while not mid-answer (legacy 1401).
 * Empty array ⇒ don't decrypt, don't count undecryptable.
 */
export function tryKinds(m) {
    if (m.lifecycle !== 'live') return [];
    if (m.role === 'caller') {
        const kinds = [];
        if (m.offerArmed) kinds.push('answer');
        if (!m.exchanged) kinds.push('ring');
        return kinds;
    }
    return m.answering ? [] : ['offer'];
}

/**
 * May this pair still republish its offer/ring? (Legacy publishOnce gate,
 * rendezvous.js:1238-1247.) Returns {ok, logStop, boundMs}: logStop is true
 * exactly once, when the applicable bound first closes.
 *
 * TWO bounds, because there are two kinds of publishing and they were being
 * held to one rule:
 *
 *   SPECULATIVE — an episode armed by a link drop or resumeAll, shouting on
 *     the chance the peer shows up. Bounded by resumeWindowMs: after six
 *     hours of no contact, stay subscribed (reachable) but stop the noise.
 *   STANDBY or PROVOKED — the standby listener's slow ring, and any episode
 *     that has just heard a sealed frame from its peer or been told to Call.
 *     Bounded by standbyMaxAgeMs, the same horizon standbyAll() uses to
 *     decide the pair is worth arming at all.
 *
 * One bound for both is what made the field failure of 2026-08-16 survivable
 * only by re-ceremony: with the pair last seen 31.9h earlier, EVERY publish
 * was refused — a ring-provoked offer, and a user's Call, along with the
 * speculative traffic the rule was written for. Fixing the standby ring
 * without fixing this would have changed nothing: the ring would have been
 * armed, scheduled, and then silently dropped at this gate.
 */
export function canPublish(m, lastSeenAt, now, cfg) {
    const boundMs = (m.standbyOnly || m.provoked) ? cfg.standbyMaxAgeMs : cfg.resumeWindowMs;
    if (now - (lastSeenAt || 0) <= boundMs) return { ok: true, logStop: false, boundMs };
    const logStop = !m.republishWindowLogged;
    m.republishWindowLogged = true;
    return { ok: false, logStop, boundMs };
}

// ── transition ──────────────────────────────────────────────────────────

const ok = (effects = []) => ({ effects, ignored: false });
const ignore = () => ({ effects: [], ignored: true });

/**
 * Applies one event. Returns { effects, ignored }. Unknown event types
 * throw always; a (state, event) combination with no row is a no-op that
 * throws under opts.strict (unit tests) and returns a diagIllegal effect
 * otherwise. Async completion events whose `gen` is stale are silently
 * ignored — that is the designed replacement for the legacy post-await
 * re-checks, never an error.
 */
export function transition(m, ev, cfg, now, opts = {}) {
    if (!EVENTS.includes(ev.type)) throw new Error(`unknown event ${ev.type}`);

    // Stale async completion: superseded work finishing late. Always benign.
    const GEN_EVENTS = ['DELAY_READ', 'SETUP_READ', 'SETUP_DONE', 'SETUP_FAILED',
        'OFFER_ARMED', 'RING_ARMED', 'ANSWER_BUILD_READY', 'ANSWER_BUILD_FAILED'];
    if (GEN_EVENTS.includes(ev.type) && ev.gen !== m.gen) return ignore();

    const row = HANDLERS[ev.type];
    const fn = row && row[m.lifecycle];
    if (!fn) {
        if (opts.strict) throw new Error(`illegal event ${ev.type} in state ${stateName(m)}`);
        return { effects: [{ t: 'diagIllegal', state: stateName(m), event: ev.type }], ignored: true };
    }
    return fn(m, ev, cfg, now) || ignore();
}

/** Human-readable compound state, for diagnostics and tests. */
export function stateName(m) {
    if (m.lifecycle === 'scheduled') return `scheduled(${m.delayStage})`;
    if (m.lifecycle !== 'live') return m.lifecycle;
    return `live(${m.standbyOnly ? 'standby' : m.phase}/${m.answering ? 'answering' : m.exchanged ? 'adopting' : 'none'})`;
}

// ---- shared fragments --------------------------------------------------

/** Enter 'starting': issue the guarded record read that may claim the slot. */
function toStarting(m, peerId, startOpts) {
    m.gen++;
    m.lifecycle = 'starting';
    m.delayStage = null;
    m.peerId = peerId;
    m.startOpts = startOpts || {};
    return ok([{ t: 'beginSetup', gen: m.gen, opts: m.startOpts }]);
}

/** Reset every live/scheduled field back to idle (post cleanup/settle). */
function resetToIdle(m) {
    m.lifecycle = 'idle';
    m.delayStage = null;
    m.startOpts = null;
    m.setupPending = false;
    m.role = null;
    m.phase = null;
    m.standbyOnly = false;
    m.byed = false;
    m.announced = false;
    m.exchanged = false;
    m.answering = false;
    m.provoked = false;
    m.publishScheduled = false;
    m.offerArmed = false;
    m.ringArmed = false;
    m.offerNonce = null;
    m.answeredNonce = null;
    m.lastShadowAt = 0;
    m.lastNudgeAt = 0;
    m.republishWindowLogged = false;
    m.undecryptable = 0;
    m.dtTokens = 20; m.dtAt = null; m.dtWarned = false;
    m.deadNonces = new Set();
    m.seenRings = new Set();
    m.seenNonceSet = new Set();
}

/**
 * Settle from 'live' (legacy _settleEpisode): persist, clean up, emit.
 * exchangedNow distinguishes 'reconnected' from 'recovered-inband'.
 */
function settle(m) {
    const exchanged = m.exchanged;
    const peerId = m.peerId;
    m.gen++; // kill in-flight setup/arm/build completions
    const effects = [
        // exchanged rides the effect: the shell needs it after the machine
        // context has already reset (and a future ratchet commit would hook
        // in exactly here, with exchanged/peerId in hand).
        { t: 'persistSettle', peerId, exchanged },
        { t: 'cleanup' },
        { t: 'emit', event: exchanged ? 'reconnected' : 'recovered-inband', payload: { peerId } },
    ];
    resetToIdle(m);
    return ok(effects);
}

/** Hard failure from 'live' (legacy _failEpisode): cleanup + quiet re-arm. */
function fail(m, why, cfg) {
    const announced = m.announced;
    const peerId = m.peerId;
    m.gen++;
    const effects = [{ t: 'cleanup' }];
    if (announced) effects.push({ t: 'emit', event: 'gave-up', payload: { peerId, why } });
    resetToIdle(m);
    m.lifecycle = 'scheduled';
    m.delayStage = 'rearm';
    m.peerId = peerId;
    effects.push({ t: 'startTimer', id: 'delay', ms: cfg.rearmDelayMs });
    return ok(effects);
}

/**
 * Arm-or-refresh decision for the caller's offer (legacy freshness rule at
 * 573/634/1387: fresh shadow when none exists or ours has aged >30s — the
 * network may have moved under the gathered candidates).
 */
function offerIsStale(m, now) {
    return !m.offerArmed || now - m.lastShadowAt > 30000;
}

/**
 * Append schedulePublishes once (legacy _schedulePublishes idempotence).
 * The effect carries the cadence the shell should install: a standby ring
 * goes out on the slow one — it is a background presence beacon, not a
 * repair in progress, and every publish is a write a passive broker observer
 * can count (§7.5/§9).
 */
function pushSchedule(m, effects) {
    if (!m.publishScheduled) {
        m.publishScheduled = true;
        effects.push({ t: 'schedulePublishes', standby: !!m.standbyOnly });
    }
}

/**
 * This standby episode now has a reason to initiate. Two things follow:
 * canPublish() moves to the standby bound (it just heard from the peer, or
 * its user asked), and the slow ring cadence has to be replaced by the
 * active one — so the publishScheduled latch is dropped and the pushSchedule
 * that always follows this call re-issues the effect. `standbyOnly` only
 * ever goes true→false, so the cadence can only ever be upgraded.
 *
 * Callers that do NOT follow with a pushSchedule must not use this: clearing
 * the latch without re-scheduling would make NUDGE's `!publishScheduled`
 * guard mute the episode.
 */
function provoke(m) {
    m.provoked = true;
    m.republishWindowLogged = false; // the bound changed; a later stop is news again
    if (!m.standbyOnly) return;
    m.standbyOnly = false;
    m.publishScheduled = false;
}

// ---- the table ---------------------------------------------------------
// HANDLERS[eventType][lifecycle] → handler. A missing entry means the
// combination is illegal (strict mode throws). Explicit no-op rows return
// ok([]) — they are LEGAL silences, asserted as such by the unit suite.

const HANDLERS = {
    // Link interrupted (legacy _onStatus 'interrupted' → _scheduleEpisode).
    // Only an idle pair schedules; a scheduled/starting/live pair already
    // owns the repair (legacy guard: delayTimers.has || episodes.has).
    INTERRUPTED: {
        idle: (m, ev, cfg) => {
            m.lifecycle = 'scheduled';
            m.delayStage = 'listener-wait';
            m.peerId = ev.peerId;
            return ok([{ t: 'startTimer', id: 'delay', ms: cfg.listenerDelayMs }]);
        },
        scheduled: () => ok([]),
        starting: () => ok([]),
        live: () => ok([]),
    },

    // Terminal link loss (legacy 'disconnected'/'failed'/'closed' →
    // _clearDelay + _startEpisode).
    TERMINAL: {
        idle: (m, ev) => toStarting(m, ev.peerId, {}),
        scheduled: (m, ev) => {
            const r = toStarting(m, ev.peerId, {});
            r.effects.unshift({ t: 'cancelTimer', id: 'delay' });
            return r;
        },
        starting: () => ok([]), // legacy _startEpisode reentry guard
        live: () => ok([]),     // episode already repairing this pair
    },

    // Link (back) up (legacy _onStatus 'connected').
    CONNECTED: {
        idle: (m, ev) => ok([{ t: 'persistTouch', peerId: ev.peerId }]),
        scheduled: (m, ev) => {
            resetToIdle(m);
            m.gen++; // a 'checking' read in flight must not land later
            return ok([{ t: 'cancelTimer', id: 'delay' }, { t: 'persistTouch', peerId: ev.peerId }]);
        },
        // Pre-claim: the episode hasn't claimed the slot, so the legacy code
        // takes the record-touch branch (ep undefined at _onStatus:918);
        // SETUP_READ's connectedNow then aborts the claim.
        starting: (m, ev) => ok([{ t: 'persistTouch', peerId: ev.peerId }]),
        live: (m) => settle(m),
    },

    // The delay timer fired (legacy t1/t2/rearm callbacks).
    T_DELAY: {
        scheduled: (m, ev, cfg) => {
            if (m.delayStage === 'listener-wait') {
                // t1: serialized record read decides role/enabled (949-967).
                m.gen++;
                m.delayStage = 'checking';
                return ok([{ t: 'readRecord', gen: m.gen }]);
            }
            if (m.delayStage === 'caller-extra') {
                // t2: only the liveness check, then start (960-964).
                if (ev.connectedNow) { resetToIdle(m); return ok([]); }
                return toStarting(m, m.peerId, {});
            }
            if (m.delayStage === 'rearm') {
                // post-failure re-arm starts QUIET (1578).
                return toStarting(m, m.peerId, { quiet: true });
            }
            return ok([]); // 'checking': spurious duplicate timer fire
        },
    },

    // The scheduled-path record read completed (legacy t1 async body).
    DELAY_READ: {
        scheduled: (m, ev, cfg) => {
            if (m.delayStage !== 'checking') return ignore();
            if (!ev.rec || !ev.rec.enabled) { resetToIdle(m); return ok([]); }
            if (ev.connectedNow) { resetToIdle(m); return ok([]); }
            if (ev.rec.role === 'listener') return toStarting(m, m.peerId, {});
            m.delayStage = 'caller-extra';
            const extra = Math.max(0, cfg.callerDelayMs - cfg.listenerDelayMs);
            return ok([{ t: 'startTimer', id: 'delay', ms: extra }]);
        },
    },

    // The setup record read completed: claim the slot or abort (legacy
    // _startEpisode 1099-1141 up to the carrier build).
    SETUP_READ: {
        starting: (m, ev, cfg) => {
            if (!ev.rec || !ev.rec.enabled) { resetToIdle(m); return ok([]); }
            if (ev.connectedNow) { resetToIdle(m); return ok([]); }
            const standbyOnly = !!(m.startOpts.standbyOnly || ev.rec.byedRecently);
            const quiet = !!(m.startOpts.quiet || standbyOnly);
            m.lifecycle = 'live';
            m.setupPending = true;
            m.role = ev.rec.role;
            m.standbyOnly = standbyOnly;
            m.byed = !!ev.rec.byedRecently;
            m.phase = quiet ? 'quiet' : 'active';
            m.seenNonceSet = new Set(Array.isArray(ev.rec.seenNonces) ? ev.rec.seenNonces : []);
            const effects = [{ t: 'buildEpisode', gen: m.gen }];
            if (!quiet) {
                m.announced = true;
                effects.push({ t: 'emit', event: 'reconnecting', payload: { peerId: m.peerId, role: m.role } });
            }
            effects.push({ t: 'startTimer', id: 'demote', ms: cfg.episodeTimeoutMs });
            return ok(effects);
        },
    },

    // Carrier up + subscribed (legacy 1145-1174 tail of _startEpisode).
    //
    // Standby used to arm nothing at all, in either role. That made a pair
    // whose two devices both launched outside their resume window a mutual
    // deadlock: both sides correctly subscribed to the same day-topics, both
    // waiting for an inbound frame, neither ever sending one. Three phones
    // sat in it for a day and a half on 2026-08-16, and only a manual Call
    // could break it (plans/connection-model-2026-08.md).
    //
    // The LISTENER now rings while in standby — a ring is a doorbell, not an
    // offer: it carries no SDP, mints no shadow connection, and asks the
    // caller role for the offer. It publishes on a topic this device is
    // already subscribed to, so the marginal exposure is going from silent
    // reader to occasional writer on a channel already claimed (the §7.5/§9
    // trade, taken deliberately). The CALLER stays completely silent: it has
    // the expensive half of the exchange, and an inbound ring provokes it
    // (RING_OPENED) at the moment there is someone to answer.
    //
    // A standby that exists because the peer sent a BYE stays silent in both
    // roles. A bye is a person saying "I am closing this on purpose"; the
    // hanging-up side pauses the pair and stops listening, so a ring there
    // would be publishes nobody hears, and answering a goodbye with a
    // doorbell is not what the frame means. Their Call, or ours, revives it
    // (PROMOTE clears the standby; resumePair clears rec.byeAt).
    SETUP_DONE: {
        live: (m) => {
            m.setupPending = false;
            if (m.standbyOnly && (m.role === 'caller' || m.byed)) return ok([]);
            const effects = [m.role === 'caller'
                ? { t: 'armOffer', gen: m.gen }
                : { t: 'armRing', gen: m.gen }];
            pushSchedule(m, effects);
            return ok(effects);
        },
    },

    SETUP_FAILED: {
        live: (m, ev, cfg) => fail(m, ev.why, cfg),
    },

    // resumePair with no live episode (legacy 540-543): fully active start.
    RESUME: {
        idle: (m, ev) => toStarting(m, ev.peerId, {}),
        scheduled: (m, ev) => {
            const r = toStarting(m, ev.peerId, {});
            r.effects.unshift({ t: 'cancelTimer', id: 'delay' });
            return r;
        },
        starting: () => ok([]), // legacy reentry guard drops it
    },

    // standbyAll per pair (legacy 1015): subscribe-only start.
    STANDBY: {
        idle: (m, ev) => toStarting(m, ev.peerId, { standbyOnly: true }),
        scheduled: () => ok([]), // legacy _startEpisode guard (delay owns it… it didn't — see note)
        starting: () => ok([]),
        live: () => ok([]),
    },

    // Escalate to fully-active on a user Call (legacy _promoteEpisode).
    PROMOTE: {
        live: (m, ev, cfg, now) => {
            provoke(m); // a Call also lifts the publish bound and the slow cadence
            const effects = [];
            if (m.phase !== 'active') {
                m.phase = 'active';
                effects.push({ t: 'startTimer', id: 'demote', ms: cfg.episodeTimeoutMs });
            }
            if (!m.announced) {
                m.announced = true;
                effects.push({ t: 'emit', event: 'reconnecting', payload: { peerId: m.peerId, role: m.role } });
            }
            if (m.exchanged) return ok(effects); // in-flight adoption finishes (567)
            if (m.role === 'caller') {
                if (offerIsStale(m, now)) effects.push({ t: 'armOffer', gen: m.gen });
            } else if (!m.ringArmed) {
                effects.push({ t: 'armRing', gen: m.gen });
            }
            pushSchedule(m, effects);
            effects.push({ t: 'publishNow' });
            return ok(effects);
        },
    },

    // Foreground/network kick (legacy _nudgeEpisode).
    //
    // `publishScheduled` is the whole standby distinction here: a standby
    // LISTENER has a ring on a cadence and republishes it (a device thawing
    // from a background freeze published its last ring into a socket the
    // broker had already dropped, and nobody but us retries QoS 0), while a
    // standby CALLER never scheduled anything and so still gets only the
    // socket check. The 5s cap keeps visibility flapping off the relay.
    NUDGE: {
        live: (m, ev, cfg, now) => {
            const effects = [{ t: 'ensureAlive' }];
            if (m.exchanged || !m.publishScheduled) return ok(effects);
            if (now - m.lastNudgeAt < 5000) return ok(effects);
            m.lastNudgeAt = now;
            if (m.role === 'caller' && offerIsStale(m, now)) {
                effects.push({ t: 'armOffer', gen: m.gen });
            }
            effects.push({ t: 'publishNow' });
            return ok(effects);
        },
    },

    // Deliberate teardown: pause/disable/bye/superseding re-pair (legacy
    // _cancelEpisode — reachable from every non-idle state).
    CANCEL: {
        idle: () => ok([]),
        scheduled: (m) => {
            m.gen++;
            resetToIdle(m);
            return ok([{ t: 'cancelTimer', id: 'delay' }]);
        },
        starting: (m) => { m.gen++; resetToIdle(m); return ok([]); },
        live: (m) => {
            m.gen++;
            resetToIdle(m);
            return ok([{ t: 'cleanup' }]);
        },
    },

    // Caller ← answer, already AEAD-opened by the shell (legacy
    // _onCallerAnswer post-open, 1323-1361). `consumed` is implicit: the
    // shell only dispatches this when the blob opened as an answer.
    ANSWER_OPENED: {
        live: (m, ev, cfg) => {
            if (!ev.decodeOk) return ok([]);
            if (!ev.peerIdMatch) return ok([]);
            if (ev.n && m.offerNonce && ev.n !== m.offerNonce) return ok([]); // superseded offer
            if (m.exchanged) return ok([]); // already applying an answer
            if (ev.liveConnected) return settle(m); // in-band won (1336-1341)
            m.exchanged = true;
            return ok([
                { t: 'adoptShadow' },
                { t: 'acceptAnswer', payload: ev.payload },
                { t: 'startTimer', id: 'stall', ms: cfg.answerStallMs },
            ]);
        },
    },

    // Caller's adopted answer never connected (legacy stall at 1350-1360).
    T_ANSWER_STALL: {
        live: (m, ev) => {
            if (ev.connectedNow) return ok([]);
            if (!m.exchanged) return ok([]); // already unlatched/superseded
            m.exchanged = false;
            return ok([{ t: 'armOffer', gen: m.gen }, { t: 'publishNow' }]);
        },
    },

    // Caller ← ring (legacy _onCallerRing post-open, 1370-1395).
    RING_OPENED: {
        live: (m, ev, cfg, now) => {
            if (!ev.parseOk) return ok([]);
            if (!ev.peerIdMatch) return ok([]);
            const effects = [];
            if (ev.n) {
                if (m.seenRings.has(ev.n) || m.seenNonceSet.has(ev.n)) return ok([]); // replay
                // Remembered BEFORE the liveness check — legacy order (1373-1381).
                m.seenRings.add(ev.n);
                m.seenNonceSet.add(ev.n);
                effects.push({ t: 'rememberNonce', n: ev.n });
            }
            if (ev.liveConnected) return ok(effects);
            provoke(m); // this standby now initiates (1383) — the doorbell rang
            if (offerIsStale(m, now)) effects.push({ t: 'armOffer', gen: m.gen });
            pushSchedule(m, effects);
            effects.push({ t: 'publishNow' });
            return ok(effects);
        },
    },

    // Listener ← offer (legacy _onListenerOffer post-open, 1405-1433).
    // The answering pre-gate lives in tryKinds(); here answering === false.
    OFFER_OPENED: {
        live: (m, ev) => {
            if (!ev.decodeOk) return ok([]);
            if (!ev.peerIdValid) return ok([]);
            if (ev.n && (m.deadNonces.has(ev.n) || m.seenNonceSet.has(ev.n))) return ok([]);
            if (ev.liveConnected) return ok([]); // in-band won / already connected
            if (m.exchanged && (!ev.n || ev.n === m.answeredNonce)) return ok([]); // republish of the answered offer
            // (a DIFFERENT nonce while exchanged supersedes the stale attempt)
            m.answering = true;
            m.exchanged = true;
            // Provoked, but deliberately NOT through provoke(): answering
            // publishes on its own schedule (commitAnswer), so there is no
            // pushSchedule here to re-issue the cadence with.
            m.standbyOnly = false;
            m.provoked = true;
            m.republishWindowLogged = false;
            m.answeredNonce = ev.n || null;
            m.peerId = ev.peerId;
            if (ev.n) m.seenNonceSet.add(ev.n);
            const effects = [
                { t: 'rememberNonce', n: ev.n },
                { t: 'mapPeer', peerId: ev.peerId },
                { t: 'buildAnswer', gen: m.gen, payload: ev.payload },
            ];
            return ok(effects);
        },
    },

    // The listener's slow answer build finished (legacy 1447-1490).
    ANSWER_BUILD_READY: {
        live: (m, ev, cfg) => {
            m.answering = false;
            if (ev.liveConnected) {
                // Link recovered while answering: keep it, discard the answer.
                const n = m.answeredNonce;
                if (n) m.deadNonces.add(n);
                m.exchanged = false;
                m.answeredNonce = null;
                return ok([{ t: 'discardAnswer' }]);
            }
            return ok([
                { t: 'commitAnswer' },
                { t: 'startTimer', id: `lstall:${m.answeredNonce || ''}`, ms: cfg.answerStallMs },
            ]);
        },
    },

    ANSWER_BUILD_FAILED: {
        live: (m) => {
            m.answering = false;
            m.exchanged = false; // legacy catch (1493); answeredNonce deliberately kept
            return ok([]);
        },
    },

    // The listener's answered offer never connected (legacy 1483-1490).
    // Overlapping stalls after a supersede are real: each retires ITS nonce
    // and only unlatches when it is still the current attempt.
    T_LISTENER_STALL: {
        live: (m, ev) => {
            if (ev.connectedNow) return ok([]);
            if (ev.n) m.deadNonces.add(ev.n);
            if (m.answeredNonce === (ev.n || null)) m.exchanged = false;
            return ok([]);
        },
    },

    // A blob opened under none of the attempted kinds (legacy 1304-1315).
    BLOB_UNOPENED: {
        live: (m) => {
            if (m.exchanged) return ok([]);
            m.undecryptable++;
            const show = m.undecryptable <= 5 || m.undecryptable % 20 === 0;
            return ok(show ? [{ t: 'diagUndecryptable', count: m.undecryptable }] : []);
        },
    },

    // Active window elapsed (legacy _demoteEpisode).
    T_DEMOTE: {
        live: (m) => {
            if (m.phase === 'quiet') return ok([]);
            m.phase = 'quiet';
            return ok(m.announced
                ? [{ t: 'emit', event: 'gave-up', payload: { peerId: m.peerId, why: 'timeout', standby: true } }]
                : []);
        },
    },

    // The caller's shadow offer finished arming (async completion).
    OFFER_ARMED: {
        live: (m, ev, cfg, now) => {
            m.offerArmed = true;
            m.offerNonce = ev.n;
            m.lastShadowAt = now;
            return ok([]);
        },
    },

    RING_ARMED: {
        live: (m) => { m.ringArmed = true; return ok([]); },
    },
};

/**
 * The lifecycles in which `evType` has a row — the table's shape as data,
 * so the unit suite can walk every (state, event) pair and assert that
 * legality never drifts silently.
 */
export function legalLifecycles(evType) {
    const row = HANDLERS[evType];
    return row ? Object.keys(row) : [];
}

export default { initialMachine, transition, tryKinds, takeDecryptToken, canPublish, stateName, LIFECYCLE, EVENTS, legalLifecycles };
