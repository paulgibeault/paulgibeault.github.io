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
import {
    validateSaveBundle,
    encryptBundleJson,
    decryptBundleJson,
    ENC_FORMAT,
    buildJournalSection,
    verifyJournalSection,
    buildManifestSection,
    verifyManifestSection
} from '../arcade-save.js';
import { checksumCanonical } from '../arcade-storage-core.js';
import { hlcPack } from '../arcade-sync-core.js';

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

    // …but a v2 bundle whose DATA is empty while stores/files carry content
    // is a legitimate save (a device persisting only via Arcade.store/files).
    // This rule must stay in step with exportBundleString's "nothing to back
    // up" check — see #31: a stores-only bundle that export offers but import
    // rejects would loop the backup transfer forever, never storable.
    const storesOnly = { 'arcade.v1.game.store.default': { hi: { n: 1 } } };
    r = await validateSaveBundle({
        format: SAVE_FORMAT, schemaVersion: 2, data: {}, stores: storesOnly, files: {},
        checksum: await checksumBundle({}, storesOnly, {})
    });
    ok(r.ok && r.cleanKeys.length === 0, 'a v2 stores-only bundle (empty data) is accepted');
    r = await validateSaveBundle({
        format: SAVE_FORMAT, schemaVersion: 2, data: {}, stores: {}, files: {},
        checksum: await checksumBundle({}, {}, {})
    });
    ok(r.reason === 'no-valid-keys', 'a v2 bundle empty in ALL sections → no-valid-keys');

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

    // Human-only checksum override (#29): default behavior (no opts) is
    // UNCHANGED — this is the exact posture arcade-backup.js's two call
    // sites rely on, since neither ever passes opts.
    const mismatched = { format: SAVE_FORMAT, schemaVersion: 1, data: v1data, checksum: 'sha256:deadbeef' };
    ok((await validateSaveBundle(mismatched)).reason === 'checksum-mismatch',
        'checksum-mismatch with no opts is still a hard reject (regression pin)');
    const overridden = await validateSaveBundle(mismatched, { allowChecksumMismatch: true });
    ok(overridden.ok && overridden.checksumOk === false && overridden.cleanKeys.length === 2,
        'checksum-mismatch WITH allowChecksumMismatch:true is accepted, flagged checksumOk:false');
    const notMismatched = await validateSaveBundle(v1, { allowChecksumMismatch: true });
    ok(notMismatched.ok && notMismatched.checksumOk === true,
        'a bundle whose checksum is actually fine reports checksumOk:true regardless of the override flag');
}

async function sectionTests() {
    console.log('\nbundle provenance sections (journal + manifest, durability design §4)');
    const DEV = 'dev-aaaaaa';
    const H1 = hlcPack(1000, 0, DEV), H2 = hlcPack(2000, 0, DEV), H3 = hlcPack(3000, 0, DEV);
    const X = 'a'.repeat(64);
    const clk = H3;

    // --- journal: build is bounded (data keys + tombstones only) ---
    const records = {
        'arcade.v1.game.score': { h: H1, x: X, del: 0, t: 5 },
        'arcade.v1.game.gone': { h: H2, x: X, del: 1, t: 6 },
        'arcade.v1.game.orphan': { h: H1, x: X, del: 0, t: 7 } // live but absent from data
    };
    const j = await buildJournalSection(clk, records, new Set(['arcade.v1.game.score']));
    ok(j.v === 1 && j.clock === clk, 'journal section carries v + the build-time clock');
    ok(!!j.records['arcade.v1.game.score'], 'journal keeps records for keys present in data');
    ok(!!j.records['arcade.v1.game.gone'], 'journal keeps tombstones even when the key is absent from data');
    ok(!j.records['arcade.v1.game.orphan'], 'journal drops live records absent from data (bounded by construction)');

    // --- journal: verify round-trip + fail-closed ---
    let vj = await verifyJournalSection(j);
    ok(vj.ok && vj.clock === clk && Object.keys(vj.records).length === 2, 'verifyJournalSection round-trips a built section');
    const tamperedJ = JSON.parse(JSON.stringify(j));
    tamperedJ.records['arcade.v1.game.gone'].del = 0; // resurrect a deletion
    ok(!(await verifyJournalSection(tamperedJ)).ok, 'a tampered journal section fails its self-checksum');
    const smuggleRecords = { 'arcade.v1._meta.deviceId': { h: H1, x: X, del: 0, t: 1 } };
    const smuggle = { v: 1, clock: clk, records: smuggleRecords, checksum: await checksumCanonical({ clock: clk, records: smuggleRecords }) };
    ok(!(await verifyJournalSection(smuggle)).ok, 'a journal entry for a non-sync-eligible key is rejected even with a valid checksum');
    const badHlcRecords = { 'arcade.v1.game.k': { h: 'not-an-hlc', x: X, del: 0, t: 1 } };
    const badHlc = { v: 1, clock: clk, records: badHlcRecords, checksum: await checksumCanonical({ clock: clk, records: badHlcRecords }) };
    ok(!(await verifyJournalSection(badHlc)).ok, 'a journal record with a malformed HLC is rejected');
    ok(!(await verifyJournalSection(undefined)).ok, 'an absent journal section verifies false (consumers degrade to today)');
    ok(!(await verifyJournalSection({ v: 2, clock: clk, records: {}, checksum: 'x' })).ok, 'an unknown journal section version is rejected');
    const nullClock = await buildJournalSection(null, {}, new Set());
    ok((await verifyJournalSection(nullClock)).ok, 'a journal with a null clock (no stamps yet) round-trips');

    // --- manifest: build + verify round-trip ---
    const stores = { 'arcade.v1.game.store.default': { hi: { n: 1 } } };
    const files = { 'arcade.v1.game': [{ name: 'a.bin', type: '', size: 1, b64: 'AA==' }] };
    const m = await buildManifestSection(stores, files);
    ok(m.v === 1 && /^sha256:[0-9a-f]{64}$/.test(m.stores['arcade.v1.game.store.default']), 'manifest carries one hash per store DB');
    ok(/^sha256:[0-9a-f]{64}$/.test(m.files['arcade.v1.game/a.bin']), 'manifest carries one hash per file (dir/name key)');
    ok((await verifyManifestSection(m)).ok, 'verifyManifestSection round-trips a built section');
    const m2 = await buildManifestSection({ 'arcade.v1.game.store.default': { hi: { n: 2 } } }, files);
    ok(m2.stores['arcade.v1.game.store.default'] !== m.stores['arcade.v1.game.store.default'], 'a store hash tracks the store content');
    ok(m2.files['arcade.v1.game/a.bin'] === m.files['arcade.v1.game/a.bin'], 'file hashes are independent of store changes');
    const tamperedM = JSON.parse(JSON.stringify(m));
    tamperedM.files['arcade.v1.game/a.bin'] = 'sha256:' + 'b'.repeat(64);
    ok(!(await verifyManifestSection(tamperedM)).ok, 'a tampered manifest section fails its self-checksum');
    const badName = { v: 1, stores: { 'not-a-store-db': 'sha256:' + 'a'.repeat(64) }, files: {}, checksum: '' };
    badName.checksum = await checksumCanonical({ stores: badName.stores, files: badName.files });
    ok(!(await verifyManifestSection(badName)).ok, 'a manifest entry with an invalid store DB name is rejected');
    ok(!(await verifyManifestSection(null)).ok, 'an absent manifest section verifies false');

    // --- additive compatibility: sections never affect bundle validation ---
    const data = { 'arcade.v1.game.score': '7' };
    const withSections = {
        format: SAVE_FORMAT, schemaVersion: 2, data, stores: {}, files: {},
        checksum: await checksumBundle(data, {}, {}),
        journal: j, manifest: m
    };
    let r = await validateSaveBundle(withSections);
    ok(r.ok, 'a bundle carrying journal + manifest sections still validates (additive superset, schemaVersion stays 2)');
    const garbageSections = { ...withSections, journal: { total: 'garbage' }, manifest: 42 };
    r = await validateSaveBundle(garbageSections);
    ok(r.ok, 'garbage sections cannot fail bundle validation (advisory, never authoritative)');
    const sansSections = { format: SAVE_FORMAT, schemaVersion: 2, data, stores: {}, files: {}, checksum: await checksumBundle(data, {}, {}) };
    ok((await validateSaveBundle(sansSections)).ok, 'a section-less bundle (old device export) still validates');
}

