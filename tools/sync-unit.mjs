/* sync-unit.mjs — hermetic Node unit tests for the pure Arcade.sync core
 * (arcade-sync-core.js) and the sync key-eligibility predicate in
 * arcade-storage-core.js.
 *
 * These are the replication engine's trust boundary and clock math in pure
 * form: the HLC that orders concurrent writes, the digest/diff envelope
 * shapes, the LWW apply decision, and the inbound-validation gate that
 * decides what a paired device may write into this device's storage.
 * Extracting them into arcade-sync-core.js keeps them importable without a
 * browser (see arcade-sync.js, a later work package, for the stateful engine
 * built on top of these primitives).
 *
 * No browser, no network — runs anywhere Node exposes global crypto.subtle
 * (Node 20+). Run: `npm run sync-unit`.
 */
import {
    SYNC_PROTOCOL_V,
    SYNC_DB,
    SYNC_TOMBSTONE_CAP_PER_APP,
    appIdOfKey,
    planTombstoneGc,
    HLC_RE,
    hlcPack,
    hlcParse,
    hlcCompare,
    hlcNext,
    hlcRecv,
    sha256Hex,
    chunkEntries,
    planFromDigest,
    applyDecision,
    isConcurrentLoss,
    validateSyncEnvelope
} from '../arcade-sync-core.js';
import * as syncCore from '../arcade-sync-core.js';
import {
    syncEligibleKey,
    SYNC_MAX_ENTRIES,
    SYNC_VALUE_MAX,
    STORE_DB_RE // the export-DB-enumeration regex arcade-save.js imports (arcade-save.js:32) but
                // does not re-export; imported straight from its defining module here.
} from '../arcade-storage-core.js';

let pass = 0, fail = 0;
function ok(cond, label) {
    if (cond) { pass++; console.log('  ✓ ' + label); }
    else { fail++; console.log('  ✗ ' + label); }
}

const DEV_A = 'dev-aaaaaa';
const DEV_B = 'dev-bbbbbb';

function constantsTests() {
    console.log('\nconstants');
    ok(SYNC_PROTOCOL_V === 1, 'SYNC_PROTOCOL_V is 1');
    ok(SYNC_DB === 'arcade-sync', 'SYNC_DB is "arcade-sync"');
    ok(SYNC_TOMBSTONE_CAP_PER_APP === 512, 'SYNC_TOMBSTONE_CAP_PER_APP is 512');
    // Deliberately NO time-based tombstone TTL: any TTL re-opens the
    // deletion-resurrection window (a device offline past the TTL pulls the
    // deleted key back as brand-new). Retention is cap-only; this import
    // check pins that the constant stays deleted.
    ok(!('SYNC_TOMBSTONE_TTL_MS' in syncCore), 'no tombstone TTL constant exists (cap-only GC)');
    // The sync IDB database name must never be picked up by the save-export
    // store enumeration regex — that's what keeps device sync bookkeeping
    // (and everything derived from it) out of every backup, structurally.
    ok(STORE_DB_RE.test(SYNC_DB) === false, 'STORE_DB_RE never matches the sync DB name (export cannot pick it up)');
}

