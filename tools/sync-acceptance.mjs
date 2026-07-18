#!/usr/bin/env node
//
// tools/sync-acceptance.mjs — end-to-end proof of Arcade.sync (#28): two real
// launcher pages, paired over real WebRTC, replicate opted-in Arcade.state
// keys through the PRODUCTION bridge path
// (window.__arcade.storage.stateWrite -> handleBridgedStateWrite ->
// host.onStateWritten -> arcade-sync.js's noteLocalWrite), LWW-resolved over
// the kind:'sync' p2p envelope (arcade-p2p.js's onSyncEnvelope/
// sendSyncEnvelope). No game frame is involved — Arcade.sync is entirely
// launcher-side (see arcade-sync.js's header).
//
//   node tools/sync-acceptance.mjs
//
// Self-contained like the other p2p suites: local static server, local ICE,
// injected loopback dead-drop (no external broker touched). Ports 4792
// (http) / 4793 (drop server) — kept distinct from the other p2p suites'
// 4794-4799 (+4791 dev.sh) range (plans/arcade-sync.md's WP5 anchor).
//
// Exit code: 0 if all checks pass, 1 otherwise.

import { readFile } from 'node:fs/promises';
import { startP2PHarness, makeCheck } from './lib/p2p-test-harness.mjs';

const { check, failed } = makeCheck();
const harness = await startP2PHarness({ port: 4792, dropPort: 4793 });
const { launcherPage, ceremony } = harness;

// Borrowed verbatim from tools/p2p-reconnect-acceptance.mjs: compress the
// in-band-first-claim delays so pairing/reconnects finish in seconds.
const FAST_RDV = `(() => {
    const r = window.__arcade.p2p._rdv();
    r.options.listenerDelayMs = 800;
    r.options.callerDelayMs = 1600;
    window.__rdvEv = window.__rdvEv || [];
    for (const t of ['pair-established', 'reconnecting', 'reconnected', 'recovered-inband', 'gave-up', 'remote-bye'])
        r.addEventListener(t, () => window.__rdvEv.push(t));
})()`;

async function loadBridge(page) {
    await harness.bootBridge(page, { closeDialog: true });
    await page.evaluate(FAST_RDV);
}

async function pairBoth(H, J) {
    for (const page of [H, J]) {
        await page.waitForFunction(`(() => {
            const raw = localStorage.getItem('arcade.v1._meta.knownPeers');
            return raw && Object.keys(JSON.parse(raw)).length > 0;
        })()`, null, { timeout: 10000 });
    }
    for (const page of [H, J]) {
        await page.evaluate(() => {
            const known = JSON.parse(localStorage.getItem('arcade.v1._meta.knownPeers'));
            return window.__arcade.p2p.enableAutoReconnect(Object.keys(known)[0]);
        });
    }
    for (const page of [H, J]) {
        await page.waitForFunction(`window.__rdvEv.includes('pair-established')`, null, { timeout: 10000 });
    }
}

async function freshPair(tag) {
    const ctxH = await harness.newDeviceContext();
    const ctxJ = await harness.newDeviceContext();
    const H = await launcherPage(tag + ':host', ctxH);
    const J = await launcherPage(tag + ':joiner', ctxJ);
    await loadBridge(H); await loadBridge(J);
    await ceremony(H, J);
    await pairBoth(H, J);
    return { ctxH, ctxJ, H, J };
}

const connectedAgain = (page) =>
    page.waitForFunction(`window.__arcade.p2p.status() === 'connected'`, null, { timeout: 60000 })
        .then(() => true).catch(() => false);

async function rebootedAfterReload(page) {
    await page.waitForFunction('!!window.__arcade && !!window.__arcade.showGame');
    return page.waitForFunction(
        '!!window.__arcade.p2p && !!window.__arcade.p2p._addon()', null, { timeout: 20000 }
    ).then(() => true).catch(() => false);
}