async function encryptionTests() {
    console.log('\nencryptBundleJson / decryptBundleJson');
    const json = JSON.stringify({ hello: 'world', n: 42 });

    const envelope = await encryptBundleJson(json, 'correct horse battery staple');
    ok(envelope.format === ENC_FORMAT && envelope.v === 1, 'envelope carries the encrypted format + version');
    ok(typeof envelope.salt === 'string' && typeof envelope.iv === 'string' && typeof envelope.ciphertext === 'string',
        'envelope carries base64 salt/iv/ciphertext');

    const roundTripped = await decryptBundleJson(envelope, 'correct horse battery staple');
    ok(roundTripped === json, 'round-trip: decrypt(encrypt(json, pw), pw) === json');

    ok((await decryptBundleJson(envelope, 'wrong passphrase')) === null, 'wrong passphrase → null');

    const tamperedCiphertext = { ...envelope, ciphertext: envelope.ciphertext.slice(0, -4) + 'abcd' };
    ok((await decryptBundleJson(tamperedCiphertext, 'correct horse battery staple')) === null,
        'tampered ciphertext fails the AES-GCM auth tag → null');

    const tamperedSalt = { ...envelope, salt: envelope.salt.slice(0, -4) + 'abcd' };
    ok((await decryptBundleJson(tamperedSalt, 'correct horse battery staple')) === null,
        'tampered salt derives the wrong key → null');

    const tamperedIv = { ...envelope, iv: envelope.iv.slice(0, -4) + 'abcd' };
    ok((await decryptBundleJson(tamperedIv, 'correct horse battery staple')) === null,
        'tampered iv fails decryption → null');

    ok((await decryptBundleJson(null, 'pw')) === null, 'null envelope → null, no crash');
    ok((await decryptBundleJson({ format: 'not-it' }, 'pw')) === null, 'wrong format → null without touching crypto');
    ok((await decryptBundleJson({ format: ENC_FORMAT }, 'pw')) === null, 'missing salt/iv/ciphertext fields → null');

    // Two encryptions of the same plaintext must use fresh salt/iv (never
    // reuse a nonce under the same derived key).
    const envelope2 = await encryptBundleJson(json, 'correct horse battery staple');
    ok(envelope.salt !== envelope2.salt && envelope.iv !== envelope2.iv,
        'two encryptions of the same plaintext use fresh random salt + iv');
}

(async () => {
    console.log('Save-validation unit tests — key allowlists + import gates');
    keyPredicateTests();
    checksumTests();
    await validateTests();
    await sectionTests();
    await encryptionTests();
    console.log('');
    if (fail) { console.log(fail + ' check(s) FAILED.'); process.exit(1); }
    console.log('All ' + pass + ' save-validation checks passed.');
})();
