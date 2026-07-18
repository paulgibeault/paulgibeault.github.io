/* backup-unit.mjs — hermetic Node unit tests for the backup-to-trusted-peer
 * pure primitives (#31, arcade-backup-core.js): the kind:'backup' envelope
 * BODY validator, the bundle-string chunker, generation keys, and the
 * retention plan. The transfer/consent flow itself is proven end-to-end in
 * tools/backup-acceptance.mjs.
 *
 * No browser, no network. Run: `npm run backup-unit`.
 */
import {
    BACKUP_PROTOCOL_V,
    BACKUP_GENERATIONS,
    BACKUP_CHUNK_CHARS,
    BACKUP_MAX_PARTS,
    BACKUP_MAX_CHARS,
    BACKUP_DELTA_FORMAT,
    BACKUP_DELTA_V,
    chunkString,
    genKey,
    planGenerationStore,
    validateBackupEnvelope,
    dataHashesOf,
    senderBaseInfo,
    deltaOfferAllowed,
    buildBackupDelta,
    validateBackupDelta,
    applyBackupDelta
} from '../arcade-backup-core.js';
import { checksumBundle } from '../arcade-storage-core.js';
import { sha256Hex, hlcPack } from '../arcade-sync-core.js';
import { buildJournalSection, buildManifestSection } from '../arcade-save.js';

let pass = 0, fail = 0;
function ok(cond, label) {
    if (cond) { pass++; console.log('  ✓ ' + label); }
    else { fail++; console.log('  ✗ ' + label); }
}

const SUM = 'sha256:' + 'a'.repeat(64);
const SUM2 = 'sha256:' + 'b'.repeat(64);
const DEV = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789';
const OFFER = { v: 1, op: 'offer', id: 'x1', checksum: SUM, chars: 10, parts: 1, exportedAt: '2026-07-15T00:00:00.000Z' };

