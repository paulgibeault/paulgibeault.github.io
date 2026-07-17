/* rendezvous-machine-unit.mjs — hermetic Node unit tests for the episode
 * state machine (p2p/rendezvous-episode-core.js).
 *
 * The machine models rendezvous.js's episode lifecycle exactly (the legacy
 * line references live in the core's handlers); this suite proves the model
 * in isolation before the shell is migrated onto it:
 *   • an exhaustiveness walk pinning the table's legality shape
 *   • the full happy paths (sealed exchange, in-band win) both roles
 *   • the field-bug scenarios the ad-hoc flags used to guard by hand:
 *     stale async completions (gen), answerStall retire-and-rearm,
 *     listener supersede, replay defense, promote/nudge semantics
 *
 * No browser, no crypto, no timers. Run: `node tools/rendezvous-machine-unit.mjs`.
 */
import {
    initialMachine, transition, tryKinds, takeDecryptToken, canPublish,
    stateName, EVENTS, legalLifecycles,
} from '../p2p/rendezvous-episode-core.js';

let pass = 0, fail = 0;
function ok(cond, label) {
    if (cond) { pass++; console.log('  ✓ ' + label); }
    else { fail++; console.log('  ✗ ' + label); }
}

const CFG = {
    listenerDelayMs: 15000, callerDelayMs: 30000, episodeTimeoutMs: 600000,
    answerStallMs: 30000, rearmDelayMs: 60000, resumeWindowMs: 6 * 3600 * 1000,
};

let NOW = 1_000_000;
const drive = (m, ev) => transition(m, ev, CFG, NOW, { strict: true });
const types = (r) => r.effects.map((e) => e.t);
const effOf = (r, t) => r.effects.find((e) => e.t === t);

// Walks a machine to a claimed live episode of the given role.
function toLive(role, { standby = false, byed = false } = {}) {
    const m = initialMachine();
    if (standby) drive(m, { type: 'STANDBY', peerId: 'P1' });
    else drive(m, { type: 'TERMINAL', peerId: 'P1' });
    drive(m, { type: 'SETUP_READ', gen: m.gen, rec: { enabled: true, role, byedRecently: byed }, connectedNow: false });
    drive(m, { type: 'SETUP_DONE', gen: m.gen });
    return m;
}

function tableShape() {
    console.log('\ntable shape — legality pinned per (lifecycle, event)');
    // The expected shape, spelled out. Editing the table means editing this
    // pin in the same commit — that is the point.
    const EXPECT = {
        INTERRUPTED: ['idle', 'scheduled', 'starting', 'live'],
        TERMINAL: ['idle', 'scheduled', 'starting', 'live'],
        CONNECTED: ['idle', 'scheduled', 'starting', 'live'],
        T_DELAY: ['scheduled'],
        DELAY_READ: ['scheduled'],
        SETUP_READ: ['starting'],
        SETUP_DONE: ['live'],
        SETUP_FAILED: ['live'],
        RESUME: ['idle', 'scheduled', 'starting'],
        STANDBY: ['idle', 'scheduled', 'starting', 'live'],
        PROMOTE: ['live'],
        NUDGE: ['live'],
        CANCEL: ['idle', 'scheduled', 'starting', 'live'],
        ANSWER_OPENED: ['live'],
        RING_OPENED: ['live'],
        OFFER_OPENED: ['live'],
        BLOB_UNOPENED: ['live'],
        OFFER_ARMED: ['live'],
        RING_ARMED: ['live'],
        ANSWER_BUILD_READY: ['live'],
        ANSWER_BUILD_FAILED: ['live'],
        T_DEMOTE: ['live'],
        T_ANSWER_STALL: ['live'],
        T_LISTENER_STALL: ['live'],
    };
    let drift = 0;
    for (const ev of EVENTS) {
        const got = legalLifecycles(ev).sort().join(',');
        const want = (EXPECT[ev] || []).sort().join(',');
        if (got !== want) { drift++; console.log(`    drift on ${ev}: got [${got}] want [${want}]`); }
    }
    ok(drift === 0, 'every event is legal in exactly the pinned lifecycles');
    ok(EVENTS.every((e) => EXPECT[e] !== undefined), 'the pin covers every declared event');

    // Illegal combos: strict throws, prod mode records a diagIllegal.
    const m = initialMachine();
    let threw = false;
    try { drive(m, { type: 'PROMOTE' }); } catch (e) { threw = true; }
    ok(threw, 'strict mode throws on an illegal (state, event) combo');
    const r = transition(m, { type: 'PROMOTE' }, CFG, NOW);
    ok(r.ignored && types(r).includes('diagIllegal'), 'prod mode ignores it with a diagIllegal effect');
    let unknown = false;
    try { transition(m, { type: 'NOT_A_THING' }, CFG, NOW); } catch (e) { unknown = true; }
    ok(unknown, 'an unknown event type always throws');
}