function hlcTests() {
    console.log('\nHLC (pack/parse/compare/next/recv)');

    // pack/parse/RE round-trip.
    const packed = hlcPack(1783468800123, 7, DEV_A);
    ok(packed === '1783468800123:0007:' + DEV_A, 'hlcPack zero-pads millis(13)/counter(4)');
    ok(HLC_RE.test(packed), 'HLC_RE matches a packed stamp');
    const parsed = hlcParse(packed);
    ok(parsed.millis === 1783468800123 && parsed.counter === 7 && parsed.deviceId === DEV_A, 'hlcParse round-trips pack()');
    ok(hlcParse('not-an-hlc') === null, 'hlcParse returns null on a non-matching string');
    ok(hlcParse(undefined) === null, 'hlcParse returns null on a non-string');
    // uuid-shaped deviceId also accepted by HLC_RE / hlcParse.
    const uuidDev = '0f3c2d1e-aaaa-bbbb-cccc-1234567890ab';
    ok(HLC_RE.test(hlcPack(1, 0, uuidDev)), 'HLC_RE accepts a uuid-shaped deviceId');

    // hlcCompare orders millis -> counter -> deviceId.
    ok(hlcCompare(hlcPack(1, 0, DEV_A), hlcPack(2, 0, DEV_A)) < 0, 'compare: lower millis sorts first');
    ok(hlcCompare(hlcPack(5, 1, DEV_A), hlcPack(5, 2, DEV_A)) < 0, 'compare: same millis, lower counter sorts first');
    ok(hlcCompare(hlcPack(5, 3, DEV_A), hlcPack(5, 3, DEV_B)) < 0, 'compare: same millis+counter, deviceId is the tiebreaker (DEV_A < DEV_B)');
    ok(hlcCompare(hlcPack(5, 3, DEV_A), hlcPack(5, 3, DEV_A)) === 0, 'compare: identical stamps are equal');

    // hlcNext monotonic under a 10s wall-clock regression.
    const t0 = 1783468800000;
    const first = hlcNext(null, t0, DEV_A);
    ok(hlcParse(first).millis === t0 && hlcParse(first).counter === 0, 'hlcNext with no prior clock stamps at nowMs, counter 0');
    const regressed = hlcNext(first, t0 - 10000, DEV_A); // wall clock jumped back 10s
    ok(hlcCompare(regressed, first) > 0, 'hlcNext stays monotonic across a 10s wall-clock regression');
    ok(hlcParse(regressed).millis === t0, 'hlcNext under regression holds millis at the prior value');
    ok(hlcParse(regressed).counter === 1, 'hlcNext under regression bumps the counter');

    // counter overflow (>9999) bumps millis, resets counter.
    let clock = hlcPack(t0, 9999, DEV_A);
    const overflowed = hlcNext(clock, t0, DEV_A); // same millis, counter would be 10000
    ok(hlcParse(overflowed).millis === t0 + 1, 'hlcNext counter overflow bumps millis by 1');
    ok(hlcParse(overflowed).counter === 0, 'hlcNext counter overflow resets counter to 0');

    // hlcRecv advances past remote.
    const local1 = hlcNext(null, t0, DEV_A);
    const remote1 = hlcNext(null, t0 + 5000, DEV_B); // remote is ahead
    const recvd = hlcRecv(local1, remote1, t0, DEV_A);
    ok(hlcCompare(recvd, remote1) > 0, 'hlcRecv advances strictly past a remote stamp that was ahead');
    ok(hlcCompare(recvd, local1) > 0, 'hlcRecv also stays ahead of the prior local stamp');
    // remote behind local + now: local stays authoritative, counter bumps.
    const localAhead = hlcNext(null, t0 + 9000, DEV_A);
    const remoteBehind = hlcNext(null, t0, DEV_B);
    const recvd2 = hlcRecv(localAhead, remoteBehind, t0, DEV_A);
    ok(hlcParse(recvd2).millis === t0 + 9000 && hlcParse(recvd2).counter === 1, 'hlcRecv when local is already ahead just bumps the counter');
    // malformed remote doesn't throw, falls back to a local stamp.
    const recvdBad = hlcRecv(local1, 'garbage', t0 + 1, DEV_A);
    ok(HLC_RE.test(recvdBad), 'hlcRecv tolerates a malformed remote stamp (falls back to local issue)');
}

function syncEligibleKeyTests() {
    console.log('\nsyncEligibleKey');
    ok(syncEligibleKey('arcade.v1.myapp.save1'), 'accepts a well-formed own-namespace app key');
    ok(!syncEligibleKey('arcade.v1._meta.deviceId'), 'rejects _meta.* (device-local identity)');
    ok(!syncEligibleKey('arcade.v1.global.theme'), 'rejects global.* (launcher-managed settings)');
    ok(!syncEligibleKey('arcade.v1.myapp._sync'), 'rejects the _sync sidecar list itself');
    ok(!syncEligibleKey('arcade.v1.myapp._noExport'), 'rejects the _noExport sidecar');
    ok(!syncEligibleKey('arcade.v1.myapp._migrated.v2'), 'rejects an underscore-prefixed sidecar segment generally');
    ok(!syncEligibleKey('arcade.v1.myapp.ls.x'), 'rejects the .ls. proxy subtree');
    ok(!syncEligibleKey('arcade.v1.__proto__.x'), 'rejects a __proto__ dunder-smuggling attempt');
    ok(!syncEligibleKey('arcade.v1.myapp.constructor'), 'rejects a constructor dunder segment');
    ok(!syncEligibleKey('other.v1.myapp.x'), 'rejects a non-arcade-namespace key (wrong shape)');
    ok(!syncEligibleKey('arcade.v1.myapp'), 'rejects a single-segment key (no sub-path)');
    ok(!syncEligibleKey(12345), 'rejects a non-string key');
    ok(!syncEligibleKey('arcade.v1.myapp.' + 'x'.repeat(510)), 'rejects a key longer than 512 chars');
}