function validatorTests() {
    console.log('\nvalidateBackupEnvelope');
    ok(BACKUP_PROTOCOL_V === 1, 'protocol version is 1');
    ok(validateBackupEnvelope(OFFER).op === 'offer', 'valid offer passes');
    ok(validateBackupEnvelope(null).reason === 'bad-op', 'null rejected');
    ok(validateBackupEnvelope('x').reason === 'bad-op', 'string rejected');
    ok(validateBackupEnvelope({ ...OFFER, v: 2 }).reason === 'bad-v', 'wrong version rejected');
    ok(validateBackupEnvelope({ ...OFFER, op: 'digest' }).reason === 'bad-op', 'foreign op rejected');
    ok(validateBackupEnvelope({ ...OFFER, id: undefined }).reason === 'bad-id', 'missing id rejected');
    ok(validateBackupEnvelope({ ...OFFER, id: '' }).reason === 'bad-id', 'empty id rejected');
    ok(validateBackupEnvelope({ ...OFFER, id: 'x'.repeat(65) }).reason === 'bad-id', '65-char id rejected');
    ok(validateBackupEnvelope({ ...OFFER, id: 42 }).reason === 'bad-id', 'non-string id rejected');

    // offer field checks
    ok(validateBackupEnvelope({ ...OFFER, checksum: 'a'.repeat(64) }).reason === 'bad-checksum',
        'offer checksum without sha256: prefix rejected');
    ok(validateBackupEnvelope({ ...OFFER, checksum: 'sha256:' + 'a'.repeat(63) }).reason === 'bad-checksum',
        'offer checksum with short hex rejected');
    ok(validateBackupEnvelope({ ...OFFER, chars: 0 }).reason === 'bad-size', 'offer chars 0 rejected');
    ok(validateBackupEnvelope({ ...OFFER, chars: BACKUP_MAX_CHARS + 1 }).reason === 'bad-size',
        'offer chars over BACKUP_MAX_CHARS rejected');
    ok(validateBackupEnvelope({ ...OFFER, chars: BACKUP_MAX_CHARS }).ok, 'offer chars at the cap passes');
    ok(validateBackupEnvelope({ ...OFFER, chars: 1.5 }).reason === 'bad-size', 'offer non-integer chars rejected');
    ok(validateBackupEnvelope({ ...OFFER, parts: 0 }).reason === 'bad-size', 'offer parts 0 rejected');
    ok(validateBackupEnvelope({ ...OFFER, parts: BACKUP_MAX_PARTS + 1 }).reason === 'bad-size',
        'offer parts over BACKUP_MAX_PARTS rejected (reject before buffering)');
    ok(validateBackupEnvelope({ ...OFFER, exportedAt: undefined }).reason === 'bad-meta', 'offer without exportedAt rejected');
    ok(validateBackupEnvelope({ ...OFFER, exportedAt: 'x'.repeat(41) }).reason === 'bad-meta', 'oversize exportedAt rejected');

    // chunk field checks
    const CHUNK = { v: 1, op: 'chunk', id: 'x1', seq: 0, parts: 2, body: 'abc' };
    ok(validateBackupEnvelope(CHUNK).op === 'chunk', 'valid chunk passes');
    ok(validateBackupEnvelope({ ...CHUNK, seq: -1 }).reason === 'bad-seq', 'negative seq rejected');
    ok(validateBackupEnvelope({ ...CHUNK, seq: 2 }).reason === 'bad-seq', 'seq >= parts rejected');
    ok(validateBackupEnvelope({ ...CHUNK, parts: BACKUP_MAX_PARTS + 1, seq: 0 }).reason === 'bad-size',
        'chunk with hostile parts count rejected');
    ok(validateBackupEnvelope({ ...CHUNK, body: 7 }).reason === 'bad-body', 'non-string body rejected');
    ok(validateBackupEnvelope({ ...CHUNK, body: 'x'.repeat(BACKUP_CHUNK_CHARS + 1) }).reason === 'bad-body',
        'oversize chunk body rejected');
    ok(validateBackupEnvelope({ ...CHUNK, body: 'x'.repeat(BACKUP_CHUNK_CHARS) }).ok,
        'chunk body at the cap passes');

    // accept / decline / ack
    ok(validateBackupEnvelope({ v: 1, op: 'accept', id: 'x1' }).op === 'accept', 'valid accept passes');
    ok(validateBackupEnvelope({ v: 1, op: 'decline', id: 'x1' }).op === 'decline', 'decline without reason passes');
    ok(validateBackupEnvelope({ v: 1, op: 'decline', id: 'x1', reason: 'off' }).ok, 'decline with reason passes');
    ok(validateBackupEnvelope({ v: 1, op: 'decline', id: 'x1', reason: 'x'.repeat(33) }).reason === 'bad-meta',
        'oversize decline reason rejected');
    ok(validateBackupEnvelope({ v: 1, op: 'decline', id: 'x1', reason: 42 }).reason === 'bad-meta',
        'non-string decline reason rejected');
    ok(validateBackupEnvelope({ v: 1, op: 'ack', id: 'x1', checksum: SUM }).op === 'ack', 'valid ack passes');
    ok(validateBackupEnvelope({ v: 1, op: 'ack', id: 'x1' }).reason === 'bad-checksum', 'ack without checksum rejected');
}

function chunkTests() {
    console.log('\nchunkString');
    ok(JSON.stringify(chunkString('', 3)) === '[""]', "empty string still yields one chunk (parts >= 1)");
    ok(JSON.stringify(chunkString('abcdef', 3)) === '["abc","def"]', 'exact multiple splits cleanly');
    ok(JSON.stringify(chunkString('abcdefg', 3)) === '["abc","def","g"]', 'remainder gets its own final chunk');
    ok(JSON.stringify(chunkString('ab', 3)) === '["ab"]', 'short input is a single chunk');
    const big = 'x'.repeat(BACKUP_CHUNK_CHARS * 2 + 5);
    const chunks = chunkString(big, BACKUP_CHUNK_CHARS);
    ok(chunks.length === 3 && chunks.join('') === big, 'round-trip: join(chunks) === input at production chunk size');
    ok(chunks.every((c) => c.length <= BACKUP_CHUNK_CHARS), 'every chunk respects the cap the validator enforces');
}

function genKeyTests() {
    console.log('\ngeneration keys');
    ok(genKey(DEV, 999) === 'g|' + DEV + '|' + '0000000000999', 'millis field zero-padded to 13 digits');
    ok(genKey(DEV, 999) < genKey(DEV, 1000), 'lexicographic order is chronological');
}