function schedulingTests() {
    console.log('\nscheduling — interrupted delays, terminal starts, connected clears');
    const m = initialMachine();
    let r = drive(m, { type: 'INTERRUPTED', peerId: 'P1' });
    ok(stateName(m) === 'scheduled(listener-wait)' && effOf(r, 'startTimer')?.ms === CFG.listenerDelayMs,
        'interrupted: idle → scheduled(listener-wait) with the listener delay');
    r = drive(m, { type: 'INTERRUPTED', peerId: 'P1' });
    ok(r.effects.length === 0, 'a second interrupt while scheduled is a legal no-op (no duplicate timer)');

    r = drive(m, { type: 'T_DELAY' });
    ok(stateName(m) === 'scheduled(checking)' && types(r).includes('readRecord'),
        't1 fires → record read in flight (checking)');
    const gen = m.gen;
    r = drive(m, { type: 'DELAY_READ', gen, rec: { enabled: true, role: 'caller' }, connectedNow: false });
    ok(stateName(m) === 'scheduled(caller-extra)' && effOf(r, 'startTimer')?.ms === CFG.callerDelayMs - CFG.listenerDelayMs,
        'caller role → extra delay armed for the difference');
    r = drive(m, { type: 'T_DELAY', connectedNow: true });
    ok(stateName(m) === 'idle', 'caller-extra fires while connected → back to idle (no episode)');

    // Listener path goes straight to starting.
    const l = initialMachine();
    drive(l, { type: 'INTERRUPTED', peerId: 'P1' });
    drive(l, { type: 'T_DELAY' });
    r = drive(l, { type: 'DELAY_READ', gen: l.gen, rec: { enabled: true, role: 'listener' }, connectedNow: false });
    ok(stateName(l) === 'starting' && types(r).includes('beginSetup'), 'listener role → starting immediately');

    // Disabled/paused record ends the cycle.
    const d = initialMachine();
    drive(d, { type: 'INTERRUPTED', peerId: 'P1' });
    drive(d, { type: 'T_DELAY' });
    drive(d, { type: 'DELAY_READ', gen: d.gen, rec: { enabled: false, role: 'caller' }, connectedNow: false });
    ok(stateName(d) === 'idle', 'a paused/disabled pair never schedules an episode');

    // CONNECTED while checking: idle + the in-flight read must land stale.
    const c = initialMachine();
    drive(c, { type: 'INTERRUPTED', peerId: 'P1' });
    drive(c, { type: 'T_DELAY' });
    const staleGen = c.gen;
    r = drive(c, { type: 'CONNECTED', peerId: 'P1' });
    ok(stateName(c) === 'idle' && types(r).includes('cancelTimer') && types(r).includes('persistTouch'),
        'connected while checking → idle, timer cancelled, record touched');
    r = drive(c, { type: 'DELAY_READ', gen: staleGen, rec: { enabled: true, role: 'listener' }, connectedNow: false });
    ok(r.ignored && stateName(c) === 'idle', 'the in-flight record read lands stale (gen) and changes nothing');

    // TERMINAL while scheduled: cancel the delay, start now.
    const t = initialMachine();
    drive(t, { type: 'INTERRUPTED', peerId: 'P1' });
    r = drive(t, { type: 'TERMINAL', peerId: 'P1' });
    ok(stateName(t) === 'starting' && types(r)[0] === 'cancelTimer' && types(r).includes('beginSetup'),
        'terminal while scheduled cancels the delay and begins setup');
}

