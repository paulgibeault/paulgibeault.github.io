/* records-unit.mjs — hermetic Node unit tests for arcade-records-core.js, the
 * pure reader/formatter layer behind the launcher's Records sheet (#12).
 *
 * Game frames are untrusted, so the sheet must treat every stored byte as
 * hostile. These tests pin exactly that: corrupt JSON skipped, non-array score
 * blobs skipped, non-finite scores filtered, stored sort never trusted (always
 * re-sorted by the category's order before the top-N cut), reset targeting the
 * right keys and nothing else (incl. the pi-game / pi-game-2 prefix trap), and
 * every formatter branch. No browser, no DOM — the core takes an injected
 * store. Auto-discovered by run-units.mjs; run: `npm test`.
 */
import {
    collectGameData, countPopulated, resetKeysFor, relevantKey,
    formatRecordValue, formatScore, formatDate, prettifyCategory,
    RENDER_TOP_N, MAX_CATEGORIES_PER_KIND
} from '../arcade-records-core.js';

let pass = 0, fail = 0;
function ok(cond, label) {
    if (cond) { pass++; console.log('  ✓ ' + label); }
    else { fail++; console.log('  ✗ ' + label); }
}
function eq(a, b, label) {
    const good = JSON.stringify(a) === JSON.stringify(b);
    ok(good, label + (good ? '' : '  (got ' + JSON.stringify(a) + ')'));
}

// Map-backed fake of the Web Storage read surface the core consumes.
function store(obj) {
    const keys = Object.keys(obj);
    return {
        get length() { return keys.length; },
        key(i) { return (i >= 0 && i < keys.length) ? keys[i] : null; },
        getItem(k) { return Object.prototype.hasOwnProperty.call(obj, k) ? obj[k] : null; }
    };
}
const K = (gameId, sub) => 'arcade.v1.' + gameId + '.' + sub;

console.log('\ncollectGameData — leaderboards + records');
{
    const s = store({
        [K('g', 'scores.high')]: JSON.stringify([{ score: 10, name: 'A', ts: 1 }, { score: 30, name: 'B', ts: 2 }, { score: 20 }]),
        [K('g', 'scores.time')]: JSON.stringify([{ score: 5000 }, { score: 3000 }, { score: 9000 }]),
        [K('g', '_scoreOrders')]: JSON.stringify({ time: 'asc' }),
        [K('g', 'records.best')]: JSON.stringify({ value: 42, direction: 'higher', label: 'Best', format: 'integer', ts: 5 }),
        [K('other', 'scores.x')]: JSON.stringify([{ score: 1 }])
    });
    const d = collectGameData(s, 'g');
    ok(d.scores.length === 2, 'two score categories collected');
    eq(d.scores.find((x) => x.category === 'high').entries.map((e) => e.score), [30, 20, 10], 'desc scores sorted high→low');
    eq(d.scores.find((x) => x.category === 'time').entries.map((e) => e.score), [3000, 5000, 9000], 'asc scores sorted low→high');
    ok(d.records.length === 1 && d.records[0].record.value === 42, 'one valid record collected');
    ok(!d.scores.some((x) => x.category === 'x'), 'another game’s data never leaks in');
}

console.log('\ncollectGameData — hostile / malformed data is skipped');
{
    const s = store({
        [K('g', 'scores.a')]: '{not json',
        [K('g', 'scores.b')]: JSON.stringify({ not: 'array' }),
        [K('g', 'scores.c')]: JSON.stringify([{ score: 'x' }, { score: null }, { score: Infinity }, { score: 5 }, { nope: 1 }]),
        [K('g', 'records.r')]: '{bad',
        [K('g', 'records.w')]: JSON.stringify({ value: 'x', direction: 'higher' }),
        [K('g', 'records.nodir')]: JSON.stringify({ value: 5 }),
        [K('g', 'records.good')]: JSON.stringify({ value: 5, direction: 'lower' })
    });
    const d = collectGameData(s, 'g');
    ok(!d.scores.some((x) => x.category === 'a'), 'corrupt score JSON skipped');
    ok(!d.scores.some((x) => x.category === 'b'), 'non-array score blob skipped');
    const c = d.scores.find((x) => x.category === 'c');
    ok(c && c.entries.length === 1 && c.entries[0].score === 5, 'non-finite/shapeless score entries filtered');
    ok(d.records.length === 1 && d.records[0].category === 'good', 'corrupt / wrong-value / no-direction records skipped');
}

console.log('\ncollectGameData — stored sort not trusted, top-N cut');
{
    const raw = [];
    for (let i = 15; i >= 1; i--) raw.push({ score: i * 1000 });  // stored descending
    const d = collectGameData(store({
        [K('g', 'scores.t')]: JSON.stringify(raw),
        [K('g', '_scoreOrders')]: JSON.stringify({ t: 'asc' })
    }), 'g');
    ok(d.scores[0].entries.length === RENDER_TOP_N, 'capped to top ' + RENDER_TOP_N);
    eq(d.scores[0].entries.map((e) => e.score),
        [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000],
        'asc order re-applied before the cut (10 smallest, sorted)');
}