function chunkEntriesTests() {
    console.log('\nchunkEntries');
    const entries = [];
    for (let i = 0; i < 10; i++) entries.push(['arcade.v1.app.k' + i, hlcPack(1, i, DEV_A), 'x'.repeat(10)]);

    // Entry-count cap.
    const byCount = chunkEntries(entries, 3, 1e9);
    ok(byCount.length === 4, 'chunkEntries splits 10 entries into 4 chunks at maxEntries=3');
    ok(byCount.every((c) => c.length <= 3), 'every chunk respects the maxEntries cap');
    ok(byCount.reduce((n, c) => n + c.length, 0) === 10, 'no entries lost across chunks (count cap)');

    // Byte-budget cap.
    const bigEntries = [];
    for (let i = 0; i < 5; i++) bigEntries.push(['arcade.v1.app.k' + i, hlcPack(1, i, DEV_A), 'x'.repeat(50)]);
    const approxOne = JSON.stringify(bigEntries[0]).length;
    const byBudget = chunkEntries(bigEntries, 1000, approxOne * 2 + 1);
    ok(byBudget.length > 1, 'chunkEntries splits on the byte budget even under the entry-count cap');
    ok(byBudget.reduce((n, c) => n + c.length, 0) === 5, 'no entries lost across chunks (byte cap)');

    // Empty input still yields one (empty) part — the wire protocol's
    // `parts` count must be >= 1 for "digest complete" to be signalable.
    const empty = chunkEntries([], 10, 1000);
    ok(empty.length === 1 && empty[0].length === 0, 'chunkEntries([]) yields exactly one empty chunk');

    // A single oversize entry still gets its own chunk rather than being
    // dropped (caller-level caps like SYNC_VALUE_MAX bound entry size).
    const oneHuge = [['arcade.v1.app.big', hlcPack(1, 0, DEV_A), 'x'.repeat(500)]];
    const hugeChunks = chunkEntries(oneHuge, 10, 50);
    ok(hugeChunks.length === 1 && hugeChunks[0].length === 1, 'a single entry larger than the budget still forms its own chunk');
}

function planFromDigestTests() {
    console.log('\nplanFromDigest');
    const hA1 = hlcPack(1, 0, DEV_A);
    const hA2 = hlcPack(2, 0, DEV_A);
    const hB1 = hlcPack(1, 0, DEV_B);

    const local = new Map([
        ['k.newerLocal', { h: hA2, x: 'localhash1', del: 0, t: 2 }],   // local is newer than remote entry below
        ['k.olderLocal', { h: hA1, x: 'localhash2', del: 0, t: 1 }],   // remote is newer
        ['k.sameHashDiffHlc', { h: hA1, x: 'samehash', del: 0, t: 1 }], // same content, different HLC bookkeeping
        ['k.localOnly', { h: hA1, x: 'onlyhere', del: 0, t: 1 }]        // absent from remote digest entirely
    ]);
    const remoteEntries = [
        ['k.newerLocal', hA1, 'remotehash1'],       // local (hA2) > remote (hA1) -> send
        ['k.olderLocal', hA2, 'remotehash2'],       // remote (hA2) > local (hA1), hash differs -> need
        ['k.sameHashDiffHlc', hB1, 'samehash'],     // hash equal, hlc differs -> adopt
        ['k.remoteOnly', hB1, 'brandnew']           // no local record at all -> need
    ];
    const plan = planFromDigest(local, remoteEntries);
    ok(plan.send.includes('k.newerLocal'), 'planFromDigest: local-newer key is queued to send');
    ok(plan.need.includes('k.olderLocal'), 'planFromDigest: remote-newer key is queued to need');
    ok(plan.need.includes('k.remoteOnly'), 'planFromDigest: a key with no local record at all is queued to need');
    ok(plan.adopt.some((a) => a[0] === 'k.sameHashDiffHlc'), 'planFromDigest: same-hash/different-hlc is queued to adopt');
    ok(plan.send.includes('k.localOnly'), 'planFromDigest: a local-only key absent from a completed remote digest is queued to send');
    ok(!plan.need.includes('k.newerLocal') && !plan.send.includes('k.olderLocal'), 'planFromDigest never double-classifies a key');
}

