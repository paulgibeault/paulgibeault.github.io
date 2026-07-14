/* save-validation-unit.mjs — hermetic Node unit tests for the storage
 * allowlists and the save-import validation gates that the browser acceptance
 * harnesses can only exercise end-to-end.
 *
 * These are the launcher's storage trust boundary in pure form: the key
 * predicates that decide what a game may write / what a save may restore, and
 * the shape/allowlist/checksum gates that guard import. Extracting them into
 * arcade-storage-core.js / arcade-save.js made them importable without a
 * browser — so drift (a key that round-trips live but drops from a backup, a
 * protected trust record slipping through import) is caught here, cheaply.
 *
 * No browser, no network — runs anywhere Node exposes global crypto.subtle
 * (Node 20+). Run: `npm run save-unit`.
 */
import {
    isSafeArcadeKey,
    isLsProxyBackupKey,
    bridgeKeyWritable,
    IMPORT_PROTECTED_KEYS,
    stableStringify,
    checksumData,
    checksumBundle,
    SAVE_FORMAT
} from '../arcade-storage-core.js';
import { validateSaveBundle } from '../arcade-save.js';

let pass = 0, fail = 0;
function ok(cond, label) {
    if (cond) { pass++; console.log('  ✓ ' + label); }
    else { fail++; console.log('  ✗ ' + label); }
}

function keyPredicateTests() {
    console.log('\nkey predicates');

    // isSafeArcadeKey — namespace + dunder guard.
    ok(isSafeArcadeKey('arcade.v1.game.score'), 'accepts a well-formed game key');
    ok(isSafeArcadeKey('arcade.v1.game.a.b.c'), 'accepts nested segments');
    ok(!isSafeArcadeKey('other.v1.game.score'), 'rejects a non-arcade prefix');
    ok(!isSafeArcadeKey('arcade.v1.GAME.score'), 'rejects uppercase in the gameId segment');
    ok(!isSafeArcadeKey('arcade.v1.game'), 'rejects a single-segment key (no sub-path)');
    ok(!isSafeArcadeKey('arcade.v1.__proto__.x'), 'rejects a __proto__ segment');
    ok(!isSafeArcadeKey('arcade.v1.game.constructor'), 'rejects a constructor segment');
    ok(!isSafeArcadeKey('arcade.v1.game.a.prototype.b'), 'rejects a prototype segment mid-path');

    // isLsProxyBackupKey — the '.ls.' subtree carries verbatim sub-keys.
    ok(isLsProxyBackupKey('arcade.v1.game.ls.some key:with/slashes'), 'accepts a verbatim ls-proxy sub-key');
    ok(!isLsProxyBackupKey('arcade.v1.game.notls.x'), 'rejects a non-ls key');
    ok(!isLsProxyBackupKey('arcade.v1.__proto__.ls.x'), 'rejects a dunder segment in an ls key');
    ok(!isLsProxyBackupKey('other.v1.game.ls.x'), 'rejects an ls key outside the arcade namespace');

    // bridgeKeyWritable — own namespace + global.* + _meta.dev only.
    ok(bridgeKeyWritable('game', 'arcade.v1.game.score'), 'a game may write its own namespace');
    ok(bridgeKeyWritable('game', 'arcade.v1.global.theme'), 'a game may write the shared global.* namespace');
    ok(bridgeKeyWritable('game', 'arcade.v1._meta.dev'), 'a game may write the _meta.dev literal');
    ok(!bridgeKeyWritable('game', 'arcade.v1.other.score'), 'a game may NOT write another game\'s namespace');
    ok(!bridgeKeyWritable('game', 'arcade.v1._meta.deviceId'), 'a game may NOT write _meta.deviceId');
    ok(!bridgeKeyWritable('game', 'arcade.v1._meta.knownPeers'), 'a game may NOT write _meta.knownPeers');
    ok(!bridgeKeyWritable('game', 'arcade.v1.game.' + 'x'.repeat(520)), 'rejects a key longer than 512 chars');
    ok(!bridgeKeyWritable('game', 12345), 'rejects a non-string key');
}

function checksumTests() {
    console.log('\ncanonical form + checksum');
    ok(stableStringify({ a: 1, b: 2 }) === stableStringify({ b: 2, a: 1 }), 'stableStringify is property-order independent');
    ok(stableStringify({ a: [1, { y: 2, x: 1 }] }) === '{"a":[1,{"x":1,"y":2}]}', 'stableStringify sorts nested object keys, preserves array order');
}