function lifecycleTests() {
    console.log('\nlifecycle spine — claim, setup, settle, cancel, fail');
    const m = initialMachine();
    drive(m, { type: 'TERMINAL', peerId: 'P1' });
    let r = drive(m, { type: 'SETUP_READ', gen: m.gen, rec: { enabled: true, role: 'caller', byedRecently: false }, connectedNow: false });
    ok(stateName(m) === 'live(active/none)', 'claim: starting → live(active/none)');
    ok(types(r).includes('buildEpisode') && types(r).includes('emit') && effOf(r, 'emit').event === 'reconnecting'
        && effOf(r, 'startTimer')?.id === 'demote',
        'claim effects: build carrier, announce reconnecting, arm the demote window');

    r = drive(m, { type: 'SETUP_DONE', gen: m.gen });
    ok(types(r)[0] === 'armOffer' && types(r).includes('schedulePublishes'),
        'setup done (caller): arm the offer and install the publish cadence');

    // In-band win: CONNECTED with no exchange → recovered-inband.
    r = drive(m, { type: 'CONNECTED', peerId: 'P1' });
    ok(stateName(m) === 'idle'
        && types(r).join(',') === 'persistSettle,cleanup,emit'
        && effOf(r, 'emit').event === 'recovered-inband',
        'connected with no exchange settles as recovered-inband (persist → cleanup → emit)');

    // Setup aborts: connected-now and missing/disabled record.
    const a = initialMachine();
    drive(a, { type: 'TERMINAL', peerId: 'P1' });
    drive(a, { type: 'SETUP_READ', gen: a.gen, rec: { enabled: true, role: 'caller' }, connectedNow: true });
    ok(stateName(a) === 'idle', 'setup aborts when the link is already back');
    const b = initialMachine();
    drive(b, { type: 'TERMINAL', peerId: 'P1' });
    drive(b, { type: 'SETUP_READ', gen: b.gen, rec: null, connectedNow: false });
    ok(stateName(b) === 'idle', 'setup aborts on a missing record');

    // CANCEL during live: cleanup, then the stale SETUP_DONE is dropped.
    const c = initialMachine();
    drive(c, { type: 'TERMINAL', peerId: 'P1' });
    drive(c, { type: 'SETUP_READ', gen: c.gen, rec: { enabled: true, role: 'listener' }, connectedNow: false });
    const preCancelGen = c.gen;
    r = drive(c, { type: 'CANCEL', why: 'pause' });
    ok(stateName(c) === 'idle' && types(r).includes('cleanup'), 'cancel during live cleans up and returns to idle');
    r = drive(c, { type: 'SETUP_DONE', gen: preCancelGen });
    ok(r.ignored, 'the in-flight setup completion lands stale after cancel (the legacy 1146 race, modeled)');

    // Failure: cleanup + gave-up (announced) + quiet re-arm.
    const f = toLive('caller');
    r = drive(f, { type: 'SETUP_FAILED', gen: f.gen, why: 'carrier exploded' });
    ok(stateName(f) === 'scheduled(rearm)'
        && types(r).includes('cleanup') && effOf(r, 'emit')?.event === 'gave-up'
        && effOf(r, 'startTimer')?.ms === CFG.rearmDelayMs,
        'failure: cleanup, gave-up (was announced), re-arm timer');
    r = drive(f, { type: 'T_DELAY' });
    ok(stateName(f) === 'starting' && effOf(r, 'beginSetup')?.opts?.quiet === true,
        'the re-arm fires a QUIET setup');

    // A byed record forces standby; standby claims quietly (no announce).
    const s = initialMachine();
    drive(s, { type: 'TERMINAL', peerId: 'P1' });
    r = drive(s, { type: 'SETUP_READ', gen: s.gen, rec: { enabled: true, role: 'caller', byedRecently: true }, connectedNow: false });
    ok(stateName(s) === 'live(standby/none)' && !types(r).includes('emit'),
        'a received bye forces a quiet standby claim (no reconnecting announcement)');
    r = drive(s, { type: 'SETUP_DONE', gen: s.gen });
    ok(r.effects.length === 0, 'standby setup completes without arming or publishing');
}