function applyDecisionTests() {
    console.log('\napplyDecision');
    const older = { h: hlcPack(1, 0, DEV_A), x: 'hashOld' };
    const newer = { h: hlcPack(2, 0, DEV_B), x: 'hashNew' };
    ok(applyDecision(undefined, newer) === 'apply', 'no local record -> apply');
    ok(applyDecision(older, newer) === 'apply', 'newer remote entry -> apply');
    ok(applyDecision(newer, older) === 'skip', 'older remote entry -> skip');
    ok(applyDecision(older, { h: older.h, x: older.x }) === 'skip', 'identical stamp -> skip (already applied)');
    ok(applyDecision(older, { h: hlcPack(3, 0, DEV_B), x: older.x }) === 'adopt-hlc', 'newer stamp but identical hash -> adopt-hlc (no data motion)');
    ok(applyDecision(newer, { h: hlcPack(1, 0, DEV_A), x: newer.x }) === 'adopt-hlc', 'older stamp but identical hash -> adopt-hlc');
}

function isConcurrentLossTests() {
    console.log('\nisConcurrentLoss');
    const mine = { h: hlcPack(5, 0, DEV_A) };
    const theirs = { h: hlcPack(5, 0, DEV_B) };
    ok(isConcurrentLoss(mine, null, DEV_A) === true, 'own-authored record with no prior cursor -> concurrent loss');
    ok(isConcurrentLoss(mine, hlcPack(1, 0, DEV_B), DEV_A) === true, "own-authored record the peer's cursor hadn't seen -> concurrent loss");
    ok(isConcurrentLoss(mine, hlcPack(9, 0, DEV_B), DEV_A) === false, "own-authored record the peer's cursor already covers -> not a loss");
    ok(isConcurrentLoss(theirs, null, DEV_A) === false, 'a record authored by someone else is never "my" concurrent loss');
    ok(isConcurrentLoss(undefined, null, DEV_A) === false, 'no local record at all -> not a loss');
}

