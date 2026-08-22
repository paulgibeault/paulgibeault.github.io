/* recents-unit.mjs — hermetic Node unit tests for arcade-recents.js, the
 * single owner of arcade.v1._meta.recentGames (the launcher's MRU sort).
 *
 * Callers under contract here:
 *   • index.html POOL block — noteGamePlayed on every active-game change
 *   • index.html CATALOG block — sortByRecents on render and on re-sort
 *
 * The module reads localStorage at call time only, so an in-memory shim on
 * globalThis is all the browser we need. No browser, no network.
 * Run: `node tools/recents-unit.mjs`.
 */

// ---- localStorage shim (installed before any module call touches it) ----
const store = new Map();
let setItemThrows = false;
let getItemThrows = false;
globalThis.localStorage = {
    getItem(k) {
        if (getItemThrows) throw new Error('SecurityError (simulated)');
        return store.has(k) ? store.get(k) : null;
    },
    setItem(k, v) {
        if (setItemThrows) throw new Error('QuotaExceededError (simulated)');
        store.set(k, String(v));
    },
    removeItem(k) { store.delete(k); },
    clear() { store.clear(); }
};

import { isDeepStrictEqual } from 'node:util';
import {
    RECENTS_KEY,
    RECENTS_CAP,
    readRecents,
    promote,
    noteGamePlayed,
    sortByRecents
} from '../arcade-recents.js';

let pass = 0, fail = 0;
function ok(cond, label) {
    if (cond) { pass++; console.log('  ✓ ' + label); }
    else { fail++; console.log('  ✗ ' + label); }
}
function eq(a, b, label) { ok(isDeepStrictEqual(a, b), label); }

// Fictional ids on purpose: naming a real fleet game here would make this
// framework test fail when a GAME is renamed (Gate C in repo-gates-unit.mjs).
const CATALOG = ['alpha', 'bravo', 'charlie', 'delta', 'echo']
    .map((id) => ({ id, name: id }));
function ids(games) { return games.map((g) => g.id); }
function seed(list) { store.set(RECENTS_KEY, JSON.stringify(list)); }

function keyContractTests() {
    console.log('\nstorage key contract');
    // _meta.*, NOT global.*: global.* is bridge-writable by any game
    // (bridgeKeyWritable in arcade-storage-core.js), and a game must not be
    // able to reorder the launcher's tiles.
    ok(RECENTS_KEY === 'arcade.v1._meta.recentGames', 'RECENTS_KEY is a _meta key');
    ok(!RECENTS_KEY.startsWith('arcade.v1.global.'), 'RECENTS_KEY is NOT in the game-shared global namespace');
    store.clear();
    noteGamePlayed('bravo');
    ok(store.size === 1 && store.has(RECENTS_KEY), 'noteGamePlayed writes exactly that one key');
    eq(JSON.parse(store.get(RECENTS_KEY)), ['bravo'], 'stored value is a plain JSON id array');
}

function readToleranceTests() {
    console.log('\nreadRecents tolerance of absent/corrupt storage');
    store.clear();
    eq(readRecents(), [], 'absent key → []');
    store.set(RECENTS_KEY, 'not json {{{');
    eq(readRecents(), [], 'unparseable JSON → []');
    store.set(RECENTS_KEY, '{"bravo":1}');
    eq(readRecents(), [], 'JSON object → []');
    store.set(RECENTS_KEY, '"bravo"');
    eq(readRecents(), [], 'JSON string → []');
    store.set(RECENTS_KEY, 'null');
    eq(readRecents(), [], 'JSON null → []');
    seed(['bravo', 42, null, { id: 'x' }, ['y'], 'charlie']);
    eq(readRecents(), ['bravo', 'charlie'], 'non-string entries are dropped, order kept');
    seed(['Alpha-Game', 'bravo game', '../evil', '__proto__', 'ok-1']);
    eq(readRecents(), ['ok-1'], 'ids that could not be catalog ids are dropped');
    seed(['bravo', 'charlie', 'bravo', 'charlie']);
    eq(readRecents(), ['bravo', 'charlie'], 'duplicates collapse, first (most recent) wins');
    getItemThrows = true;
    eq(readRecents(), [], 'localStorage.getItem throwing → []');
    getItemThrows = false;
}

function promoteTests() {
    console.log('\npromote (the pure stack move)');
    eq(promote([], 'bravo'), ['bravo'], 'empty stack → single entry');
    eq(promote(['bravo'], 'charlie'), ['charlie', 'bravo'], 'new id goes to the front');
    eq(promote(['a', 'b', 'c'], 'c'), ['c', 'a', 'b'], 're-playing an old game moves it, never duplicates it');
    eq(promote(['a', 'b'], 'a'), ['a', 'b'], 're-playing the front game is a no-op on order');
    const long = Array.from({ length: RECENTS_CAP }, (_, i) => 'g' + i);
    const capped = promote(long, 'fresh');
    ok(capped.length === RECENTS_CAP, `stack stays capped at ${RECENTS_CAP}`);
    ok(capped[0] === 'fresh' && !capped.includes('g' + (RECENTS_CAP - 1)), 'the oldest entry is the one that falls off');
    const original = ['a', 'b'];
    promote(original, 'c');
    eq(original, ['a', 'b'], 'promote does not mutate its input');
}