function callerExchangeTests() {
    console.log('\ncaller exchange — answer, stall retire-and-rearm, ring provocation');
    const m = toLive('caller');
    drive(m, { type: 'OFFER_ARMED', gen: m.gen, n: 'N1' });
    ok(m.offerArmed && m.offerNonce === 'N1', 'offer armed: nonce recorded, shadow fresh');
    ok(tryKinds(m).join(',') === 'answer,ring', 'armed caller decrypts answers and rings');

    // Stale-nonce answer is silence; matching answer adopts.
    let r = drive(m, { type: 'ANSWER_OPENED', decodeOk: true, peerIdMatch: true, n: 'OLD', liveConnected: false, payload: {} });
    ok(r.effects.length === 0 && !m.exchanged, 'an answer for a superseded offer is ignored');
    r = drive(m, { type: 'ANSWER_OPENED', decodeOk: true, peerIdMatch: true, n: 'N1', liveConnected: false, payload: { sdp: 1 } });
    ok(m.exchanged && types(r).join(',') === 'adoptShadow,acceptAnswer,startTimer'
        && effOf(r, 'startTimer').id === 'stall',
        'a matching answer adopts the shadow and arms the stall timer');
    ok(stateName(m) === 'live(active/adopting)', 'state reads live(active/adopting)');
    r = drive(m, { type: 'ANSWER_OPENED', decodeOk: true, peerIdMatch: true, n: 'N1', liveConnected: false, payload: {} });
    ok(r.effects.length === 0, 'a duplicate answer while adopting is ignored');
    ok(tryKinds(m).join(',') === 'answer', 'an exchanged caller still tries answers, never rings (legacy token spend)');

    // Stall: retire the exchange, re-arm a fresh offer.
    r = drive(m, { type: 'T_ANSWER_STALL', connectedNow: false });
    ok(!m.exchanged && types(r).join(',') === 'armOffer,publishNow',
        'stall with no connection unlatches and re-arms a fresh offer');
    r = drive(m, { type: 'T_ANSWER_STALL', connectedNow: true });
    ok(r.effects.length === 0, 'a stall that fires after the link connected does nothing');

    // Sealed-exchange settle: adopt again, then CONNECTED.
    drive(m, { type: 'OFFER_ARMED', gen: m.gen, n: 'N2' });
    drive(m, { type: 'ANSWER_OPENED', decodeOk: true, peerIdMatch: true, n: 'N2', liveConnected: false, payload: {} });
    r = drive(m, { type: 'CONNECTED', peerId: 'P1' });
    ok(effOf(r, 'emit').event === 'reconnected' && stateName(m) === 'idle',
        'channel open while adopting settles as reconnected (sealed exchange)');

    // In-band win mid-answer: liveConnected on the answer itself.
    const w = toLive('caller');
    drive(w, { type: 'OFFER_ARMED', gen: w.gen, n: 'N1' });
    r = drive(w, { type: 'ANSWER_OPENED', decodeOk: true, peerIdMatch: true, n: 'N1', liveConnected: true, payload: {} });
    ok(effOf(r, 'emit')?.event === 'recovered-inband' && stateName(w) === 'idle',
        'an answer landing after in-band repair settles inband (keeps the healed link)');

    // Ring: remembered BEFORE the liveness check, provokes a standby.
    const s = toLive('caller', { standby: true });
    ok(stateName(s) === 'live(standby/none)', 'standby caller starts passive');
    r = drive(s, { type: 'RING_OPENED', parseOk: true, peerIdMatch: true, n: 'R1', liveConnected: true });
    ok(types(r).join(',') === 'rememberNonce' && s.seenRings.has('R1') && stateName(s) === 'live(standby/none)',
        'a ring while connected is remembered but provokes nothing (legacy order)');
    r = drive(s, { type: 'RING_OPENED', parseOk: true, peerIdMatch: true, n: 'R2', liveConnected: false });
    ok(!s.standbyOnly && types(r).includes('armOffer') && types(r).includes('schedulePublishes') && types(r).includes('publishNow'),
        'a fresh ring provokes the standby: arm, schedule, publish now');
    r = drive(s, { type: 'RING_OPENED', parseOk: true, peerIdMatch: true, n: 'R2', liveConnected: false });
    ok(r.effects.length === 0, 'a replayed ring nonce is silence');

    // Cross-episode replay: seeded seenNonceSet rejects a prior episode's ring.
    const x = initialMachine();
    drive(x, { type: 'TERMINAL', peerId: 'P1' });
    drive(x, { type: 'SETUP_READ', gen: x.gen, rec: { enabled: true, role: 'caller', seenNonces: ['OLDRING'] }, connectedNow: false });
    drive(x, { type: 'SETUP_DONE', gen: x.gen });
    r = drive(x, { type: 'RING_OPENED', parseOk: true, peerIdMatch: true, n: 'OLDRING', liveConnected: false });
    ok(r.effects.length === 0, 'a ring replayed from a PRIOR episode is dead on arrival (seeded cache)');
}