function validateSyncEnvelopeTests() {
    console.log('\nvalidateSyncEnvelope');
    const caps = { maxEntries: SYNC_MAX_ENTRIES, valueMax: SYNC_VALUE_MAX };
    const goodKey = 'arcade.v1.myapp.save1';
    const goodHlc = hlcPack(1, 0, DEV_A);
    const goodHash = 'a'.repeat(64);

    // Malformed envelope shells.
    ok(!validateSyncEnvelope(null, caps).ok, 'rejects a null envelope');
    ok(validateSyncEnvelope(null, caps).reason === 'bad-op', 'null envelope reason is bad-op');
    ok(!validateSyncEnvelope({ v: 2, op: 'digest', entries: [] }, caps).ok, 'rejects a non-v1 envelope');
    ok(validateSyncEnvelope({ v: 2, op: 'digest', entries: [] }, caps).reason === 'bad-v', 'wrong version reason is bad-v');
    ok(!validateSyncEnvelope({ v: 1, op: 'bogus' }, caps).ok, 'rejects an unknown op');
    ok(validateSyncEnvelope({ v: 1, op: 'bogus' }, caps).reason === 'bad-op', 'unknown op reason is bad-op');

    // digest.
    ok(validateSyncEnvelope({ v: 1, op: 'digest', entries: [[goodKey, goodHlc, goodHash]] }, caps).ok, 'accepts a well-formed digest');
    ok(!validateSyncEnvelope({ v: 1, op: 'digest', entries: [['arcade.v1._meta.deviceId', goodHlc, goodHash]] }, caps).ok, 'rejects a digest entry for an ineligible key (_meta smuggling)');
    ok(validateSyncEnvelope({ v: 1, op: 'digest', entries: [['arcade.v1._meta.deviceId', goodHlc, goodHash]] }, caps).reason === 'bad-key', 'ineligible digest key reason is bad-key');
    ok(!validateSyncEnvelope({ v: 1, op: 'digest', entries: [[goodKey, 'not-an-hlc', goodHash]] }, caps).ok, 'rejects a digest entry with a malformed hlc');
    ok(validateSyncEnvelope({ v: 1, op: 'digest', entries: [[goodKey, 'not-an-hlc', goodHash]] }, caps).reason === 'bad-hlc', 'malformed digest hlc reason is bad-hlc');
    ok(!validateSyncEnvelope({ v: 1, op: 'digest', entries: [[goodKey, goodHlc, 'nothex']] }, caps).ok, 'rejects a digest entry with a malformed hash');
    ok(validateSyncEnvelope({ v: 1, op: 'digest', entries: [[goodKey, goodHlc, 'nothex']] }, caps).reason === 'bad-hash', 'malformed digest hash reason is bad-hash');
    const tooManyDigest = { v: 1, op: 'digest', entries: Array.from({ length: caps.maxEntries + 1 }, () => [goodKey, goodHlc, goodHash]) };
    ok(!validateSyncEnvelope(tooManyDigest, caps).ok, 'rejects a digest with more than maxEntries entries');
    ok(validateSyncEnvelope(tooManyDigest, caps).reason === 'too-many', 'oversize digest reason is too-many');

    // req.
    ok(validateSyncEnvelope({ v: 1, op: 'req', keys: [goodKey] }, caps).ok, 'accepts a well-formed req');
    ok(!validateSyncEnvelope({ v: 1, op: 'req', keys: ['arcade.v1.global.theme'] }, caps).ok, 'rejects a req for an ineligible key');
    ok(validateSyncEnvelope({ v: 1, op: 'req', keys: ['arcade.v1.global.theme'] }, caps).reason === 'bad-key', 'ineligible req key reason is bad-key');
    const tooManyReq = { v: 1, op: 'req', keys: Array.from({ length: caps.maxEntries + 1 }, () => goodKey) };
    ok(!validateSyncEnvelope(tooManyReq, caps).ok, 'rejects a req with more than maxEntries keys');

    // diff.
    ok(validateSyncEnvelope({ v: 1, op: 'diff', entries: [{ k: goodKey, h: goodHlc, v: '"1"' }] }, caps).ok, 'accepts a well-formed diff (live value)');
    ok(validateSyncEnvelope({ v: 1, op: 'diff', entries: [{ k: goodKey, h: goodHlc, del: 1 }] }, caps).ok, 'accepts a well-formed diff (tombstone)');
    ok(!validateSyncEnvelope({ v: 1, op: 'diff', entries: [{ k: 'arcade.v1.myapp._sync', h: goodHlc, v: '["*"]' }] }, caps).ok, 'rejects a diff entry for an ineligible key');
    ok(!validateSyncEnvelope({ v: 1, op: 'diff', entries: [{ k: goodKey, h: 'garbage', v: '"1"' }] }, caps).ok, 'rejects a diff entry with a malformed hlc');
    ok(!validateSyncEnvelope({ v: 1, op: 'diff', entries: [{ k: goodKey, h: goodHlc, v: 12345 }] }, caps).ok, 'rejects a diff entry whose value is not a string');
    ok(validateSyncEnvelope({ v: 1, op: 'diff', entries: [{ k: goodKey, h: goodHlc, v: 12345 }] }, caps).reason === 'bad-value', 'non-string diff value reason is bad-value');
    const oversizeVal = { v: 1, op: 'diff', entries: [{ k: goodKey, h: goodHlc, v: 'x'.repeat(caps.valueMax + 1) }] };
    ok(!validateSyncEnvelope(oversizeVal, caps).ok, 'rejects a diff value larger than valueMax');
    ok(validateSyncEnvelope(oversizeVal, caps).reason === 'bad-value', 'oversize diff value reason is bad-value');
    const tooManyDiff = { v: 1, op: 'diff', entries: Array.from({ length: caps.maxEntries + 1 }, () => ({ k: goodKey, h: goodHlc, v: '"1"' })) };
    ok(!validateSyncEnvelope(tooManyDiff, caps).ok, 'rejects a diff with more than maxEntries entries');
    ok(validateSyncEnvelope(tooManyDiff, caps).reason === 'too-many', 'oversize diff reason is too-many');
}