function noteTests() {
    console.log('\nnoteGamePlayed');
    store.clear();
    noteGamePlayed('bravo');
    noteGamePlayed('charlie');
    noteGamePlayed('bravo');
    eq(readRecents(), ['bravo', 'charlie'], 'three plays, two games, most recent first');
    eq(noteGamePlayed('delta'), ['delta', 'bravo', 'charlie'], 'returns the new stack');

    store.clear();
    eq(noteGamePlayed('NOT AN ID'), [], 'a malformed id is not recorded');
    ok(store.size === 0, 'a malformed id writes nothing at all');
    eq(noteGamePlayed(undefined), [], 'undefined is not recorded');
    eq(noteGamePlayed({ id: 'bravo' }), [], 'a non-string is not recorded');

    console.log('\nnoteGamePlayed under a failing write (quota / private mode)');
    store.clear();
    noteGamePlayed('bravo');
    setItemThrows = true;
    eq(noteGamePlayed('charlie'), ['charlie', 'bravo'], 'a write failure still returns the intended stack');
    setItemThrows = false;
    eq(readRecents(), ['bravo'], 'and leaves the stored stack untouched — a launch is never broken by it');
}

function sortTests() {
    console.log('\nsortByRecents');
    eq(ids(sortByRecents(CATALOG, [])), ids(CATALOG),
        'no recents → catalog order, untouched (a first visit looks exactly as it always did)');
    eq(ids(sortByRecents(CATALOG, ['delta'])),
        ['delta', 'alpha', 'bravo', 'charlie', 'echo'],
        'one recent leads; the rest hold catalog order');
    eq(ids(sortByRecents(CATALOG, ['echo', 'bravo'])),
        ['echo', 'bravo', 'alpha', 'charlie', 'delta'],
        'several recents keep MRU order among themselves');
    eq(ids(sortByRecents(CATALOG, ['not-in-catalog', 'charlie'])),
        ['charlie', 'alpha', 'bravo', 'delta', 'echo'],
        'a recent id the catalog no longer has sorts nothing');
    eq(ids(sortByRecents(CATALOG, CATALOG.map((g) => g.id).reverse())),
        ids(CATALOG).reverse(), 'a full stack fully reorders the grid');
    const input = CATALOG.slice();
    sortByRecents(input, ['delta']);
    eq(ids(input), ids(CATALOG), 'sortByRecents does not mutate the catalog array');
    ok(sortByRecents(CATALOG, ['bravo'])[0] === CATALOG[1],
        'entries are passed through by reference, not copied');
    eq(sortByRecents(null, ['bravo']), [], 'a missing catalog → []');
    eq(ids(sortByRecents(CATALOG, ['charlie', 'charlie'])),
        ['charlie', 'alpha', 'bravo', 'delta', 'echo'],
        'a duplicated rank entry ranks by its first position');

    console.log('\nsortByRecents reading storage itself');
    store.clear();
    eq(ids(sortByRecents(CATALOG)), ids(CATALOG), 'no stored stack → catalog order');
    seed(['delta', 'bravo']);
    eq(ids(sortByRecents(CATALOG)), ['delta', 'bravo', 'alpha', 'charlie', 'echo'],
        'the stored stack is the default sort key');
    store.clear();
}

function launcherSequenceTests() {
    console.log('\nend-to-end: the sequence the launcher actually produces');
    store.clear();
    // Fresh device: catalog order, spotlight first.
    eq(ids(sortByRecents(CATALOG)), ids(CATALOG), 'boot 1 (never played) → catalog order');
    // Plays echo, quits, plays charlie, quits.
    noteGamePlayed('echo');
    eq(ids(sortByRecents(CATALOG))[0], 'echo', 'after quitting, the game just left leads the grid');
    noteGamePlayed('charlie');
    eq(ids(sortByRecents(CATALOG)).slice(0, 2), ['charlie', 'echo'], 'and the one before it is second');
    // Reload: the order survives the session (this is the whole point).
    eq(ids(sortByRecents(CATALOG)).slice(0, 2), ['charlie', 'echo'], 'boot 2 reads the same order back');
    // A warm-tab switch is a use, so it re-leads.
    noteGamePlayed('echo');
    eq(ids(sortByRecents(CATALOG)).slice(0, 2), ['echo', 'charlie'], 'switching tabs back promotes it again');
    store.clear();
}

console.log('Recents unit tests — arcade.v1._meta.recentGames MRU stack (no browser)');
keyContractTests();
readToleranceTests();
promoteTests();
noteTests();
sortTests();
launcherSequenceTests();
console.log('');
if (fail) { console.log(fail + ' check(s) FAILED.'); process.exit(1); }
console.log('All ' + pass + ' recents unit checks passed.');
