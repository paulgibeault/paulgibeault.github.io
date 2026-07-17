/* known-peers-unit.mjs — hermetic Node unit tests for arcade-known-peers.js,
 * the single owner of the arcade.v1._meta.knownPeers localStorage key.
 *
 * Callers under contract here:
 *   • index.html Multiplayer dialog — readKnownPeers, renameKnownPeer,
 *     deleteKnownPeer, setKnownPeerSyncEnabled, setKnownPeerBackupTarget,
 *     clearKnownPeerRevoked
 *   • arcade-p2p.js — readKnownPeers, writeKnownPeers, setKnownPeerPaused,
 *     markKnownPeerRevoked (upsert on every identity handshake)
 *   • arcade-sync.js / arcade-backup.js — readKnownPeers (+ backup's
 *     setKnownPeerBackupTarget on consent)
 *
 * The module reads localStorage at call time only, so a tiny in-memory shim
 * installed on globalThis before the calls is all the browser we need.
 * No browser, no network. Run: `node tools/known-peers-unit.mjs`.
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
    KNOWN_PEERS_KEY,
    readKnownPeers,
    writeKnownPeers,
    mutateKnownPeers,
    renameKnownPeer,
    setKnownPeerPaused,
    setKnownPeerSyncEnabled,
    setKnownPeerBackupTarget,
    markKnownPeerRevoked,
    clearKnownPeerRevoked,
    deleteKnownPeer
} from '../arcade-known-peers.js';

let pass = 0, fail = 0;
function ok(cond, label) {
    if (cond) { pass++; console.log('  ✓ ' + label); }
    else { fail++; console.log('  ✗ ' + label); }
}
function eq(a, b, label) { ok(isDeepStrictEqual(a, b), label); }

const ID_A = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789';
const ID_B = 'dev-bbbbbb';
function seed(map) { store.set(KNOWN_PEERS_KEY, JSON.stringify(map)); }
function raw() { return store.get(KNOWN_PEERS_KEY); }
function entry(extra) {
    return {
        name: 'Kitchen tablet', remoteName: 'tablet', firstConnectedAt: 1751500000000,
        lastConnectedAt: 1751500001000, timesConnected: 3, fingerprint: 'fp-1',
        ...extra
    };
}

function keyContractTests() {
    console.log('\nstorage key contract');
    // Exports/imports and both writers depend on this exact literal — the
    // representation IS the contract here, so pin it.
    ok(KNOWN_PEERS_KEY === 'arcade.v1._meta.knownPeers', 'KNOWN_PEERS_KEY is the historical literal');
    store.clear();
    writeKnownPeers({ [ID_A]: entry() });
    ok(store.has(KNOWN_PEERS_KEY) && store.size === 1, 'writeKnownPeers writes exactly that one key');
    ok(raw() === JSON.stringify({ [ID_A]: entry() }), 'stored value is plain JSON of the map');
}

function readToleranceTests() {
    console.log('\nreadKnownPeers tolerance of absent/corrupt storage');
    store.clear();
    eq(readKnownPeers(), {}, 'absent key → {}');
    store.set(KNOWN_PEERS_KEY, 'not json {{{');
    eq(readKnownPeers(), {}, 'unparseable JSON → {}');
    store.set(KNOWN_PEERS_KEY, '"a string"');
    eq(readKnownPeers(), {}, 'JSON string → {}');
    store.set(KNOWN_PEERS_KEY, '42');
    eq(readKnownPeers(), {}, 'JSON number → {}');
    store.set(KNOWN_PEERS_KEY, 'null');
    eq(readKnownPeers(), {}, 'JSON null → {}');
    store.set(KNOWN_PEERS_KEY, 'true');
    eq(readKnownPeers(), {}, 'JSON true → {}');
    // Historical quirk: an array passes the (obj && typeof obj === 'object')
    // gate, so a stored array is returned as-is rather than reset to {}.
    // Every caller iterates with Object.values / map[id], which tolerates it.
    store.set(KNOWN_PEERS_KEY, '[1,2]');
    ok(Array.isArray(readKnownPeers()), 'HISTORICAL: a stored JSON array is returned as-is, not coerced to {}');
    getItemThrows = true;
    eq(readKnownPeers(), {}, 'localStorage.getItem throwing → {}');
    getItemThrows = false;
}

function roundTripTests() {
    console.log('\nwrite/read round-trip');
    store.clear();
    const map = { [ID_A]: entry(), [ID_B]: entry({ name: 'Phone', autoReconnect: true }) };
    writeKnownPeers(map);
    eq(readKnownPeers(), map, 'two-entry map round-trips intact');
    const got = readKnownPeers();
    got[ID_A].name = 'MUTATED';
    delete got[ID_B];
    eq(readKnownPeers(), map, 'mutating a read result never touches the store (fresh parse per read)');
}

function mutateTests() {
    console.log('\nmutateKnownPeers');
    store.clear();
    seed({ [ID_A]: entry() });
    const before = raw();
    let seen = null;
    ok(mutateKnownPeers((m) => { seen = m; return null; }) === false, 'fn returning null → false');
    ok(seen && seen[ID_A] && seen[ID_A].name === 'Kitchen tablet', 'fn received the freshly-read map');
    ok(raw() === before, 'aborted mutation writes nothing');
    ok(mutateKnownPeers(() => 'truthy-but-not-object') === false, 'fn returning a non-object → false, no write');
    ok(raw() === before, 'non-object return writes nothing');
    ok(mutateKnownPeers(() => { throw new Error('boom'); }) === false, 'fn throwing → false (swallowed)');
    ok(raw() === before, 'throwing fn writes nothing');
    ok(mutateKnownPeers((m) => { m[ID_A].timesConnected++; return m; }) === true, 'fn returning the map → true');
    ok(readKnownPeers()[ID_A].timesConnected === 4, 'mutation persisted');
    ok(mutateKnownPeers(() => ({ [ID_B]: entry() })) === true, 'fn may return a replacement map');
    eq(readKnownPeers(), { [ID_B]: entry() }, 'replacement map persisted wholesale');
}

function renameTests() {
    console.log('\nrenameKnownPeer');
    store.clear();
    seed({ [ID_A]: entry({ futureFlag: { nested: 1 } }) });
    ok(renameKnownPeer('nope', 'X') === false, 'unknown id → false');
    ok(renameKnownPeer(ID_A, 'Living room  ') === true, 'rename known id → true');
    ok(readKnownPeers()[ID_A].name === 'Living room', 'name persisted, trimmed');
    eq(readKnownPeers()[ID_A].futureFlag, { nested: 1 }, 'rename preserves unknown entry fields (forward compat)');
    ok(readKnownPeers()[ID_A].fingerprint === 'fp-1', 'rename preserves known sibling fields');
    ok(renameKnownPeer(ID_A, 'x'.repeat(80)) === true && readKnownPeers()[ID_A].name.length === 60,
        'name clipped to 60 chars');
    ok(renameKnownPeer(ID_A, '') === false, 'empty name → false');
    ok(renameKnownPeer(ID_A, '   ') === false, 'whitespace-only name → false');
    ok(renameKnownPeer(ID_A, null) === false, 'null name → false');
    ok(readKnownPeers()[ID_A].name === 'x'.repeat(60), 'rejected renames leave the stored name alone');
    ok(renameKnownPeer(ID_A, 42) === true && readKnownPeers()[ID_A].name === '42',
        'non-string name is String()-coerced (historical)');
}

function flagTests() {
    console.log('\npaused / syncEnabled / backupTarget flags');
    store.clear();
    seed({ [ID_A]: entry({ carried: 'along' }) });
    for (const [label, fn, field] of [
        ['setKnownPeerPaused', setKnownPeerPaused, 'paused'],
        ['setKnownPeerSyncEnabled', setKnownPeerSyncEnabled, 'syncEnabled'],
        ['setKnownPeerBackupTarget', setKnownPeerBackupTarget, 'backupTarget']
    ]) {
        ok(fn('nope', true) === false, label + ': unknown id → false');
        ok(fn(ID_A, 1) === true && readKnownPeers()[ID_A][field] === true,
            label + ': truthy coerced to boolean true');
        ok(fn(ID_A, 0) === true && readKnownPeers()[ID_A][field] === false,
            label + ': falsy coerced to boolean false');
    }
    // #31 contract: an explicit backup decline is a STORED false — distinct
    // from "never asked" (field absent) — so an inbound offer never re-prompts.
    ok(Object.prototype.hasOwnProperty.call(readKnownPeers()[ID_A], 'backupTarget'),
        'backupTarget false is stored, not deleted (decline ≠ never-asked)');
    ok(readKnownPeers()[ID_A].carried === 'along', 'flag toggles preserve unknown entry fields');
}

function revocationTests() {
    console.log('\nrevoked latch (markKnownPeerRevoked / clearKnownPeerRevoked)');
    store.clear();
    seed({ [ID_A]: entry(), [ID_B]: entry() });
    const good = { revokedAt: 1751500002000, sig: 'A'.repeat(86) };
    ok(markKnownPeerRevoked(ID_A, null) === false, 'null entry → false');
    ok(markKnownPeerRevoked(ID_A, {}) === false, 'empty entry → false');
    ok(markKnownPeerRevoked(ID_A, { revokedAt: '1751500002000', sig: good.sig }) === false,
        'string revokedAt → false');
    ok(markKnownPeerRevoked(ID_A, { revokedAt: good.revokedAt, sig: 123 }) === false,
        'non-string sig → false');
    ok(!('revoked' in readKnownPeers()[ID_A]), 'rejected entries never write a latch');
    ok(markKnownPeerRevoked('nope', good) === false, 'unknown id → false');
    ok(markKnownPeerRevoked(ID_A, { ...good, smuggled: 'x' }) === true, 'valid entry latches');
    eq(readKnownPeers()[ID_A].revoked, good, 'stored latch is exactly {revokedAt, sig} — extra fields stripped');
    ok(markKnownPeerRevoked(ID_A, { revokedAt: 9999999999999, sig: 'B'.repeat(86) }) === false,
        'latch is one-way: a second mark is refused');
    eq(readKnownPeers()[ID_A].revoked, good, 'refused re-mark leaves the original latch intact');
    ok(!('revoked' in readKnownPeers()[ID_B]), 'latching one peer never touches another');

    ok(clearKnownPeerRevoked(ID_B) === false, 'clear on an unrevoked peer → false');
    ok(clearKnownPeerRevoked('nope') === false, 'clear on an unknown id → false');
    ok(clearKnownPeerRevoked(ID_A) === true, 'clear on a revoked peer → true');
    ok(!('revoked' in readKnownPeers()[ID_A]), 'clear deletes the field entirely (absent, not false)');
    ok(markKnownPeerRevoked(ID_A, good) === true, 'after a local clear the latch can be set again');
}

function deleteTests() {
    console.log('\ndeleteKnownPeer');
    store.clear();
    seed({ [ID_A]: entry(), [ID_B]: entry({ name: 'Phone' }) });
    ok(deleteKnownPeer('nope') === false, 'unknown id → false');
    ok(deleteKnownPeer(ID_A) === true, 'known id → true');
    const after = readKnownPeers();
    ok(!(ID_A in after), 'deleted entry is gone');
    ok(after[ID_B] && after[ID_B].name === 'Phone', 'other entries survive a delete');
    ok(deleteKnownPeer(ID_A) === false, 'double delete → false');
}

function forwardCompatTests() {
    console.log('\nunknown-field preservation across a mutation chain');
    store.clear();
    // A future writer added fields this module has never heard of, at the
    // entry level — every CRUD op here must carry them through untouched.
    seed({
        [ID_A]: entry({
            userPub: 'ed25519-pub', deviceCertIssuedAt: 1751500000000,
            v99Field: [1, 2, 3], nested: { deep: { flag: true } }
        })
    });
    renameKnownPeer(ID_A, 'Renamed');
    setKnownPeerPaused(ID_A, true);
    setKnownPeerSyncEnabled(ID_A, true);
    setKnownPeerBackupTarget(ID_A, false);
    markKnownPeerRevoked(ID_A, { revokedAt: 1, sig: 's' });
    clearKnownPeerRevoked(ID_A);
    const e = readKnownPeers()[ID_A];
    ok(e.userPub === 'ed25519-pub' && e.deviceCertIssuedAt === 1751500000000,
        'identity-layer fields survive the full CRUD chain');
    eq(e.v99Field, [1, 2, 3], 'unknown array field survives');
    eq(e.nested, { deep: { flag: true } }, 'unknown nested object survives');
    ok(e.name === 'Renamed' && e.paused === true && e.syncEnabled === true && e.backupTarget === false,
        'and the chain itself all landed');
}

function writeFailureTests() {
    console.log('\nquota / write-failure tolerance');
    store.clear();
    seed({ [ID_A]: entry() });
    const before = raw();
    setItemThrows = true;
    let threw = false;
    try { writeKnownPeers({ [ID_A]: entry({ name: 'lost' }) }); } catch (e) { threw = true; }
    ok(!threw, 'writeKnownPeers swallows a quota error');
    // Historical quirk worth knowing: because writeKnownPeers swallows the
    // error, mutateKnownPeers still reports true even though nothing
    // persisted. Callers treat the return as "mutation accepted", not
    // "durably stored".
    ok(mutateKnownPeers((m) => { m[ID_A].name = 'lost too'; return m; }) === true,
        'HISTORICAL: mutateKnownPeers returns true even when the underlying write failed');
    setItemThrows = false;
    ok(raw() === before, 'the failed writes left the stored value untouched');
    // writeKnownPeers also swallows serialization errors (circular map).
    const circular = {}; circular.self = circular;
    try { writeKnownPeers(circular); threw = false; } catch (e) { threw = true; }
    ok(!threw && raw() === before, 'unserializable map is swallowed, store untouched');
}

function dunderIdTests() {
    console.log('\ndunder ids (own-property guard)');
    // Every entry lookup goes through an own-property check (ownEntry):
    // a bare map[id] would resolve '__proto__'/'constructor' through the
    // prototype chain and write onto Object.prototype. Wire boundaries
    // reject dunder device ids too (DEVICE_ID_RE), but the module must not
    // rely on its callers for that.
    store.clear();
    const polluted = renameKnownPeer('__proto__', 'zzz');
    const protoName = Object.prototype.name;
    delete Object.prototype.name; // clean up if the guard ever regresses
    ok(polluted === false && protoName === undefined,
        'renameKnownPeer("__proto__") is refused and never touches Object.prototype');
    ok(setKnownPeerPaused('constructor', true) === false,
        'setKnownPeerPaused("constructor") is refused (own-property guard)');
    ok(deleteKnownPeer('__proto__') === false,
        'deleteKnownPeer("__proto__") is refused (own-property guard)');
    ok(!Object.prototype.hasOwnProperty.call(readKnownPeers(), '__proto__'),
        'the persisted store never gains an own __proto__ entry (JSON.stringify drops it)');
}

console.log('Known-peers unit tests — arcade.v1._meta.knownPeers CRUD (no browser)');
keyContractTests();
readToleranceTests();
roundTripTests();
mutateTests();
renameTests();
flagTests();
revocationTests();
deleteTests();
forwardCompatTests();
writeFailureTests();
dunderIdTests();
console.log('');
if (fail) { console.log(fail + ' check(s) FAILED.'); process.exit(1); }
console.log('All ' + pass + ' known-peers unit checks passed.');