function retentionTests() {
    console.log('\nplanGenerationStore');
    const g = (ms, checksum) => ({ key: genKey(DEV, ms), checksum });
    let plan = planGenerationStore([], SUM, BACKUP_GENERATIONS);
    ok(plan.store === true && plan.prune.length === 0, 'first generation stores, nothing pruned');

    plan = planGenerationStore([g(1, SUM2), g(2, SUM)], SUM, BACKUP_GENERATIONS);
    ok(plan.store === false && plan.prune.length === 0,
        'identical content to the NEWEST generation is not re-stored (reconnect churn burns nothing)');

    plan = planGenerationStore([g(1, SUM), g(2, SUM2)], SUM, BACKUP_GENERATIONS);
    ok(plan.store === true, 'matching an OLDER generation still stores (only the newest dedupes)');

    plan = planGenerationStore([g(1, 'c1'), g(2, 'c2'), g(3, 'c3')], SUM, 3);
    ok(plan.store === true && plan.prune.length === 1 && plan.prune[0] === genKey(DEV, 1),
        'at the cap: oldest generation is pruned to make room');

    plan = planGenerationStore([g(1, 'c1'), g(2, 'c2'), g(3, 'c3'), g(4, 'c4')], SUM, 3);
    ok(plan.prune.length === 2 && plan.prune.indexOf(genKey(DEV, 1)) !== -1 && plan.prune.indexOf(genKey(DEV, 2)) !== -1,
        'over the cap (defensive): prunes down to cap-1 before storing');

    plan = planGenerationStore([g(1, 'c1')], SUM, 3);
    ok(plan.store === true && plan.prune.length === 0, 'under the cap: nothing pruned');
}

function deltaEnvelopeTests() {
    console.log('\nvalidateBackupEnvelope — delta ops (additive on v1)');
    ok(validateBackupEnvelope({ ...OFFER, deltaFrom: SUM2 }).ok, 'offer with a well-formed deltaFrom passes');
    ok(validateBackupEnvelope(OFFER).ok, 'offer without deltaFrom still passes (field is optional)');
    ok(validateBackupEnvelope({ ...OFFER, deltaFrom: 'garbage' }).reason === 'bad-checksum', 'malformed deltaFrom rejected');
    ok(validateBackupEnvelope({ ...OFFER, deltaFrom: 42 }).reason === 'bad-checksum', 'non-string deltaFrom rejected');
    ok(validateBackupEnvelope({ v: 1, op: 'accept-delta', id: 'x1', base: SUM }).ok, 'well-formed accept-delta passes');
    ok(validateBackupEnvelope({ v: 1, op: 'accept-delta', id: 'x1' }).reason === 'bad-checksum', 'accept-delta without base rejected');
    ok(validateBackupEnvelope({ v: 1, op: 'delta-info', id: 'x1', chars: 100, parts: 1 }).ok, 'well-formed delta-info passes');
    ok(validateBackupEnvelope({ v: 1, op: 'delta-info', id: 'x1', chars: 0, parts: 1 }).reason === 'bad-size', 'delta-info chars 0 rejected');
    ok(validateBackupEnvelope({ v: 1, op: 'delta-info', id: 'x1', chars: 100, parts: BACKUP_MAX_PARTS + 1 }).reason === 'bad-size',
        'delta-info parts over the cap rejected');
}

function deltaOfferAllowedTests() {
    console.log('\ndeltaOfferAllowed (watermark refusal)');
    const CLK = hlcPack(5000, 0, DEV);
    const info = { checksum: SUM, clock: CLK, dataHashes: {}, storeHashes: {}, fileHashes: {} };
    ok(deltaOfferAllowed(info, null) === true, 'no eviction ever ⇒ delta allowed');
    ok(deltaOfferAllowed(info, hlcPack(4000, 0, DEV)) === true, 'base clock past the watermark ⇒ delta allowed');
    ok(deltaOfferAllowed(info, CLK) === true, 'base clock exactly AT the watermark ⇒ still allowed (>=)');
    ok(deltaOfferAllowed(info, hlcPack(6000, 0, DEV)) === false,
        'base clock BEHIND the watermark ⇒ refused (an evicted tombstone may postdate the base)');
    ok(deltaOfferAllowed({ ...info, clock: null }, hlcPack(1, 0, DEV)) === false, 'no base clock + a watermark ⇒ refused');
    ok(deltaOfferAllowed({ ...info, dataHashes: undefined }, null) === false, 'missing diff material ⇒ refused');
    ok(deltaOfferAllowed(null, null) === false, 'no base info at all ⇒ refused');
}