function listenerExchangeTests() {
    console.log('\nlistener exchange — answer build, discard, supersede, stall');
    const m = toLive('listener');
    ok(tryKinds(m).join(',') === 'offer', 'an idle listener decrypts offers');

    let r = drive(m, { type: 'OFFER_OPENED', decodeOk: true, peerIdValid: true, peerId: 'P2', n: 'O1', liveConnected: false, payload: { sdp: 1 } });
    ok(m.answering && m.exchanged && m.answeredNonce === 'O1' && m.peerId === 'P2'
        && types(r).join(',') === 'rememberNonce,mapPeer,buildAnswer',
        'a fresh offer starts the answer build (nonce remembered, peer mapped)');
    ok(tryKinds(m).length === 0, 'no decrypting while answering (one adoption at a time)');

    // Build completes with the link recovered: discard, retire the nonce.
    r = drive(m, { type: 'ANSWER_BUILD_READY', gen: m.gen, liveConnected: true });
    ok(!m.exchanged && !m.answering && m.deadNonces.has('O1') && types(r).join(',') === 'discardAnswer',
        'link recovered while answering → answer discarded, nonce retired');

    // Fresh offer → commit path with the per-nonce stall timer.
    r = drive(m, { type: 'OFFER_OPENED', decodeOk: true, peerIdValid: true, peerId: 'P2', n: 'O2', liveConnected: false, payload: {} });
    r = drive(m, { type: 'ANSWER_BUILD_READY', gen: m.gen, liveConnected: false });
    ok(types(r).join(',') === 'commitAnswer,startTimer' && effOf(r, 'startTimer').id === 'lstall:O2',
        'a clean build commits the answer and arms its own stall timer');

    // Supersede: a different nonce while adopting replaces the attempt.
    r = drive(m, { type: 'OFFER_OPENED', decodeOk: true, peerIdValid: true, peerId: 'P2', n: 'O2', liveConnected: false, payload: {} });
    ok(r.effects.length === 0, 'a republish of the answered offer is ignored');
    r = drive(m, { type: 'OFFER_OPENED', decodeOk: true, peerIdValid: true, peerId: 'P2', n: 'O3', liveConnected: false, payload: {} });
    ok(m.answering && m.answeredNonce === 'O3', 'a FRESH nonce supersedes the stale in-flight attempt');
    drive(m, { type: 'ANSWER_BUILD_READY', gen: m.gen, liveConnected: false });

    // The superseded attempt's stall fires later: retires O2, does NOT unlatch O3.
    r = drive(m, { type: 'T_LISTENER_STALL', n: 'O2', connectedNow: false });
    ok(m.deadNonces.has('O2') && m.exchanged === true,
        'the old attempt\'s stall retires its own nonce without unlatching the current one');
    r = drive(m, { type: 'T_LISTENER_STALL', n: 'O3', connectedNow: false });
    ok(m.deadNonces.has('O3') && m.exchanged === false,
        'the current attempt\'s stall retires it and unlatches for the next fresh offer');

    // Replays of retired/remembered nonces are silence.
    r = drive(m, { type: 'OFFER_OPENED', decodeOk: true, peerIdValid: true, peerId: 'P2', n: 'O2', liveConnected: false, payload: {} });
    ok(r.effects.length === 0, 'a retired offer nonce never gets re-answered');

    // Build failure unlatches (keeps answeredNonce, legacy).
    drive(m, { type: 'OFFER_OPENED', decodeOk: true, peerIdValid: true, peerId: 'P2', n: 'O4', liveConnected: false, payload: {} });
    r = drive(m, { type: 'ANSWER_BUILD_FAILED', gen: m.gen });
    ok(!m.exchanged && !m.answering, 'a failed answer build unlatches the exchange');

    // Stale build completion after cancel (gen).
    const c = toLive('listener');
    drive(c, { type: 'OFFER_OPENED', decodeOk: true, peerIdValid: true, peerId: 'P2', n: 'O9', liveConnected: false, payload: {} });
    const g = c.gen;
    drive(c, { type: 'CANCEL', why: 'bye' });
    r = drive(c, { type: 'ANSWER_BUILD_READY', gen: g, liveConnected: false });
    ok(r.ignored, 'an answer build finishing after cancel lands stale (no adoption of a dead episode)');
}