function planTombstoneGcTests() {
    console.log('\nplanTombstoneGc (cap eviction + watermark)');
    const CAP = 3;
    const tomb = (app, n, t) => ['arcade.v1.' + app + '.k' + n, { h: hlcPack(t, 0, DEV_A), x: 'x'.repeat(64), del: 1, t }, 'cls' + n];
    const live = (app, n, t) => ['arcade.v1.' + app + '.live' + n, { h: hlcPack(t, 0, DEV_A), x: 'y'.repeat(64), del: 0, t }];

    ok(appIdOfKey('arcade.v1.myapp.save1') === 'myapp', 'appIdOfKey extracts the app segment');
    ok(appIdOfKey('arcade.v1.solo') === 'solo', 'appIdOfKey handles a key with no sub-path');

    // Under the cap: nothing evicted, no watermark.
    let plan = planTombstoneGc([tomb('appa', 1, 10), tomb('appa', 2, 20), live('appa', 1, 5)], CAP);
    ok(plan.evict.length === 0 && plan.watermarks.size === 0, 'under-cap app: nothing evicted, no watermark minted');

    // Over the cap: oldest evicted first, watermark = max evicted t/h.
    plan = planTombstoneGc([tomb('appa', 1, 10), tomb('appa', 2, 20), tomb('appa', 3, 30), tomb('appa', 4, 40), tomb('appa', 5, 50)], CAP);
    ok(plan.evict.length === 2, 'over-cap app evicts down to exactly cap');
    ok(plan.evict[0][0] === 'arcade.v1.appa.k1' && plan.evict[1][0] === 'arcade.v1.appa.k2', 'oldest tombstones are evicted first');
    ok(plan.evict[0][2] === 'cls1', 'extra entry elements are carried through to evict (class tag)');
    const wm = plan.watermarks.get('appa');
    ok(wm && wm.t === 20, 'watermark t is the max evicted t');
    ok(wm && wm.h === hlcPack(20, 0, DEV_A), 'watermark h is the max evicted HLC');

    // Live records never count toward (or get evicted by) the cap.
    plan = planTombstoneGc([live('appa', 1, 1), live('appa', 2, 2), live('appa', 3, 3), live('appa', 4, 4), tomb('appa', 1, 10)], CAP);
    ok(plan.evict.length === 0, 'live records never count toward the tombstone cap');

    // Per-app isolation: one app over cap does not evict another's.
    plan = planTombstoneGc([tomb('appa', 1, 10), tomb('appa', 2, 20), tomb('appa', 3, 30), tomb('appa', 4, 40), tomb('appb', 1, 5)], CAP);
    ok(plan.evict.every((e) => appIdOfKey(e[0]) === 'appa'), 'eviction is per-app: an under-cap app is untouched');
    ok(!plan.watermarks.has('appb'), 'no watermark for an app with no evictions');
}

// ---- engine-level pins (shimmed browser env, real arcade-sync.js) ----
// The record-class separation is a security invariant, not a style choice:
// handleInboundReq answers any key present in its map, so these tests run
// the REAL engine over fake localStorage/IndexedDB and prove on the wire
// that `local`-class records are unreachable — a req for a journaled
// non-synced key returns nothing, and digests never advertise one.
function settle(turns) {
    return new Promise((resolve) => {
        let n = turns || 25;
        (function tick() { if (--n <= 0) resolve(); else setTimeout(tick, 0); })();
    });
}
async function waitFor(cond, label) {
    for (let i = 0; i < 400; i++) {
        const v = cond();
        if (v) return v;
        await settle(2);
    }
    throw new Error('waitFor timed out: ' + label);
}

