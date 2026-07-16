/* local-backup-unit.mjs — hermetic Node unit tests for the automatic local
 * backup pure primitives (#30, arcade-local-backup-core.js): the snapshot
 * key format and the staleness check. planGenerationStore itself is already
 * covered by tools/backup-unit.mjs (arcade-local-backup-core.js re-exports
 * it verbatim from arcade-backup-core.js, no local reimplementation) — this
 * suite only re-proves it still resolves and behaves against a flat,
 * no-deviceId list, the shape local backup actually uses it with.
 *
 * The snapshot/restore/retention flow itself is proven end-to-end in
 * tools/local-backup-acceptance.mjs.
 *
 * No browser, no network. Run: `npm run local-backup-unit`.
 */
import {
    LOCAL_BACKUP_GENERATIONS,
    LOCAL_BACKUP_STALE_MS,
    localSnapshotKey,
    isSnapshotStale,
    planGenerationStore
} from '../arcade-local-backup-core.js';

let pass = 0, fail = 0;
function ok(cond, label) {
    if (cond) { pass++; console.log('  ✓ ' + label); }
    else { fail++; console.log('  ✗ ' + label); }
}

const SUM = 'sha256:' + 'a'.repeat(64);
const SUM2 = 'sha256:' + 'b'.repeat(64);

function keyTests() {
    console.log('\nlocalSnapshotKey');
    ok(localSnapshotKey(999) === 's|0000000000999', 'millis field zero-padded to 13 digits');
    ok(localSnapshotKey(999) < localSnapshotKey(1000), 'lexicographic order is chronological');
    ok(localSnapshotKey(0) === 's|0000000000000', 'zero millis pads to all zeros');
}

function stalenessTests() {
    console.log('\nisSnapshotStale');
    const now = 1_700_000_000_000;
    ok(isSnapshotStale(null, now) === true, 'null newestAt (never snapshotted) is stale');
    ok(isSnapshotStale(undefined, now) === true, 'undefined newestAt is stale');
    ok(isSnapshotStale(NaN, now) === true, 'NaN newestAt is stale');
    ok(isSnapshotStale(now - LOCAL_BACKUP_STALE_MS + 1, now) === false, 'just under the 24h window is not stale');
    ok(isSnapshotStale(now - LOCAL_BACKUP_STALE_MS, now) === true, 'exactly at the 24h window is stale');
    ok(isSnapshotStale(now - LOCAL_BACKUP_STALE_MS - 1, now) === true, 'just over the 24h window is stale');
    ok(isSnapshotStale(now, now) === false, 'a snapshot taken this instant is not stale');
    // custom staleMs override
    ok(isSnapshotStale(now - 100, now, 50) === true, 'custom staleMs window is honored (stale case)');
    ok(isSnapshotStale(now - 10, now, 50) === false, 'custom staleMs window is honored (fresh case)');
}

function retentionReuseTests() {
    console.log('\nplanGenerationStore (re-exported, no deviceId dimension)');
    const g = (ms, checksum) => ({ key: localSnapshotKey(ms), checksum });
    let plan = planGenerationStore([], SUM, LOCAL_BACKUP_GENERATIONS);
    ok(plan.store === true && plan.prune.length === 0, 'first snapshot stores, nothing pruned');

    plan = planGenerationStore([g(1, SUM2), g(2, SUM)], SUM, LOCAL_BACKUP_GENERATIONS);
    ok(plan.store === false, 'identical content to the newest kept snapshot is not re-stored');

    plan = planGenerationStore(
        [g(1, 'c1'), g(2, 'c2'), g(3, 'c3')].map((x) => x), SUM, LOCAL_BACKUP_GENERATIONS
    );
    ok(plan.store === true && plan.prune.length === 1 && plan.prune[0] === localSnapshotKey(1),
        `at the cap (${LOCAL_BACKUP_GENERATIONS}): oldest snapshot is pruned to make room`);
}

keyTests();
stalenessTests();
retentionReuseTests();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