// Per-pair opt-in (arcade-known-peers.js's setKnownPeerSyncEnabled). BOTH
// sides must enable for either direction to work. kick() bypasses the
// engine's exchange-start dedupe window so a forced digest exchange doesn't
// depend on onPeerIdentity timing (see report: this is required, not just
// belt-and-suspenders — see notes on scenario timing below).
const enableSync = (page) => page.evaluate(async () => {
    const { setKnownPeerSyncEnabled, readKnownPeers } = await import('./arcade-known-peers.js');
    const id = Object.keys(readKnownPeers())[0];
    setKnownPeerSyncEnabled(id, true);
    window.__arcade.sync.kick(id);
    return id;
});

// Returns { devOnH, devOnJ }: the peer deviceId as each side's knownPeers
// records it (H's copy of J's id, and vice versa) — needed for kick()/
// sendSyncEnvelope() calls that target a specific peer.
async function enableSyncBoth(H, J) {
    const [devOnH, devOnJ] = await Promise.all([enableSync(H), enableSync(J)]);
    return { devOnH, devOnJ };
}

// Node-side poll for cross-page convergence checks a single page's
// waitForFunction can't express (same bounded-deadline-loop idiom as
// tools/acceptance.mjs's frameFor helper — no long sleeps).
async function waitFor(fn, timeoutMs = 15000, intervalMs = 150) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await fn()) return true;
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    return false;
}

// Drives a write through the PRODUCTION bridge path exactly like a real
// game's Arcade.state.set would land: window.__arcade.storage.stateWrite ->
// handleBridgedStateWrite -> host.onStateWritten -> arcade-sync.js.
const stateWrite = (page, gameId, key, value) => page.evaluate(({ gameId, key, value }) =>
    window.__arcade.storage.stateWrite(gameId, { key, value }), { gameId, key, value });

const lsGet = (page, key) => page.evaluate((k) => localStorage.getItem(k), key);
const syncRecords = (page) => page.evaluate(() => window.__arcade.sync._records());

// A game's own Arcade.sync.enable() ('*' — every current & future own key)
// mirrored the way the SDK writes it (arcade-sdk.js's setKeySyncable),
// driven through the same bridge path a real Arcade.sync.enable() call
// would use.
const enableApp = (page, gameId) => stateWrite(page, gameId, `arcade.v1.${gameId}._sync`, '["*"]');