async function engineTests() {
    console.log('\nsync engine — record classes / wire refusal / watermark (shimmed env)');
    const { installFakeIndexedDB, installFakeLocalStorage } = await import('./lib/fake-idb.mjs');
    installFakeIndexedDB();
    installFakeLocalStorage();
    globalThis.window = globalThis;
    const { initSyncEngine } = await import('../arcade-sync.js');

    localStorage.setItem('arcade.v1._meta.deviceId', DEV_A);
    localStorage.setItem('arcade.v1._meta.knownPeers', JSON.stringify({ [DEV_B]: { name: 'B', syncEnabled: true } }));
    localStorage.setItem('arcade.v1.appa._sync', JSON.stringify(['arcade.v1.appa.synced']));
    localStorage.setItem('arcade.v1.appa._noExport', JSON.stringify(['arcade.v1.appa.temp']));

    const engine = initSyncEngine({ postToIframe: () => {} });
    const sent = [];
    let inbound = null;
    engine.attachP2P({
        sendSyncEnvelope: (deviceId, env) => sent.push({ deviceId, env }),
        onSyncEnvelope: (cb) => { inbound = cb; },
        onPeerIdentity: () => {},
        connectionState: () => 'connected',
        isFingerprintSuspect: () => false
    });

    // Local writes through the bridge hook: one synced, one journaled (with
    // a coalesced overwrite), one _noExport-listed, one non-synced delete.
    localStorage.setItem('arcade.v1.appa.synced', '"s1"');
    engine.noteLocalWrite('arcade.v1.appa.synced', '"s1"');
    localStorage.setItem('arcade.v1.appa.private', '"p1"');
    engine.noteLocalWrite('arcade.v1.appa.private', '"p0"'); // coalesced away by the flush
    engine.noteLocalWrite('arcade.v1.appa.private', '"p1"');
    engine.noteLocalWrite('arcade.v1.appa.temp', '"t1"');
    engine.noteLocalWrite('arcade.v1.appa.gone', null);

    await waitFor(() => engine._localRecords()['arcade.v1.appa.gone'] && engine._records()['arcade.v1.appa.synced'], 'journal flush');
    await settle();
    const recs = engine._records();
    const localRecs = engine._localRecords();
    ok(!!recs['arcade.v1.appa.synced'], 'a _sync-opted write lands in the sync record class');
    ok(!recs['arcade.v1.appa.private'], 'a non-synced write NEVER lands in the sync class');
    ok(!!localRecs['arcade.v1.appa.private'], 'a non-synced write lands in the local journal class');
    ok(!localRecs['arcade.v1.appa.synced'], 'a synced write stays out of the local class');
    ok(localRecs['arcade.v1.appa.private'].x === await sha256Hex('"p1"'), 'coalesced flush journals the FINAL value of a hammered key');
    ok(!localRecs['arcade.v1.appa.temp'] && !recs['arcade.v1.appa.temp'], 'a _noExport-listed key is never journaled');
    ok(localRecs['arcade.v1.appa.gone'] && localRecs['arcade.v1.appa.gone'].del === 1, 'deleting a non-synced key leaves a local-class tombstone');

    // Exfiltration pin: a req for a journaled non-synced key returns NOTHING.
    sent.length = 0;
    inbound(DEV_B, { v: 1, op: 'req', keys: ['arcade.v1.appa.private', 'arcade.v1.appa.gone', 'arcade.v1.appa.synced'] });
    await waitFor(() => sent.some((f) => f.env.op === 'diff'), 'req answer');
    await settle();
    const diffKeys = sent.filter((f) => f.env.op === 'diff').flatMap((f) => f.env.entries.map((e) => e.k));
    ok(!diffKeys.includes('arcade.v1.appa.private'), 'req for a journaled non-synced key returns nothing (exfiltration pin)');
    ok(!diffKeys.includes('arcade.v1.appa.gone'), 'req for a local-class tombstone returns nothing');
    ok(diffKeys.includes('arcade.v1.appa.synced'), 'the same req still answers the genuinely synced key');

    // Digest exclusion: local-class records are never advertised.
    sent.length = 0;
    engine.kick(DEV_B);
    await waitFor(() => sent.some((f) => f.env.op === 'digest'), 'digest');
    const digestKeys = sent.filter((f) => f.env.op === 'digest').flatMap((f) => f.env.entries.map((e) => e[0]));
    ok(digestKeys.includes('arcade.v1.appa.synced'), 'digest advertises the sync-class record');
    ok(!digestKeys.includes('arcade.v1.appa.private') && !digestKeys.includes('arcade.v1.appa.gone'), 'digest never includes local-class records');

    // exportJournal merges both classes (bundle journal section source).
    const journal = await engine.exportJournal();
    ok(!!journal.records['arcade.v1.appa.synced'] && !!journal.records['arcade.v1.appa.private'], 'exportJournal merges both record classes');
    ok(typeof journal.clock === 'string' && HLC_RE.test(journal.clock), 'exportJournal carries a packed HLC clock');

    // Watermark: push an app past the cap, reload the engine (same fake
    // IDB), and prove GC evicted oldest-first and persisted the watermark.
    for (let i = 0; i < SYNC_TOMBSTONE_CAP_PER_APP + 3; i++) {
        engine.noteLocalWrite('arcade.v1.appb.k' + String(i).padStart(4, '0'), null);
    }
    await waitFor(() => Object.keys(engine._localRecords()).filter((k) => appIdOfKey(k) === 'appb').length === SYNC_TOMBSTONE_CAP_PER_APP + 3, 'tombstone fill');
    const engine2 = initSyncEngine({ postToIframe: () => {} });
    await engine2.exportJournal(); // forces ensureLoaded -> loadFromIdb + gcTombstones
    const appbLeft = Object.keys(engine2._localRecords()).filter((k) => appIdOfKey(k) === 'appb');
    ok(appbLeft.length === SYNC_TOMBSTONE_CAP_PER_APP, 'reload GC evicts local-class tombstones down to the per-app cap');
    ok(!appbLeft.includes('arcade.v1.appb.k0000') && !appbLeft.includes('arcade.v1.appb.k0002'), 'the OLDEST tombstones are the ones evicted');
    const wm = engine2._watermark('appb');
    ok(wm && typeof wm.t === 'number' && wm.t > 0, 'eviction persists a per-app watermark (t)');
    ok(wm && HLC_RE.test(wm.h), 'watermark carries the max evicted HLC');
    ok(engine2._watermark('appa') === null, 'no watermark for an app that never evicted');

    // The watermark survives a further reload with no new evictions.
    const engine3 = initSyncEngine({ postToIframe: () => {} });
    await engine3.exportJournal();
    const wm3 = engine3._watermark('appb');
    ok(wm3 && wm3.t === wm.t && wm3.h === wm.h, 'watermark is persisted, not recomputed away on a quiet reload');
}

async function sha256HexTests() {
    console.log('\nsha256Hex');
    const h1 = await sha256Hex('hello world');
    const h2 = await sha256Hex('hello world');
    const h3 = await sha256Hex('hello WORLD');
    ok(h1 === h2, 'sha256Hex is deterministic for the same input');
    ok(h1 !== h3, 'sha256Hex differs for different input');
    ok(/^[0-9a-f]{64}$/.test(h1), 'sha256Hex returns 64 lowercase hex chars');
    ok(h1 === 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9', 'sha256Hex matches the known SHA-256("hello world") digest');
}

(async () => {
    console.log('Arcade.sync unit tests — HLC / digest planning / apply / validation (no browser)');
    constantsTests();
    hlcTests();
    syncEligibleKeyTests();
    chunkEntriesTests();
    planFromDigestTests();
    applyDecisionTests();
    isConcurrentLossTests();
    validateSyncEnvelopeTests();
    planTombstoneGcTests();
    await sha256HexTests();
    await engineTests();
    console.log('');
    if (fail) { console.log(fail + ' check(s) FAILED.'); process.exit(1); }
    console.log('All ' + pass + ' sync unit checks passed.');
})();
