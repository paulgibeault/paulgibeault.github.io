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
    chunkString,
    genKey,
    planGenerationStore,
    validateBackupEnvelope
} from '../arcade-backup-core.js';

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

validatorTests();
chunkTests();
genKeyTests();
retentionTests();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