function presenceTests() {
    console.log('\npresence — demote, promote, nudge');
    const m = toLive('caller');
    drive(m, { type: 'OFFER_ARMED', gen: m.gen, n: 'N1' });

    let r = drive(m, { type: 'T_DEMOTE' });
    ok(m.phase === 'quiet' && effOf(r, 'emit')?.event === 'gave-up' && effOf(r, 'emit').payload.standby === true,
        'demote: active → quiet with a standby-flavored gave-up');
    r = drive(m, { type: 'T_DEMOTE' });
    ok(r.effects.length === 0, 'a second demote is a no-op');

    // Promote from quiet: fresh window, publish; offer still fresh → no re-arm.
    r = drive(m, { type: 'PROMOTE' });
    ok(m.phase === 'active' && effOf(r, 'startTimer')?.id === 'demote'
        && !types(r).includes('armOffer') && types(r).includes('publishNow'),
        'promote from quiet: fresh demote window, republish, keep the fresh offer');

    // Promote with a stale shadow re-arms.
    NOW += 31000;
    r = drive(m, { type: 'PROMOTE' });
    ok(types(r).includes('armOffer'), 'promote re-arms once the shadow has aged past 30s');

    // Promote during adoption publishes nothing new.
    drive(m, { type: 'OFFER_ARMED', gen: m.gen, n: 'N2' });
    drive(m, { type: 'ANSWER_OPENED', decodeOk: true, peerIdMatch: true, n: 'N2', liveConnected: false, payload: {} });
    r = drive(m, { type: 'PROMOTE' });
    ok(!types(r).includes('armOffer') && !types(r).includes('publishNow'),
        'promote during an in-flight adoption lets it finish (no arm, no publish)');

    // Nudge: rate limit and standby passivity.
    const n = toLive('caller');
    drive(n, { type: 'OFFER_ARMED', gen: n.gen, n: 'N1' });
    r = drive(n, { type: 'NUDGE' });
    ok(types(r)[0] === 'ensureAlive' && types(r).includes('publishNow'),
        'nudge on an active caller checks the socket and republishes');
    r = drive(n, { type: 'NUDGE' });
    ok(types(r).join(',') === 'ensureAlive', 'a nudge within 5s is rate-limited to the socket check');
    NOW += 6000;
    r = drive(n, { type: 'NUDGE' });
    ok(types(r).includes('publishNow'), 'the rate limit lifts after 5s');

    const s = toLive('listener', { standby: true });
    r = drive(s, { type: 'NUDGE' });
    ok(types(r).join(',') === 'ensureAlive', 'a standby nudge only checks the socket (initiates nothing)');
}

function helperTests() {
    console.log('\npure helpers — token bucket, publish gate, undecryptable counting');
    const m = toLive('caller');
    // Token bucket: 20 tokens, then exhausted with a single warn.
    let allowed = 0, warns = 0;
    for (let i = 0; i < 25; i++) {
        const t = takeDecryptToken(m, NOW);
        if (t.allow) allowed++;
        if (t.warnOnce) warns++;
    }
    ok(allowed === 20 && warns === 1, `bucket allows 20 then warns once (allowed=${allowed}, warns=${warns})`);
    const later = takeDecryptToken(m, NOW + 1000);
    ok(later.allow === true, 'tokens refill at 10/s');

    // canPublish: inside window ok; outside logs the stop exactly once.
    const p = toLive('caller');
    ok(canPublish(p, NOW - 1000, NOW, CFG).ok === true, 'publishes inside the resume window');
    const first = canPublish(p, NOW - CFG.resumeWindowMs - 1, NOW, CFG);
    const second = canPublish(p, NOW - CFG.resumeWindowMs - 1, NOW, CFG);
    ok(!first.ok && first.logStop === true && !second.ok && second.logStop === false,
        'outside the window: publish refused, stop logged exactly once');

    // Undecryptable: 1-5 diag, 6-19 silent, 20 diags again; exchanged never counts.
    const u = toLive('listener');
    let diags = 0;
    for (let i = 0; i < 20; i++) {
        const r = drive(u, { type: 'BLOB_UNOPENED' });
        if (types(r).includes('diagUndecryptable')) diags++;
    }
    ok(diags === 6 && u.undecryptable === 20, `undecryptable diag rule: first 5 then every 20th (got ${diags})`);
    drive(u, { type: 'OFFER_OPENED', decodeOk: true, peerIdValid: true, peerId: 'P2', n: 'OX', liveConnected: false, payload: {} });
    drive(u, { type: 'ANSWER_BUILD_READY', gen: u.gen, liveConnected: false });
    const r = drive(u, { type: 'BLOB_UNOPENED' });
    ok(r.effects.length === 0 && u.undecryptable === 20, 'an exchanged episode never counts undecryptable blobs');
}

(async () => {
    console.log('rendezvous machine unit tests — episode state machine core');
    tableShape();
    schedulingTests();
    lifecycleTests();
    callerExchangeTests();
    listenerExchangeTests();
    presenceTests();
    helperTests();
    console.log('');
    if (fail) { console.log(fail + ' check(s) FAILED.'); process.exit(1); }
    console.log('All ' + pass + ' machine checks passed.');
})();