// Synthetic full bundle with real journal/manifest sections — the same
// shapes buildBundle emits, minus the browser storage collection.
async function makeBundle(data, stores, files, journalRecords) {
    const bundle = {
        format: 'pauls-arcade-save', schemaVersion: 2,
        exportedAt: '2026-07-18T00:00:00.000Z', appVersion: '1.0.0',
        checksum: await checksumBundle(data, stores, files),
        data, stores, files
    };
    bundle.journal = await buildJournalSection(hlcPack(9000, 0, DEV), journalRecords || {}, new Set(Object.keys(data)));
    bundle.manifest = await buildManifestSection(stores, files);
    return bundle;
}

async function deltaRoundTripTests() {
    console.log('\nbuildBackupDelta / applyBackupDelta (materialize-and-verify)');
    const K1 = 'arcade.v1.g.k1', K2 = 'arcade.v1.g.k2', KDEL = 'arcade.v1.g.kdel', KNEW = 'arcade.v1.g.knew';
    const S1 = 'arcade.v1.g.store.s1', S2 = 'arcade.v1.g.store.s2', S3 = 'arcade.v1.g.store.s3';
    const F = 'arcade.v1.g';
    const f1 = { name: 'f1.bin', type: '', size: 1, b64: 'AA==' };
    const f2 = { name: 'f2.bin', type: '', size: 1, b64: 'AQ==' };
    const f2v2 = { name: 'f2.bin', type: '', size: 2, b64: 'AQI=' };
    const f3 = { name: 'f3.bin', type: '', size: 1, b64: 'Ag==' };

    const base = await makeBundle(
        { [K1]: '"a"', [K2]: '"b"', [KDEL]: '"gone"' },
        { [S1]: { a: 1 }, [S2]: { b: 2 } },
        { [F]: [f1, f2] }
    );
    const current = await makeBundle(
        { [K1]: '"a"', [K2]: '"B2"', [KNEW]: '"new"' },
        { [S1]: { a: 1 }, [S2]: { b: 99 }, [S3]: { c: 3 } },
        { [F]: [f1, f2v2, f3] }
    );
    const baseInfo = { checksum: base.checksum, ...(await senderBaseInfo(base)) };
    const doc = await buildBackupDelta(baseInfo, current);
    ok(!!doc && doc.format === BACKUP_DELTA_FORMAT && doc.v === BACKUP_DELTA_V, 'delta document built with format + version');
    ok(doc.from === base.checksum && doc.to === current.checksum, 'delta names base and target checksums');
    ok(Object.keys(doc.set).sort().join() === [K2, KNEW].sort().join(), 'set carries exactly the changed + added data keys');
    ok(doc.del.length === 1 && doc.del[0] === KDEL, 'del carries exactly the removed data key');
    ok(Object.keys(doc.stores).sort().join() === [S2, S3].sort().join(), 'stores carries exactly the changed + added DBs (whole-DB granularity)');
    ok(Object.keys(doc.files).sort().join() === [F + '/f2.bin', F + '/f3.bin'].sort().join(),
        'files carries exactly the changed + added files (whole-file granularity)');
    ok(validateBackupDelta(doc).ok, 'a built delta passes its structural validator');

    const m = applyBackupDelta(base, doc);
    ok((await checksumBundle(m.data, m.stores, m.files)) === current.checksum,
        'MATERIALIZE-AND-VERIFY: base + delta reproduces the target bundle checksum exactly');
    ok(m.data[KDEL] === undefined && m.data[KNEW] === '"new"', 'materialized data applied deletions and additions');

    // Tampered delta ⇒ the checksum gate catches it (the engine then falls
    // back to a full transfer — a delta can never smuggle state).
    const evil = JSON.parse(JSON.stringify(doc));
    evil.set[K2] = '"evil"';
    const me = applyBackupDelta(base, evil);
    ok((await checksumBundle(me.data, me.stores, me.files)) !== current.checksum,
        'a tampered delta value fails the materialized-checksum gate (checksum-mismatch drop)');

    // Unchanged content, reshuffled file enumeration: fileOrder makes the
    // materialization reproduce the sender's exact array order.
    const reordered = await makeBundle(
        base.data,
        base.stores,
        { [F]: [f2, f1] } // same items, reversed enumeration
    );
    ok(reordered.checksum !== base.checksum, '(sanity) file array order changes the canonical checksum');
    const doc2 = await buildBackupDelta(baseInfo, reordered);
    const m2 = applyBackupDelta(base, doc2);
    ok((await checksumBundle(m2.data, m2.stores, m2.files)) === reordered.checksum,
        'fileOrder reproduces a reshuffled enumeration without reshipping file bytes');
    ok(Object.keys(doc2.files).length === 0, '…and the reshuffle delta carries no file content at all');

    // Prototype-pollution safety in the apply step. The hostile key must be
    // constructed the way attacker JSON actually arrives — JSON.parse
    // creates an OWN '__proto__' property (a plain `=` assignment would
    // silently set the prototype instead and prove nothing).
    const polluted = JSON.parse(JSON.stringify(doc));
    polluted.set = JSON.parse('{"__proto__": "\\"owned\\""}');
    const mp = applyBackupDelta(base, polluted);
    ok(({}).owned === undefined && Object.prototype['__proto__2'] === undefined,
        "a '__proto__' key in the delta never pollutes Object.prototype");
    ok(Object.prototype.hasOwnProperty.call(mp.data, '__proto__'),
        'the dunder key lands as a plain own property (checksum/allowlist gates then reject it)');
}