console.log('\ncollectGameData — unknown format kept, category cap');
{
    const d = collectGameData(store({
        [K('g', 'records.up')]: JSON.stringify({ value: 3, direction: 'up' }),
        [K('g', 'records.custom')]: JSON.stringify({ value: 3, direction: 'higher', format: 'furlongs' })
    }), 'g');
    ok(!d.records.some((r) => r.category === 'up'), 'invalid direction rejected');
    ok((d.records.find((r) => r.category === 'custom') || {}).record.format === 'furlongs', 'unknown format preserved (forward-compat)');

    const many = {};
    for (let i = 0; i < 60; i++) many[K('g2', 'records.c' + i)] = JSON.stringify({ value: i, direction: 'higher' });
    ok(collectGameData(store(many), 'g2').records.length === MAX_CATEGORIES_PER_KIND, 'records capped at ' + MAX_CATEGORIES_PER_KIND);
}

console.log('\ncountPopulated');
ok(countPopulated({ scores: [1, 2], records: [1] }) === 3, 'sums score + record categories');
ok(countPopulated(null) === 0, 'null → 0');
ok(countPopulated(collectGameData(store({}), 'empty')) === 0, 'empty game → 0');

console.log('\nresetKeysFor — exact targeting, no prefix bleed');
{
    const s = store({
        [K('pi-game', 'scores.a')]: '[]',
        [K('pi-game', 'records.b')]: '{}',
        [K('pi-game', 'stats.c')]: '{}',
        [K('pi-game', '_scoreOrders')]: '{}',
        [K('pi-game', 'state')]: '{}',      // keep
        [K('pi-game', '_sync')]: '{}',      // keep
        [K('pi-game', '_noExport')]: '{}',  // keep
        [K('pi-game', 'ls.foo')]: '{}',     // keep
        [K('pi-game-2', 'scores.x')]: '[]'  // different game — the prefix trap
    });
    eq(resetKeysFor(s, 'pi-game').sort(),
        [K('pi-game', '_scoreOrders'), K('pi-game', 'records.b'), K('pi-game', 'scores.a'), K('pi-game', 'stats.c')].sort(),
        'targets scores/records/stats/_scoreOrders only; spares state/_sync/_noExport/ls and pi-game-2');
}

console.log('\nrelevantKey');
ok(relevantKey('g', K('g', 'scores.a')) === true, 'true for scores');
ok(relevantKey('g', K('g', 'records.a')) === true, 'true for records');
ok(relevantKey('g', K('g', 'stats.a')) === true, 'true for stats');
ok(relevantKey('g', K('g', '_scoreOrders')) === true, 'true for _scoreOrders');
ok(relevantKey('g', K('g', 'state')) === false, 'false for state');
ok(relevantKey('g', K('g-2', 'scores.a')) === false, 'false across games (prefix trap)');
ok(relevantKey('g', 42) === false, 'false for a non-string key');

console.log('\nformatRecordValue / formatScore');
ok(formatRecordValue(102130, 'duration-ms') === '1:42.13', 'duration-ms 102130 → 1:42.13');
ok(formatRecordValue(3661230, 'duration-ms') === '1:01:01.23', 'duration-ms over an hour → h:mm:ss.cc');
ok(formatRecordValue(-5, 'duration-ms') === '—', 'negative duration → em dash');
ok(formatRecordValue(NaN, 'duration-ms') === '—', 'NaN → em dash');
ok(formatRecordValue(1234, 'integer') === (1234).toLocaleString(), 'integer grouped by locale');
ok(formatRecordValue(87.5, 'percentage') === '87.5%', 'percentage keeps one decimal');
ok(formatRecordValue(100, 'percentage') === '100%', 'percentage integer drops the decimal');
ok(formatRecordValue(42, 'furlongs') === (42).toLocaleString(), 'unknown format → plain grouped number');
ok(formatScore(NaN) === '—', 'formatScore non-finite → em dash');

console.log('\nformatDate / prettifyCategory');
ok(formatDate(NaN) === '', 'formatDate non-finite → empty string');
ok(typeof formatDate(1600000000000) === 'string' && formatDate(1600000000000).length > 0, 'formatDate finite → non-empty string');
ok(prettifyCategory('klondike_draw1_unlimited') === 'Klondike Draw1 Unlimited', 'underscores → Title Case words');
ok(prettifyCategory('spider-1suit') === 'Spider 1suit', 'hyphen slug split');
ok(prettifyCategory('') === '', 'empty slug → empty');

console.log('');
if (fail) { console.log('✗ records-unit: ' + fail + ' of ' + (pass + fail) + ' checks FAILED'); process.exit(1); }
console.log('✓ records-unit: all ' + pass + ' checks passed');
