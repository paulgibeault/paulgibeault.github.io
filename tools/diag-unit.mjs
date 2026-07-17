/* diag-unit.mjs — hermetic Node unit tests for arcade-diag.js, the
 * session-long connection-log ring buffer every connection layer writes
 * into (boot / bridge / p2p / rdv / mqtt / sync / backup) and the
 * Multiplayer dialog renders read-only.
 *
 * The module promises to be import-safe from anywhere — importing it in
 * bare Node (no window, no DOM) succeeding at all is itself the first
 * contract under test. navigator.userAgent exists in Node 21+, which is
 * all transcript() needs. No browser, no network.
 * Run: `node tools/diag-unit.mjs`.
 */
import ArcadeDiagDefault, { ArcadeDiag } from '../arcade-diag.js';

let pass = 0, fail = 0;
function ok(cond, label) {
    if (cond) { pass++; console.log('  ✓ ' + label); }
    else { fail++; console.log('  ✗ ' + label); }
}

// The ring capacity is a deliberate bound (memory + copyable-transcript
// size), pinned here so a change to it is a conscious act.
const MAX_ENTRIES = 500;
const LINE_RE = /^\[\d{2}:\d{2}:\d{2}\] [^:]+: .*$/;

function importSurfaceTests() {
    console.log('\nimport surface');
    ok(ArcadeDiagDefault === ArcadeDiag, 'default export and named export are the same object');
    for (const m of ['log', 'entries', 'onEntry', 'format', 'transcript']) {
        ok(typeof ArcadeDiag[m] === 'function', 'ArcadeDiag.' + m + ' is a function');
    }
    // Reaching this file's body at all proves the module tolerated a
    // window-less environment (its window.__arcadeDiag hookup is guarded).
    ok(true, 'module imported without a window global (import-safe promise)');
    ok(ArcadeDiag.entries().length === 0, 'buffer starts empty in a fresh session');
}

function logAndSnapshotTests() {
    console.log('\nlog() and entries() snapshot');
    const t0 = Date.now();
    ArcadeDiag.log('boot', 'first line');
    const one = ArcadeDiag.entries();
    ok(one.length === 1, 'log() appends one entry');
    ok(one[0].tag === 'boot' && one[0].msg === 'first line', 'entry carries tag and msg');
    ok(typeof one[0].t === 'number' && one[0].t >= t0 && one[0].t <= Date.now(),
        'entry.t is a now-ish epoch-ms number');
    ArcadeDiag.log(42, { toString() { return 'stringified'; } });
    const two = ArcadeDiag.entries();
    ok(two[1].tag === '42' && two[1].msg === 'stringified',
        'non-string tag/msg are String()-coerced at append time');
    ok(two[0].tag === 'boot' && two[1].tag === '42', 'entries() is oldest-first');
    two.push({ t: 0, tag: 'fake', msg: 'injected' });
    two.length = 0;
    ok(ArcadeDiag.entries().length === 2,
        'entries() returns a copy — mutating the snapshot never touches the buffer');
}

function onEntryTests() {
    console.log('\nonEntry live tail');
    const seen = [];
    const unsub = ArcadeDiag.onEntry((e) => seen.push(e));
    ok(typeof unsub === 'function', 'onEntry returns an unsubscribe function');
    ArcadeDiag.log('bridge', 'tail me');
    ok(seen.length === 1 && seen[0].tag === 'bridge' && seen[0].msg === 'tail me',
        'listener receives each new entry');
    ok(seen[0] === ArcadeDiag.entries().at(-1), 'listener gets the appended entry itself');

    // A throwing listener must never break the log or its neighbors — the
    // diag channel can't be allowed to take down the layer that's logging.
    const alsoSeen = [];
    const unsubBad = ArcadeDiag.onEntry(() => { throw new Error('listener boom'); });
    const unsubGood = ArcadeDiag.onEntry((e) => alsoSeen.push(e));
    let threw = false;
    try { ArcadeDiag.log('p2p', 'resilient'); } catch (e) { threw = true; }
    ok(!threw, 'log() swallows a throwing listener');
    ok(alsoSeen.length === 1 && alsoSeen[0].msg === 'resilient',
        'other listeners still fire after one throws');
    ok(ArcadeDiag.entries().at(-1).msg === 'resilient', 'the entry still lands in the buffer');
    unsubBad(); unsubGood();

    const before = seen.length;
    unsub();
    ArcadeDiag.log('bridge', 'after unsub');
    ok(seen.length === before, 'unsubscribed listener no longer fires');
}