async function dataHashesTests() {
    console.log('\ndataHashesOf / senderBaseInfo');
    const K = 'arcade.v1.g.k', K2 = 'arcade.v1.g.meta';
    const fakeX = 'f'.repeat(64);
    const bundle = await makeBundle({ [K]: '"v"', [K2]: '"m"' }, {}, {}, {
        [K]: { h: hlcPack(1, 0, DEV), x: fakeX, del: 0, t: 1 }
    });
    const hashes = await dataHashesOf(bundle);
    ok(hashes[K] === fakeX, "a journal record's x is reused verbatim (no re-hash)");
    ok(hashes[K2] === await sha256Hex('"m"'), 'a key OUTSIDE journal coverage is hashed directly (meta/global/import keys)');
    const info = await senderBaseInfo(bundle);
    ok(!!info && info.clock === bundle.journal.clock && !!info.dataHashes && !!info.storeHashes && !!info.fileHashes,
        'senderBaseInfo carries clock + all three hash maps');
    ok((await senderBaseInfo({ ...bundle, journal: undefined })) === null,
        'a bundle without a journal section yields no base info (full transfers only)');
}

function deltaValidatorTests() {
    console.log('\nvalidateBackupDelta (structural gate)');
    const good = {
        format: BACKUP_DELTA_FORMAT, v: BACKUP_DELTA_V, from: SUM, to: SUM2,
        exportedAt: '2026', set: {}, del: [], stores: {}, delStores: [], files: {}, delFiles: {}, fileOrder: {}
    };
    good.delFiles = [];
    ok(validateBackupDelta(good).ok, 'minimal well-formed delta passes');
    ok(!validateBackupDelta({ ...good, format: 'pauls-arcade-save' }).ok, 'a full bundle is not a delta (format gate)');
    ok(!validateBackupDelta({ ...good, v: 2 }).ok, 'unknown delta version rejected');
    ok(!validateBackupDelta({ ...good, from: 'garbage' }).ok, 'malformed from checksum rejected');
    ok(!validateBackupDelta({ ...good, set: { 'k': 42 } }).ok, 'non-string set value rejected');
    ok(!validateBackupDelta({ ...good, set: { ['k'.repeat(600)]: '"v"' } }).ok, 'oversize set key rejected');
    ok(!validateBackupDelta({ ...good, del: 'nope' }).ok, 'non-array del rejected');
    ok(!validateBackupDelta({ ...good, stores: { s: [] } }).ok, 'array store body rejected');
    ok(!validateBackupDelta({ ...good, files: { 'noslash': { name: 'x', b64: '' } } }).ok, 'file path without dir/name shape rejected');
    ok(!validateBackupDelta({ ...good, files: { 'd/x': { name: 'x' } } }).ok, 'file item without b64 rejected');
    ok(!validateBackupDelta({ ...good, fileOrder: { d: 'nope' } }).ok, 'non-array fileOrder entry rejected');
    ok(validateBackupDelta({ ...good, fileOrder: undefined }).ok, 'fileOrder is optional');
}

validatorTests();
chunkTests();
genKeyTests();
retentionTests();
deltaEnvelopeTests();
deltaOfferAllowedTests();

await deltaRoundTripTests();
await dataHashesTests();
deltaValidatorTests();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
