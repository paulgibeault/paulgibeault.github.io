/* leaderboard-unit.mjs — hermetic tests for arcade-leaderboard-core.js, the
 * union-merge core behind shared leaderboards (#leaderboards). The load-bearing
 * property is CONVERGENCE: N devices gossiping boards in any order must reach
 * the byte-identical top-100. These tests pin that (property-style, all
 * pairwise exchange orders → same fixpoint), plus the deterministic tie-break,
 * cap-eviction convergence, legacy-entry dedupe, resetAt filtering, and the
 * hostile-input validators. Auto-discovered by run-units.mjs; run: `npm test`.
 */
import {
    isLeaderboardKey, fnv1a32, entryIdentity, validateBoardEntry, mergeBoards,
    chunkBoards, validateLeaderboardEnvelope,
    SCORES_CAP, LB_ENTRY_MAX, LB_MAX_BOARDS_PER_FRAME
} from '../arcade-leaderboard-core.js';

let pass = 0, fail = 0;
function ok(cond, label) {
    if (cond) { pass++; console.log('  ✓ ' + label); }
    else { fail++; console.log('  ✗ ' + label); }
}
function eq(a, b, label) {
    const good = JSON.stringify(a) === JSON.stringify(b);
    ok(good, label + (good ? '' : '  (got ' + JSON.stringify(a) + ')'));
}
// Deterministic PRNG so the property tests are reproducible.
function mulberry32(seed) {
    return function () {
        seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const K = (app, cat) => 'arcade.v1.' + app + '.scores.' + cat;
const ent = (score, dev, eid, extra) => Object.assign({ score, ts: 1700000000000 + score, dev, eid }, extra || {});

console.log('\nSCORES_CAP pinned to the SDK value');
ok(SCORES_CAP === 100, 'SCORES_CAP === 100');

console.log('\nisLeaderboardKey');
ok(isLeaderboardKey(K('g', 'high')) === true, 'scores key accepted');
ok(isLeaderboardKey(K('g', 'time.attack')) === true, 'dotted category accepted');
ok(isLeaderboardKey('arcade.v1.g.records.x') === false, 'records key rejected');
ok(isLeaderboardKey('arcade.v1.g.stats.x') === false, 'stats key rejected');
ok(isLeaderboardKey('arcade.v1.g._scoreOrders') === false, 'sidecar rejected');
ok(isLeaderboardKey('arcade.v1.global.scores.x') === false, 'global namespace rejected');
ok(isLeaderboardKey('arcade.v1.g.scores.') === false, 'empty category rejected');
ok(isLeaderboardKey('arcade.v1.g.scores') === false, 'no category segment rejected');

console.log('\nfnv1a32 / entryIdentity');
ok(fnv1a32('abc') === fnv1a32('abc'), 'fnv1a32 deterministic');
ok(fnv1a32('abc') !== fnv1a32('abd'), 'fnv1a32 discriminates');
ok(entryIdentity(ent(5, 'dev-aaaaaa', 'e1')) === 'dev-aaaaaa:e1', 'attributed identity = dev:eid');
ok(entryIdentity({ score: 5, ts: 9, name: 'Pat' }).startsWith('legacy:'), 'unattributed → legacy fingerprint');
ok(entryIdentity({ score: 5, ts: 9, name: 'Pat' }) === entryIdentity({ score: 5, ts: 9, name: 'Pat' }), 'legacy identity stable');
ok(entryIdentity({ score: 5, ts: 9, name: 'Pat' }) !== entryIdentity({ score: 6, ts: 9, name: 'Pat' }), 'legacy identity discriminates on score');

console.log('\nvalidateBoardEntry — hostile input');
ok(validateBoardEntry(ent(5, 'dev-aaaaaa', 'e1')) !== null, 'valid entry accepted');
ok(validateBoardEntry({ score: 'x', ts: 9 }) === null, 'non-numeric score rejected');
ok(validateBoardEntry({ score: NaN, ts: 9 }) === null, 'NaN score rejected');
ok(validateBoardEntry({ score: 5, ts: 0 }) === null, 'ts<=0 rejected');
ok(validateBoardEntry([1, 2]) === null, 'array rejected');
ok(validateBoardEntry({ score: 5, ts: 9, dev: 'not a device id!!', eid: 'e' }).dev === undefined, 'bogus dev dropped');
ok(validateBoardEntry({ score: 5, ts: 9, dev: 'dev-aaaaaa', eid: 'way-too-long-to-be-an-eid-1234567890' }).eid === undefined, 'bogus eid dropped');
eq(Object.keys(validateBoardEntry({ score: 5, ts: 9, name: 'A', junk: 1, __proto__: { p: 1 } })).sort(), ['name', 'score', 'ts'], 'only known fields kept');
ok(validateBoardEntry({ score: 5, ts: 9, name: 'x'.repeat(100) }).name.length === 32, 'name sliced to 32');
{
    const big = validateBoardEntry({ score: 5, ts: 9, meta: { blob: 'x'.repeat(LB_ENTRY_MAX) } });
    ok(big !== null && big.meta === undefined, 'oversize meta dropped, entry kept');
}

console.log('\nmergeBoards — union, dedupe, order, cap');
{
    const a = [ent(100, 'dev-aaaaaa', 'a1'), ent(80, 'dev-aaaaaa', 'a2')];
    const b = [ent(90, 'dev-bbbbbb', 'b1'), ent(100, 'dev-aaaaaa', 'a1')]; // a1 dup
    const m = mergeBoards(a, b, 'desc', 0);
    eq(m.list.map(e => e.score), [100, 90, 80], 'desc union sorted, dup collapsed');
    ok(m.changed === true, 'merge that adds an entry reports changed');
    ok(mergeBoards(m.list, b, 'desc', 0).changed === false, 're-merging converged board is a no-op');
}
{
    const asc = mergeBoards([ent(5000, 'dev-aaaaaa', 'a')], [ent(3000, 'dev-bbbbbb', 'b')], 'asc', 0);
    eq(asc.list.map(e => e.score), [3000, 5000], 'asc order (lower first)');
}
{
    // identical score+ts, different identity → deterministic tie-break by identity
    const e1 = { score: 5, ts: 100, dev: 'dev-aaaaaa', eid: 'zzz' };
    const e2 = { score: 5, ts: 100, dev: 'dev-aaaaaa', eid: 'aaa' };
    const m1 = mergeBoards([e1], [e2], 'desc', 0);
    const m2 = mergeBoards([e2], [e1], 'desc', 0);
    eq(m1.list.map(entryIdentity), m2.list.map(entryIdentity), 'tie-break independent of merge order');
    ok(m1.list[0].eid === 'aaa', 'tie-break orders by identity ascending');
}
{
    // cap-eviction convergence: two different 100-cuts must union to the same top-100
    const all = [];
    for (let i = 0; i < 150; i++) all.push(ent(i, 'dev-aaaaaa', 'e' + i));
    const half1 = all.slice(0, 100), half2 = all.slice(50);
    const cutA = mergeBoards(half1, [], 'desc', 0).list;   // top-100 of first 100
    const cutB = mergeBoards(half2, [], 'desc', 0).list;   // top-100 of last 100
    const unioned = mergeBoards(cutA, cutB, 'desc', 0).list;
    const oracle = mergeBoards([], all, 'desc', 0).list;
    ok(unioned.length === SCORES_CAP, 'union capped at 100');
    eq(unioned, oracle, 'union of two different cuts === global top-100');
}

console.log('\nmergeBoards — resetAt watermark');
{
    const local = [ent(50, 'dev-aaaaaa', 'new')]; local[0].ts = 2000;
    const remote = [Object.assign(ent(99, 'dev-bbbbbb', 'old'), { ts: 1000 })];
    const m = mergeBoards(local, remote, 'desc', 1500);
    ok(m.list.length === 1 && m.list[0].eid === 'new', 'remote entry with ts<=resetAt refused');
    const noReset = mergeBoards(local, remote, 'desc', 0);
    ok(noReset.list.length === 2, 'without reset the remote entry is merged');
    // future-skewed remote entry survives a reset (documented limitation)
    const future = [Object.assign(ent(99, 'dev-bbbbbb', 'fut'), { ts: 9999999999999 })];
    ok(mergeBoards([], future, 'desc', 1500).list.length === 1, 'future-ts entry survives reset (skew caveat)');
}

console.log('\nmergeBoards — legacy dedupe + self-heal');
{
    const legacy = { score: 42, ts: 100, name: 'Pat' };           // no dev/eid
    const m = mergeBoards([legacy], [{ score: 42, ts: 100, name: 'Pat' }], 'desc', 0);
    ok(m.list.length === 1, 'byte-identical legacy entries collapse');
    const corrupt = mergeBoards([{ score: 'bad' }, ent(5, 'dev-aaaaaa', 'e')], [], 'desc', 0);
    ok(corrupt.list.length === 1 && corrupt.changed === true, 'corrupt local entry dropped, board self-heals');
}

console.log('\nCONVERGENCE — 3-device gossip, all exchange orders → same fixpoint');
{
    const orders = ['desc', 'asc'];
    const exchangeSchedules = [
        [[0, 1], [1, 2], [0, 2]],
        [[0, 2], [0, 1], [1, 2]],
        [[1, 2], [0, 2], [0, 1]],
        [[0, 1], [0, 2], [1, 2], [0, 1]]
    ];
    let allConverged = true, allMatchOracle = true;
    for (const order of orders) {
        for (let seed = 1; seed <= 8; seed++) {
            const rnd = mulberry32(seed * 97 + (order === 'asc' ? 1 : 0));
            const devs = ['dev-aaaaaa', 'dev-bbbbbb', 'dev-cccccc'];
            const boards = [[], [], []];
            const all = [];
            for (let d = 0; d < 3; d++) {
                const n = Math.floor(rnd() * 60);
                for (let i = 0; i < n; i++) {
                    const e = ent(Math.floor(rnd() * 40), devs[d], 'e' + d + '_' + i);
                    boards[d].push(e); all.push(e);
                }
            }
            const oracle = mergeBoards([], all, order, 0).list;
            for (const sched of exchangeSchedules) {
                const dev = boards.map(b => b.slice());
                let changedAny = true, guard = 0;
                while (changedAny && guard++ < 200) {
                    changedAny = false;
                    for (const [i, j] of sched) {
                        const r1 = mergeBoards(dev[i], dev[j], order, 0);
                        if (r1.changed) { dev[i] = r1.list; changedAny = true; }
                        const r2 = mergeBoards(dev[j], dev[i], order, 0);
                        if (r2.changed) { dev[j] = r2.list; changedAny = true; }
                    }
                }
                const s0 = JSON.stringify(dev[0]);
                if (s0 !== JSON.stringify(dev[1]) || s0 !== JSON.stringify(dev[2])) allConverged = false;
                if (s0 !== JSON.stringify(oracle)) allMatchOracle = false;
            }
        }
    }
    ok(allConverged, 'all 3 devices reach byte-identical boards under every schedule');
    ok(allMatchOracle, 'the fixpoint equals the global top-100 oracle (order-independent)');
}

console.log('\nchunkBoards / validateLeaderboardEnvelope');
{
    const boards = [{ k: K('g', 'a'), order: 'desc', list: [ent(5, 'dev-aaaaaa', 'e')] }];
    ok(chunkBoards(boards).frames.length >= 1, 'chunkBoards yields at least one frame');
    const oversize = [{ k: K('g', 'a'), order: 'desc', list: Array.from({ length: 100 }, (_, i) => ent(i, 'dev-aaaaaa', 'x'.repeat(300) + i)) }];
    ok(chunkBoards(oversize).skipped.length === 1, 'oversize board is skipped, not sent');

    ok(validateLeaderboardEnvelope({ v: 1, op: 'boards', entries: boards }).ok === true, 'valid envelope accepted');
    ok(validateLeaderboardEnvelope({ v: 2, op: 'boards', entries: [] }).ok === false, 'bad version rejected');
    ok(validateLeaderboardEnvelope({ v: 1, op: 'digest', entries: [] }).ok === false, 'wrong op rejected');
    ok(validateLeaderboardEnvelope({ v: 1, op: 'boards', entries: [{ k: 'arcade.v1.g.records.x', order: 'desc', list: [] }] }).ok === false, 'non-leaderboard key rejected');
    ok(validateLeaderboardEnvelope({ v: 1, op: 'boards', entries: [{ k: K('g', 'a'), order: 'sideways', list: [] }] }).ok === false, 'bad order rejected');
    ok(validateLeaderboardEnvelope({ v: 1, op: 'boards', entries: [{ k: K('g', 'a'), order: 'desc', list: new Array(SCORES_CAP + 1).fill(0) }] }).ok === false, 'over-cap list rejected');
    ok(validateLeaderboardEnvelope({ v: 1, op: 'boards', entries: new Array(LB_MAX_BOARDS_PER_FRAME + 1).fill({ k: K('g', 'a'), order: 'desc', list: [] }) }).ok === false, 'too many boards rejected');
}

console.log('');
if (fail) { console.log('✗ leaderboard-unit: ' + fail + ' of ' + (pass + fail) + ' checks FAILED'); process.exit(1); }
console.log('✓ leaderboard-unit: all ' + pass + ' checks passed');