function formatTests() {
    console.log('\nformat()');
    // Exact rendering, timezone-proof: build the timestamp from local-time
    // Date components, exactly what stamp() reads back out.
    const t = new Date(2026, 0, 2, 3, 4, 5).getTime();
    const entry = { t, tag: 'rdv', msg: 'episode started' };
    ok(ArcadeDiag.format(entry) === '[03:04:05] rdv: episode started',
        'format is "[HH:MM:SS] tag: msg" with zero-padded fields');
    const t2 = new Date(2026, 0, 2, 23, 59, 9).getTime();
    ok(ArcadeDiag.format({ t: t2, tag: 'mqtt', msg: 'm' }) === '[23:59:09] mqtt: m',
        'late-day hour and single-digit seconds pad correctly');
    ok(entry.t === t && entry.tag === 'rdv' && entry.msg === 'episode started',
        'format never mutates the entry');
    ok(ArcadeDiag.entries().every((e) => LINE_RE.test(ArcadeDiag.format(e))),
        'every buffered entry formats to the display shape');
}

function transcriptTests() {
    console.log('\ntranscript()');
    const lines = ArcadeDiag.transcript().split('\n');
    const snap = ArcadeDiag.entries();
    ok(lines.length === snap.length + 2, 'transcript is a 2-line header plus one line per entry');
    ok(lines[0].startsWith('# Arcade connection log '), 'header line 1 names the log');
    ok(!Number.isNaN(Date.parse(lines[0].slice('# Arcade connection log '.length))),
        'header line 1 ends in a parseable timestamp');
    ok(lines[1] === '# UA: ' + navigator.userAgent, 'header line 2 is the UA (bug-report context)');
    ok(snap.every((e, i) => lines[i + 2] === ArcadeDiag.format(e)),
        'body lines are format() of each entry, oldest first');
}

function capacityTests() {
    console.log('\nring capacity (' + MAX_ENTRIES + ') and eviction order');
    // Flood with exactly MAX_ENTRIES uniquely-numbered lines: whatever was
    // in the buffer before, "keep the last 500 logged" means the buffer is
    // now exactly cap#0..cap#499.
    for (let i = 0; i < MAX_ENTRIES; i++) ArcadeDiag.log('cap', 'cap#' + i);
    let snap = ArcadeDiag.entries();
    ok(snap.length === MAX_ENTRIES, 'buffer holds exactly ' + MAX_ENTRIES + ' entries when full');
    ok(snap[0].msg === 'cap#0' && snap.at(-1).msg === 'cap#' + (MAX_ENTRIES - 1),
        'a full flood leaves exactly the flooded lines, in order');
    ArcadeDiag.log('cap', 'cap#' + MAX_ENTRIES);
    snap = ArcadeDiag.entries();
    ok(snap.length === MAX_ENTRIES, 'overflow never grows the buffer past the cap');
    ok(snap[0].msg === 'cap#1', 'overflow evicts the OLDEST entry (ring semantics)');
    ok(snap.at(-1).msg === 'cap#' + MAX_ENTRIES, 'the newest entry is always kept');
    ok(snap.every((e, i) => e.msg === 'cap#' + (i + 1)), 'interior order is untouched by eviction');
    // Listeners still hear entries that will be evicted moments later —
    // eviction bounds the buffer, not the live tail.
    let tailed = null;
    const unsub = ArcadeDiag.onEntry((e) => { tailed = e.msg; });
    ArcadeDiag.log('cap', 'cap#tail');
    unsub();
    ok(tailed === 'cap#tail' && ArcadeDiag.entries().length === MAX_ENTRIES,
        'live tail fires on every log even at capacity');
    // The transcript stays bounded with the buffer.
    ok(ArcadeDiag.transcript().split('\n').length === MAX_ENTRIES + 2,
        'transcript at capacity is exactly cap + 2 header lines');
}

console.log('ArcadeDiag unit tests — connection-log ring buffer (no browser)');
importSurfaceTests();
logAndSnapshotTests();
onEntryTests();
formatTests();
transcriptTests();
capacityTests();
console.log('');
if (fail) { console.log(fail + ' check(s) FAILED.'); process.exit(1); }
console.log('All ' + pass + ' diag unit checks passed.');