async function validateTests() {
    console.log('\nvalidateSaveBundle');

    // A minimal signed v1 bundle (localStorage-only).
    const v1data = { 'arcade.v1.game.score': '42', 'arcade.v1.global.theme': '"dark"' };
    const v1 = { format: SAVE_FORMAT, schemaVersion: 1, data: v1data, checksum: await checksumData(v1data) };
    let r = await validateSaveBundle(v1);
    ok(r.ok && r.cleanKeys.length === 2 && !r.isV2, 'accepts a valid v1 bundle');

    // A signed v2 bundle with stores + files.
    const v2data = { 'arcade.v1.game.score': '7' };
    const v2stores = { 'arcade.v1.game.store.default': { hi: { n: 1 } } };
    const v2files = { 'arcade.v1.game': [{ name: 'a.bin', type: '', size: 1, b64: 'AA==' }] };
    const v2 = {
        format: SAVE_FORMAT, schemaVersion: 2, data: v2data, stores: v2stores, files: v2files,
        checksum: await checksumBundle(v2data, v2stores, v2files)
    };
    r = await validateSaveBundle(v2);
    ok(r.ok && r.isV2 && Object.keys(r.parsedStores).length === 1 && Object.keys(r.parsedFiles).length === 1,
        'accepts a valid v2 bundle with stores + files');

    // Shape failures → 'not-a-save'.
    ok((await validateSaveBundle({ format: 'nope', schemaVersion: 1, data: {}, checksum: 'x' })).reason === 'not-a-save', 'wrong format → not-a-save');
    ok((await validateSaveBundle({ format: SAVE_FORMAT, schemaVersion: 0, data: {}, checksum: 'x' })).reason === 'not-a-save', 'schemaVersion 0 → not-a-save');
    ok((await validateSaveBundle({ format: SAVE_FORMAT, schemaVersion: 3, data: {}, checksum: 'x' })).reason === 'not-a-save', 'schemaVersion above SAVE_SCHEMA → not-a-save');
    ok((await validateSaveBundle({ format: SAVE_FORMAT, schemaVersion: 1, data: [], checksum: 'x' })).reason === 'not-a-save', 'array data → not-a-save');

    // Unsafe keys and non-string values are dropped, not restored.
    const mixed = {
        'arcade.v1.game.good': 'ok',
        'other.v1.bad': 'x',                 // wrong namespace → dropped
        'arcade.v1.__proto__.evil': 'x',     // dunder → dropped
        'arcade.v1.game.numeric': 5          // non-string value → dropped
    };
    r = await validateSaveBundle({ format: SAVE_FORMAT, schemaVersion: 1, data: mixed, checksum: await checksumData(mixed) });
    ok(r.ok && r.cleanKeys.length === 1 && r.droppedKeys.length === 3, 'unsafe keys + non-string values land in droppedKeys');

    // Protected trust/identity keys are excluded from cleanData and counted.
    const protectedData = { 'arcade.v1.game.score': '1' };
    for (const k of IMPORT_PROTECTED_KEYS) protectedData[k] = 'attacker-value';
    r = await validateSaveBundle({ format: SAVE_FORMAT, schemaVersion: 1, data: protectedData, checksum: await checksumData(protectedData) });
    ok(r.ok && r.protectedSkipped === IMPORT_PROTECTED_KEYS.size, 'every IMPORT_PROTECTED_KEYS member is skipped + counted');
    ok(r.ok && [...IMPORT_PROTECTED_KEYS].every((k) => !(k in r.cleanData)), 'no protected key survives into cleanData');

    // All-invalid data → 'no-valid-keys'.
    const allBad = { 'other.v1.x': 'y', 'arcade.v1.__proto__.z': 'w' };
    r = await validateSaveBundle({ format: SAVE_FORMAT, schemaVersion: 1, data: allBad, checksum: await checksumData(allBad) });
    ok(r.reason === 'no-valid-keys', 'a bundle with no valid keys → no-valid-keys');

    // Flipped checksum → 'checksum-mismatch'.
    ok((await validateSaveBundle({ format: SAVE_FORMAT, schemaVersion: 1, data: v1data, checksum: 'sha256:deadbeef' })).reason === 'checksum-mismatch',
        'a wrong checksum → checksum-mismatch');

    // Tampered v2 stores fail the checksum (signed over original sections).
    const tampered = { ...v2, stores: { 'arcade.v1.game.store.default': { hi: { n: 999 } } } };
    ok((await validateSaveBundle(tampered)).reason === 'checksum-mismatch', 'tampering with v2 stores fails the checksum');

    // Checksum verifies the ORIGINAL data, not the filtered cleanData: a file
    // whose signed data includes a protected key (excluded from cleanData) must
    // still verify — proving we hash what was signed, not what we kept.
    const withProtected = { 'arcade.v1.game.score': '3', 'arcade.v1._meta.deviceId': 'abc' };
    const signedOverOriginal = { format: SAVE_FORMAT, schemaVersion: 1, data: withProtected, checksum: await checksumData(withProtected) };
    const rp = await validateSaveBundle(signedOverOriginal);
    ok(rp.ok && rp.protectedSkipped === 1 && rp.cleanKeys.length === 1,
        'checksum verifies original data even though a protected key is filtered from cleanData');
}

(async () => {
    console.log('Save-validation unit tests — key allowlists + import gates');
    keyPredicateTests();
    checksumTests();
    await validateTests();
    console.log('');
    if (fail) { console.log(fail + ' check(s) FAILED.'); process.exit(1); }
    console.log('All ' + pass + ' save-validation checks passed.');
})();