try {
    console.log('\nArcade.sync acceptance — two-launcher replication, LWW, exclusions\n');

    // 1. LIVE REPLICATION BOTH WAYS + _sync-LIST ADOPTION ON THE PASSIVE SIDE.
    {
        console.log('  [live replication both ways + adoption]');
        const s = await freshPair('A');
        await enableSyncBoth(s.H, s.J);
        // Seed the opt-in list on H only — J never runs 'syncfix' locally
        // and never calls Arcade.sync.enable() itself, so its _sync list for
        // this app doesn't exist yet. Proves the "inbound adoption rule"
        // (arcade-sync.js's adoptIntoSyncList): applying a diff for an
        // eligible key appends it to the RECEIVER's own _sync list too.
        await enableApp(s.H, 'syncfix');
        await stateWrite(s.H, 'syncfix', 'arcade.v1.syncfix.a', '"1"');
        check('H -> J: live write replicated',
            await waitFor(async () => (await lsGet(s.J, 'arcade.v1.syncfix.a')) === '"1"'));
        check("J's _sync list was created via inbound adoption (it never wrote one itself)",
            await waitFor(async () => {
                const raw = await lsGet(s.J, 'arcade.v1.syncfix._sync');
                if (!raw) return false;
                try { return JSON.parse(raw).includes('arcade.v1.syncfix.a'); } catch (e) { return false; }
            }));

        // Now have J opt its own copy of the app in ('*', same as a real
        // Arcade.sync.enable() call on device #2) and write a NEW key —
        // proves the other direction.
        await enableApp(s.J, 'syncfix');
        await stateWrite(s.J, 'syncfix', 'arcade.v1.syncfix.b', '"2"');
        check('J -> H: live write replicated',
            await waitFor(async () => (await lsGet(s.H, 'arcade.v1.syncfix.b')) === '"2"'));

        await s.ctxH.close(); await s.ctxJ.close();
    }

    // 2 + 3. CONVERGE AFTER RECONNECT (NEWER WINS), THEN RESTART SURVIVAL.
    {
        console.log('\n  [converge after reconnect (newer wins), then restart survival]');
        const s = await freshPair('B');
        const { devOnH, devOnJ } = await enableSyncBoth(s.H, s.J);
        await enableApp(s.H, 'syncfix'); await enableApp(s.J, 'syncfix');
        await stateWrite(s.H, 'syncfix', 'arcade.v1.syncfix.a', '"1"');
        check('baseline value replicated before the split',
            await waitFor(async () => (await lsGet(s.J, 'arcade.v1.syncfix.a')) === '"1"'));

        // Reload J: kills the link; resume-on-launch boots the transport by
        // itself and auto-heal takes over from there (mirrors
        // p2p-reconnect-acceptance.mjs's "terminated client mid-call").
        await s.J.reload();
        check('reloaded joiner booted the transport on its own', await rebootedAfterReload(s.J));
        await s.J.evaluate(FAST_RDV);

        // While J is down, write on H (older wall clock). Once J's page is
        // back — reload + boot already spent real wall-clock time — write on
        // J with a guaranteed-later HLC, before the heal's digest exchange
        // has a chance to run.
        await stateWrite(s.H, 'syncfix', 'arcade.v1.syncfix.a', '"H2"');
        await new Promise((r) => setTimeout(r, 60)); // guard margin: HLC millis must differ
        await stateWrite(s.J, 'syncfix', 'arcade.v1.syncfix.a', '"J3"');

        check('joiner healed after reload', await connectedAgain(s.J));
        check('host still healed', await connectedAgain(s.H));
        // Force a fresh digest exchange on both sides so convergence doesn't
        // depend on which side's onPeerIdentity beat the engine's 30s
        // exchange-start dedupe window (kick() bypasses it explicitly).
        await s.H.evaluate((d) => window.__arcade.sync.kick(d), devOnH);
        await s.J.evaluate((d) => window.__arcade.sync.kick(d), devOnJ);
        check('both sides converge on the newer write ("J3") after healing',
            await waitFor(async () => (await lsGet(s.H, 'arcade.v1.syncfix.a')) === '"J3"'
                && (await lsGet(s.J, 'arcade.v1.syncfix.a')) === '"J3"', 20000));

        // 3. RESTART SURVIVAL: reload J again. Before anything re-triggers a
        // load (no write, no inbound envelope yet), force ensureLoaded() via
        // kick() (which the engine also gates on p2p being attached — true
        // right after boot, live or not) and assert the RAM mirror was
        // repopulated from the 'arcade-sync' IndexedDB, not left empty.
        await s.J.reload();
        check('reloaded joiner (2nd time) booted the transport on its own', await rebootedAfterReload(s.J));
        await s.J.evaluate(FAST_RDV);
        await s.J.evaluate((d) => window.__arcade.sync.kick(d), devOnJ);
        check("_records() repopulated from IDB after reload (before healing)",
            await waitFor(async () => {
                const rec = (await syncRecords(s.J))['arcade.v1.syncfix.a'];
                return !!rec && rec.h && rec.x;
            }));

        check('joiner healed after the second reload', await connectedAgain(s.J));
        check('host still healed', await connectedAgain(s.H));
        await new Promise((r) => setTimeout(r, 60));
        await stateWrite(s.H, 'syncfix', 'arcade.v1.syncfix.a', '"H4"');
        await s.H.evaluate((d) => window.__arcade.sync.kick(d), devOnH);
        await s.J.evaluate((d) => window.__arcade.sync.kick(d), devOnJ);
        check('both sides converge on a fresh write after restart survival',
            await waitFor(async () => (await lsGet(s.H, 'arcade.v1.syncfix.a')) === '"H4"'
                && (await lsGet(s.J, 'arcade.v1.syncfix.a')) === '"H4"', 20000));

        await s.ctxH.close(); await s.ctxJ.close();
    }

    // 4. onConflict FIRES EXACTLY ON THE LOSING SIDE — live-diff path.
    //
    // Two live one-entry diffs crossing in flight while both sides stay
    // connected: the simplest concurrent-edit shape, no digest exchange
    // involved. The digest-path variant (sever-then-heal, the plan's original
    // scenario 4 sketch) is scenario 4b below — this suite originally caught
    // a real engine bug there (reconcileDigest committed the hlcRecv-advanced
    // clock as the per-pair cursor BEFORE the req'd diffs were applied, so
    // isConcurrentLoss saw every contested record as already-observed and
    // swallowed the conflict); fixed via the pending-cursor discipline in
    // reconcileDigest/drainPendingNeed, which 4b now pins as a regression
    // test.
    {
        console.log('\n  [onConflict fires on the losing side only, both converge]');
        const s = await freshPair('C');
        await enableSyncBoth(s.H, s.J);
        await enableApp(s.H, 'syncfix'); await enableApp(s.J, 'syncfix');
        const registerConflictListener = (page) => page.evaluate(() => {
            window.__syncConflicts = [];
            window.__arcade.sync.onConflict((c) => window.__syncConflicts.push(c));
        });
        await registerConflictListener(s.H);
        await registerConflictListener(s.J);

        // Both sides stay connected: concurrent (or near-concurrent) writes
        // to the SAME key ship as live one-entry diffs, no digest exchange
        // in between — the confirmed-working path (see note above).
        await stateWrite(s.H, 'syncfix', 'arcade.v1.syncfix.a', '"H-edit"');
        await stateWrite(s.J, 'syncfix', 'arcade.v1.syncfix.a', '"J-edit"');

        check('both sides converge to the same (later-HLC) value',
            await waitFor(async () => {
                const h = await lsGet(s.H, 'arcade.v1.syncfix.a');
                const j = await lsGet(s.J, 'arcade.v1.syncfix.a');
                return h !== null && h === j;
            }, 20000));

        const [hConflicts, jConflicts] = await Promise.all([
            s.H.evaluate(() => window.__syncConflicts),
            s.J.evaluate(() => window.__syncConflicts)
        ]);
        const onlyOneSideConflicted = (hConflicts.length === 1 && jConflicts.length === 0)
            || (hConflicts.length === 0 && jConflicts.length === 1);
        check('exactly one side fired onConflict (the losing side)', onlyOneSideConflicted,
            `H=${hConflicts.length} J=${jConflicts.length}`);
        const losing = hConflicts.length ? hConflicts[0] : jConflicts[0];
        if (onlyOneSideConflicted) {
            check("conflict payload names the full key", losing && losing.key === 'arcade.v1.syncfix.a',
                JSON.stringify(losing));
            const mineTheirs = new Set([losing && losing.mine, losing && losing.theirs]);
            check("conflict payload carries both edits as mine/theirs",
                mineTheirs.has('H-edit') && mineTheirs.has('J-edit'), JSON.stringify(losing));
        }
        await s.ctxH.close(); await s.ctxJ.close();
    }

    // 4b. onConflict THROUGH A DIGEST EXCHANGE (sever-then-heal) — the plan's
    // original scenario and the regression test for the pending-cursor fix
    // (see the scenario 4 note). Deterministic loser: H (never reloaded, its
    // listener survives) writes FIRST while apart; J writes later with a
    // guaranteed-larger HLC and wins — so the conflict must fire on H, via
    // the digest/req/diff reconciliation that runs on heal, evaluated
    // against H's PRE-exchange cursor.
    {
        console.log('\n  [onConflict fires through the sever-then-heal digest exchange]');
        const s = await freshPair('C2');
        const { devOnH, devOnJ } = await enableSyncBoth(s.H, s.J);
        await enableApp(s.H, 'syncfix'); await enableApp(s.J, 'syncfix');

        // Baseline: both sides hold a replicated record for the key (so the
        // later concurrent edits are edits of shared state, not first-writes).
        await stateWrite(s.H, 'syncfix', 'arcade.v1.syncfix.c', '"base"');
        check('baseline replicated before the split',
            await waitFor(async () => (await lsGet(s.J, 'arcade.v1.syncfix.c')) === '"base"'));

        const registerConflictListener = (page) => page.evaluate(() => {
            window.__syncConflicts = [];
            window.__arcade.sync.onConflict((c) => window.__syncConflicts.push(c));
        });
        await registerConflictListener(s.H);

        // Sever: reload J (same idiom as scenario 2).
        await s.J.reload();
        check('reloaded joiner booted the transport on its own (4b)', await rebootedAfterReload(s.J));
        await s.J.evaluate(FAST_RDV);
        await registerConflictListener(s.J);

        // Concurrent edits while apart: H first (older HLC, will LOSE),
        // J later (newer HLC, will win).
        await stateWrite(s.H, 'syncfix', 'arcade.v1.syncfix.c', '"H-old"');
        await new Promise((r) => setTimeout(r, 60)); // HLC millis must differ
        await stateWrite(s.J, 'syncfix', 'arcade.v1.syncfix.c', '"J-new"');

        check('joiner healed after reload (4b)', await connectedAgain(s.J));
        check('host still healed (4b)', await connectedAgain(s.H));
        await s.H.evaluate((d) => window.__arcade.sync.kick(d), devOnH);
        await s.J.evaluate((d) => window.__arcade.sync.kick(d), devOnJ);

        check('both sides converge on the newer write after the digest exchange',
            await waitFor(async () => (await lsGet(s.H, 'arcade.v1.syncfix.c')) === '"J-new"'
                && (await lsGet(s.J, 'arcade.v1.syncfix.c')) === '"J-new"', 20000));

        // The conflict must land on H (the loser) exactly once, and not on J.
        const conflictSeen = await waitFor(async () =>
            (await s.H.evaluate(() => window.__syncConflicts)).length === 1, 10000);
        const [hC, jC] = await Promise.all([
            s.H.evaluate(() => window.__syncConflicts),
            s.J.evaluate(() => window.__syncConflicts)
        ]);
        check('digest-path conflict fired exactly once on the losing side',
            conflictSeen && hC.length === 1 && jC.length === 0, `H=${hC.length} J=${jC.length}`);
        check('digest-path conflict payload carries {key, mine, theirs}',
            hC.length === 1 && hC[0].key === 'arcade.v1.syncfix.c'
                && hC[0].mine === 'H-old' && hC[0].theirs === 'J-new',
            JSON.stringify(hC[0] || null));

        await s.ctxH.close(); await s.ctxJ.close();
    }

    // 5. EXCLUDED KEYS NEVER SYNC (structural + opt-in gates), PLUS THE
    //    HOSTILE-FRAME CHECK (validateSyncEnvelope must reject a smuggled
    //    write to _meta.deviceId even from a paired, sync-enabled peer).
    {
        console.log('\n  [excluded keys never sync + hostile inbound frame is rejected]');
        const s = await freshPair('D');
        const { devOnH } = await enableSyncBoth(s.H, s.J);
        await enableApp(s.H, 'syncfix');

        // _meta.* — device-local, launcher-owned. Routed through the SAME
        // production bridge path as the rest of this scenario (gameId
        // '_meta' is the one bridgeKeyWritable exception besides
        // '_meta.dev') so this genuinely exercises noteLocalWrite's
        // syncEligibleKey rejection, not just "a raw write never reaches the
        // engine at all". Uses a synthetic sub-key (never a field the p2p/
        // pairing layer actually reads) so nothing real device state is at
        // risk if this assertion is ever wrong.
        await stateWrite(s.H, '_meta', 'arcade.v1._meta.testProbe', '"stolen"');

        // global.* — launcher-managed settings, reachable through the
        // bridge from any gameId, must never be sync-eligible.
        await stateWrite(s.H, 'syncfix', 'arcade.v1.global.theme', '"dark"');

        // SDK sidecar — syncEligibleKey rejects any second segment starting
        // with '_' (the same rule that protects _sync itself and
        // _migrated.*).
        await stateWrite(s.H, 'syncfix', 'arcade.v1.syncfix._noExport', '["x"]');

        // Eligible key SHAPE, but under an app with no opt-in _sync list at
        // all — the opt-in gate, not the structural one.
        await stateWrite(s.H, 'syncfix2', 'arcade.v1.syncfix2.untouched', '"nope"');

        // Control write: proves the pair is actually live, so the absence of
        // the above isn't just "nothing replicated at all".
        await stateWrite(s.H, 'syncfix', 'arcade.v1.syncfix.canary', '"1"');
        check('control write replicated (pair is genuinely live)',
            await waitFor(async () => (await lsGet(s.J, 'arcade.v1.syncfix.canary')) === '"1"'));

        check('_meta.* never replicated', (await lsGet(s.J, 'arcade.v1._meta.testProbe')) !== '"stolen"');
        check('global.* never replicated', (await lsGet(s.J, 'arcade.v1.global.theme')) !== '"dark"');
        check('_noExport-style sidecar never replicated', (await lsGet(s.J, 'arcade.v1.syncfix._noExport')) === null);
        check('eligible-but-unlisted key never replicated', (await lsGet(s.J, 'arcade.v1.syncfix2.untouched')) === null);

        const jRecords = await syncRecords(s.J);
        check('J has no sync record for _meta.testProbe', !('arcade.v1._meta.testProbe' in jRecords));
        check('J has no sync record for global.theme', !('arcade.v1.global.theme' in jRecords));
        check('J has no sync record for the _noExport sidecar', !('arcade.v1.syncfix._noExport' in jRecords));
        check('J has no sync record for the unlisted key', !('arcade.v1.syncfix2.untouched' in jRecords));

        // Hostile inbound frame: even a paired, sync-enabled peer must not
        // be able to smuggle a write to _meta.deviceId through the sync
        // envelope directly (bypassing the bridge/gameId gate entirely) —
        // validateSyncEnvelope's syncEligibleKey check must reject it before
        // anything touches storage.
        const priorDeviceId = await s.J.evaluate(() => localStorage.getItem('arcade.v1._meta.deviceId'));
        await s.H.evaluate((jId) => window.__arcade.p2p.sendSyncEnvelope(jId, {
            v: 1, op: 'diff', entries: [{ k: 'arcade.v1._meta.deviceId', h: '9999999999999:0000:dev-evil01', v: '"x"' }]
        }), devOnH);
        await new Promise((r) => setTimeout(r, 800)); // let the frame arrive and be rejected
        check('hostile frame targeting _meta.deviceId was rejected (deviceId unchanged)',
            (await s.J.evaluate(() => localStorage.getItem('arcade.v1._meta.deviceId'))) === priorDeviceId);

        await s.ctxH.close(); await s.ctxJ.close();
    }

    // 6. TOMBSTONE: delete replicates, and does not resurrect after reload+heal.
    {
        console.log('\n  [tombstone: delete replicates, does not resurrect after reload+heal]');
        const s = await freshPair('E');
        const { devOnH, devOnJ } = await enableSyncBoth(s.H, s.J);
        await enableApp(s.H, 'syncfix');
        await stateWrite(s.H, 'syncfix', 'arcade.v1.syncfix.doomed', '"alive"');
        check('value replicated before the delete',
            await waitFor(async () => (await lsGet(s.J, 'arcade.v1.syncfix.doomed')) === '"alive"'));

        await stateWrite(s.H, 'syncfix', 'arcade.v1.syncfix.doomed', null);
        check('delete (tombstone) replicated: key removed on J',
            await waitFor(async () => (await lsGet(s.J, 'arcade.v1.syncfix.doomed')) === null));
        const jRec = (await syncRecords(s.J))['arcade.v1.syncfix.doomed'];
        check("J's record shows del:1", !!jRec && jRec.del === 1, JSON.stringify(jRec));

        // Reload J, heal, and force a fresh exchange: the tombstone must not
        // resurrect (a key with NO stored value is simply never visited by
        // ensureLoaded's "stamp missing/changed" scan, which only walks
        // keys still present in localStorage — this proves that in practice,
        // not just by code inspection).
        await s.J.reload();
        check('reloaded joiner booted the transport on its own', await rebootedAfterReload(s.J));
        await s.J.evaluate(FAST_RDV);
        check('joiner healed after reload', await connectedAgain(s.J));
        check('host still healed', await connectedAgain(s.H));
        await s.H.evaluate((d) => window.__arcade.sync.kick(d), devOnH);
        await s.J.evaluate((d) => window.__arcade.sync.kick(d), devOnJ);
        await new Promise((r) => setTimeout(r, 800));
        check('delete survived the reload (no resurrection)',
            (await lsGet(s.J, 'arcade.v1.syncfix.doomed')) === null);
        check('delete survived on the host too', (await lsGet(s.H, 'arcade.v1.syncfix.doomed')) === null);

        await s.ctxH.close(); await s.ctxJ.close();
    }

    // 7. THE 'arcade-sync' IDB EXISTS ON A DEVICE THAT SYNCED, AND IS ABSENT
    //    FROM A SAVE EXPORT (structural exclusion is unit-tested in
    //    sync-unit's STORE_DB_RE assertion; this proves the browser-visible
    //    half end-to-end since export-roundtrip-acceptance.mjs's #btn-save
    //    click + download-capture pattern is cheap to reuse here).
    {
        console.log("\n  ['arcade-sync' IDB exists after syncing; never appears in a save export]");
        const s = await freshPair('F');
        await enableSyncBoth(s.H, s.J);
        await enableApp(s.H, 'syncfix');
        await stateWrite(s.H, 'syncfix', 'arcade.v1.syncfix.a', '"1"');
        check('write replicated (device genuinely synced)',
            await waitFor(async () => (await lsGet(s.J, 'arcade.v1.syncfix.a')) === '"1"'));

        const dbNames = await s.H.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
        check("'arcade-sync' IDB exists on a device that synced", dbNames.includes('arcade-sync'), dbNames.join(','));

        const [dl] = await Promise.all([
            s.H.waitForEvent('download'),
            s.H.evaluate(() => document.getElementById('btn-save').click())
        ]);
        const bundle = JSON.parse(await readFile(await dl.path(), 'utf8'));
        const bundleStr = JSON.stringify(bundle);
        check("save export never mentions the 'arcade-sync' IDB (structural exclusion, STORE_DB_RE)",
            !/arcade-sync/.test(bundleStr), Object.keys(bundle.stores || {}).join(','));
        check('…while still including the actual synced app key (export is not just empty)',
            !!bundle.data && !!bundle.data['arcade.v1.syncfix.a']);

        await s.ctxH.close(); await s.ctxJ.close();
    }

    // 8. RESTORE-RESURRECTION (durability design §5, PR 7). The hole: a
    //    bundle taken AFTER a deletion carries no trace of it, so restoring
    //    onto a fresh device and then syncing with a peer that was offline
    //    for the deletion pulls the deleted key back as brand-new. With the
    //    journal section: delete on B while A is offline → B's export
    //    carries the tombstone → fresh C restores it and adopts the
    //    tombstone at its ORIGINAL HLC → pairing C with A must NOT
    //    resurrect the key on C; instead C's newer tombstone wins LWW and
    //    the deletion finally reaches A.
    {
        console.log('\n  [restore-resurrection: a restored bundle journal defends deletions]');
        const s = await freshPair('G');
        await enableSyncBoth(s.H, s.J);
        await enableApp(s.H, 'syncfix'); await enableApp(s.J, 'syncfix');
        await stateWrite(s.H, 'syncfix', 'arcade.v1.syncfix.doomed', '"live"');
        check('key replicated A -> B before the split',
            await waitFor(async () => (await lsGet(s.J, 'arcade.v1.syncfix.doomed')) === '"live"'));

        // A goes offline still holding the key live; B deletes it unheard.
        await s.H.close();
        await stateWrite(s.J, 'syncfix', 'arcade.v1.syncfix.doomed', null);
        check('B holds a tombstone after the offline delete',
            await waitFor(async () => {
                const r = (await syncRecords(s.J))['arcade.v1.syncfix.doomed'];
                return !!r && r.del === 1;
            }));

        // B's save export — the bundle's journal must carry the tombstone.
        const [dl] = await Promise.all([
            s.J.waitForEvent('download'),
            s.J.evaluate(() => document.getElementById('btn-save').click())
        ]);
        const bundleJson = await readFile(await dl.path(), 'utf8');
        const bBundle = JSON.parse(bundleJson);
        const bTomb = bBundle.journal && bBundle.journal.records
            && bBundle.journal.records['arcade.v1.syncfix.doomed'];
        check("B's bundle journal carries the deletion as a tombstone", !!bTomb && bTomb.del === 1,
            JSON.stringify(bBundle.journal && Object.keys(bBundle.journal.records || {})));
        await s.ctxJ.close(); // B's job is done — it must never heal A itself

        // Fresh C restores B's bundle BEFORE meeting any peer.
        const ctxC = await harness.newDeviceContext();
        const C = await launcherPage('G:fresh', ctxC);
        await loadBridge(C);
        await C.evaluate(() => { window.confirm = () => true; });
        const imported = await C.evaluate((json) =>
            window.__arcade.save.importBundleJson(json, 'test restore'), bundleJson);
        check('fresh C committed the restore', imported === true);
        check('C adopted the tombstone at its ORIGINAL HLC into the sync class (never re-stamped)',
            await waitFor(async () => {
                const r = (await syncRecords(C))['arcade.v1.syncfix.doomed'];
                return !!r && r.del === 1 && r.h === bTomb.h;
            }));

        // A comes back on its preserved storage, still holding the key live,
        // and pairs with C.
        const A2 = await launcherPage('G:hostback', s.ctxH);
        await loadBridge(A2);
        check('A still holds the key live (it never observed the deletion)',
            (await lsGet(A2, 'arcade.v1.syncfix.doomed')) === '"live"');
        // waitHost false: A2 may still be futilely auto-reconnecting to the
        // closed B, so its AGGREGATE status is not what this ceremony proves.
        await ceremony(A2, C, { waitHost: false });
        const cId = await C.evaluate(() => localStorage.getItem('arcade.v1._meta.deviceId'));
        const aId = await A2.evaluate(() => localStorage.getItem('arcade.v1._meta.deviceId'));
        check('identity handshake upserted the new pair on both sides',
            await waitFor(async () => {
                const onA = await A2.evaluate(() => localStorage.getItem('arcade.v1._meta.knownPeers'));
                const onC = await C.evaluate(() => localStorage.getItem('arcade.v1._meta.knownPeers'));
                return !!onA && !!onC && JSON.parse(onA)[cId] && JSON.parse(onC)[aId];
            }));
        const enableSyncFor = (page, peerId) => page.evaluate(async (id) => {
            const { setKnownPeerSyncEnabled } = await import('./arcade-known-peers.js');
            setKnownPeerSyncEnabled(id, true);
            window.__arcade.sync.kick(id);
        }, peerId);
        await enableSyncFor(A2, cId);
        await enableSyncFor(C, aId);

        // The strong assertion: C's adopted tombstone WINS — the deletion
        // reaches A instead of A's stale live copy reaching C.
        check('the deletion propagated to A (no resurrection anywhere)',
            await waitFor(async () => (await lsGet(A2, 'arcade.v1.syncfix.doomed')) === null, 25000));
        check('C never resurrected the deleted key',
            (await lsGet(C, 'arcade.v1.syncfix.doomed')) === null);
        check("C's record is still the ORIGINAL-HLC tombstone after the exchange",
            await waitFor(async () => {
                const r = (await syncRecords(C))['arcade.v1.syncfix.doomed'];
                return !!r && r.del === 1;
            }));

        await s.ctxH.close(); await ctxC.close();
    }
} catch (e) {
    console.error('\nFATAL:', e.message);
    check('run completed', false, e.message);
} finally {
    await harness.shutdown();
}

console.log(failed() === 0 ? '\nAll sync acceptance checks passed.' : `\n${failed()} check(s) FAILED.`);
process.exit(failed() === 0 ? 0 : 1);
