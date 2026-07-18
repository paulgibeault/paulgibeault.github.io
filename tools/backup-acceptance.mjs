#!/usr/bin/env node
//
// tools/backup-acceptance.mjs — end-to-end proof of backup-to-trusted-peer
// (#31): two real launcher pages, paired over real WebRTC, move a full save
// bundle through the PRODUCTION path — arcade-save.js exportBundleString ->
// kind:'backup' offer/accept/chunk/ack over arcade-p2p.js's
// onBackupEnvelope/sendBackupEnvelope -> arcade-backup.js generations in the
// 'arcade-backup' IndexedDB -> restoreLatest through the SAME import gates a
// save-file load uses (confirm, auto-backup download, commit).
//
//   node tools/backup-acceptance.mjs
//
// Self-contained like the other p2p suites: local static server, local ICE,
// injected loopback dead-drop (no external broker touched). Ports 4786
// (http) / 4787 (drop server) — kept distinct from sync's 4792/4793 and the
// other p2p suites' 4794-4799 (+4791 dev.sh) range.
//
// Exit code: 0 if all checks pass, 1 otherwise.

import { startP2PHarness, makeCheck, waitFor } from './lib/p2p-test-harness.mjs';

const { check, failed } = makeCheck();
const harness = await startP2PHarness({ port: 4786, dropPort: 4787 });
const { launcherPage, ceremony } = harness;

async function loadBridge(page) {
    await harness.bootBridge(page, { closeDialog: true });
}

// A live ceremony is all backup needs (no reconnect scenarios here) — but
// the flag mutators require the identity handshake to have upserted
// knownPeers on both sides first.
async function freshPair(tag) {
    const ctxH = await harness.newDeviceContext();
    const ctxJ = await harness.newDeviceContext();
    const H = await launcherPage(tag + ':host', ctxH);
    const J = await launcherPage(tag + ':joiner', ctxJ);
    await loadBridge(H); await loadBridge(J);
    await ceremony(H, J);
    for (const page of [H, J]) {
        await page.waitForFunction(`(() => {
            const raw = localStorage.getItem('arcade.v1._meta.knownPeers');
            return raw && Object.keys(JSON.parse(raw)).length > 0;
        })()`, null, { timeout: 10000 });
    }
    return { ctxH, ctxJ, H, J };
}

// Per-pair opt-in, set directly (the UI toggle calls the same mutator).
// Returns the peer's deviceId as this page's knownPeers records it.
const setBackupFlag = (page, on) => page.evaluate(async (on) => {
    const { setKnownPeerBackupTarget, readKnownPeers } = await import('./arcade-known-peers.js');
    const id = Object.keys(readKnownPeers())[0];
    setKnownPeerBackupTarget(id, on);
    return id;
}, on);

const kick = (page, dev) => page.evaluate((d) => window.__arcade.backup.kick(d), dev);
const gens = (page, dev) => page.evaluate((d) => window.__arcade.backup.listGenerations(d), dev);
const acked = (page, dev) => page.evaluate((d) => window.__arcade.backup._acked(d), dev);
const lsGet = (page, key) => page.evaluate((k) => localStorage.getItem(k), key);

// Drives a write through the production bridge path, exactly like a real
// game's Arcade.state.set (borrowed from sync-acceptance.mjs).
const stateWrite = (page, gameId, key, value) => page.evaluate(({ gameId, key, value }) =>
    window.__arcade.storage.stateWrite(gameId, { key, value }), { gameId, key, value });

try {
    console.log('\nBackup acceptance — two-launcher bundle replication, consent, restore, retention\n');

    // 1 + 2. MUTUAL FLAGS REPLICATE A MULTI-CHUNK BUNDLE ON KICK; RESTORE
    //        COMMITS IT THROUGH THE FULL IMPORT PIPELINE.
    {
        console.log('  [mutual flags replicate a multi-chunk bundle; restore commits it]');
        const s = await freshPair('A');
        // Big enough that the serialized bundle MUST split into several
        // chunk frames (BACKUP_CHUNK_CHARS = 64 KB) — proves reassembly,
        // not just a single-frame happy path.
        const bigValue = '"' + 'x'.repeat(200000) + '"';
        await stateWrite(s.H, 'backfix', 'arcade.v1.backfix.hello', '"world"');
        await stateWrite(s.H, 'backfix', 'arcade.v1.backfix.big', bigValue);

        const devOnH = await setBackupFlag(s.H, true);  // J's id as H knows it
        const devOnJ = await setBackupFlag(s.J, true);  // H's id as J knows it
        await kick(s.H, devOnH);

        check('receiver stored one generation from the sender',
            await waitFor(async () => (await gens(s.J, devOnJ)).length === 1, 20000));
        const gen = (await gens(s.J, devOnJ))[0];
        check('generation meta is complete (checksum + chars + receivedAt)',
            !!gen && /^sha256:[0-9a-f]{64}$/.test(gen.checksum) && gen.chars > 200000 && gen.receivedAt > 0,
            JSON.stringify(gen));
        check("sender's acked checksum matches the stored generation",
            await waitFor(async () => (await acked(s.H, devOnH)) === gen.checksum));

        // Restore on J: native confirm (gate 7) + auto-backup download
        // (gate 8) both fire — accept the dialog, absorb the download.
        s.J.on('dialog', (d) => d.accept());
        const [restored] = await Promise.all([
            s.J.evaluate((d) => window.__arcade.backup.restoreLatest(d), devOnJ),
            s.J.waitForEvent('download').catch(() => null)
        ]);
        check('restoreLatest reported a committed import', restored === true);
        check("sender's key landed on the receiver",
            (await lsGet(s.J, 'arcade.v1.backfix.hello')) === '"world"');
        check("sender's multi-chunk value landed intact",
            (await lsGet(s.J, 'arcade.v1.backfix.big')) === bigValue);
        check("receiver's own device identity survived the restore (IMPORT_PROTECTED_KEYS)",
            await s.J.evaluate(() => localStorage.getItem('arcade.v1._meta.deviceId')
                !== null) && (await s.J.evaluate(() => localStorage.getItem('arcade.v1._meta.deviceId')))
                !== (await s.H.evaluate(() => localStorage.getItem('arcade.v1._meta.deviceId'))));

        await s.ctxH.close(); await s.ctxJ.close();
    }

    // 3. RECONNECT-CHURN DEDUPE + GENERATION RETENTION CAP.
    {
        console.log('\n  [unchanged state never re-stores; retention keeps the newest 3]');
        const s = await freshPair('B');
        await stateWrite(s.H, 'backfix', 'arcade.v1.backfix.v', '"1"');
        const devOnH = await setBackupFlag(s.H, true);
        const devOnJ = await setBackupFlag(s.J, true);

        await kick(s.H, devOnH);
        check('first generation stored',
            await waitFor(async () => (await gens(s.J, devOnJ)).length === 1, 20000));

        // Same state, kick again (bypasses the offer-dedupe window): the
        // acked checksum must short-circuit before any bundle bytes move.
        await kick(s.H, devOnH);
        await new Promise((r) => setTimeout(r, 1500));
        check('unchanged state did not burn a second generation',
            (await gens(s.J, devOnJ)).length === 1);

        // Three more distinct states → the cap (3) holds and the OLDEST
        // falls off: the very first checksum must be gone at the end.
        const first = (await gens(s.J, devOnJ))[0].checksum;
        for (let i = 2; i <= 4; i++) {
            await stateWrite(s.H, 'backfix', 'arcade.v1.backfix.v', `"${i}"`);
            const prevNewest = (await gens(s.J, devOnJ))[0].checksum;
            await kick(s.H, devOnH);
            check(`generation for state ${i} arrived`,
                await waitFor(async () => {
                    const g = await gens(s.J, devOnJ);
                    return g.length && g[0].checksum !== prevNewest;
                }, 20000));
        }
        const finalGens = await gens(s.J, devOnJ);
        check('retention cap held at 3 generations', finalGens.length === 3,
            `got ${finalGens.length}`);
        check('the oldest generation was pruned',
            finalGens.every((g) => g.checksum !== first));
        check('generations are newest-first and distinct',
            new Set(finalGens.map((g) => g.checksum)).size === 3
            && finalGens[0].receivedAt >= finalGens[2].receivedAt);

        await s.ctxH.close(); await s.ctxJ.close();
    }

    // 4. CONSENT PATH: an offer to a device that was never asked prompts,
    //    a yes stores AND turns on the symmetric return offer.
    {
        console.log('\n  [consent prompt on first offer; yes enables both directions]');
        const s = await freshPair('C');
        await stateWrite(s.H, 'backfix', 'arcade.v1.backfix.c', '"consent"');
        // J needs its own app data too: a device holding only protected meta
        // keys has nothing importable and deliberately never offers (see
        // exportBundleString) — the symmetric-return check below needs a
        // bundle worth sending.
        await stateWrite(s.J, 'backfix', 'arcade.v1.backfix.mine', '"J-data"');
        // Stub the launcher dialog on J: record the prompt, answer yes. The
        // engine's host hook reads window.__arcade.dialog at call time, so a
        // page-side stub intercepts the real production path.
        await s.J.evaluate(() => {
            window.__consentPrompts = [];
            window.__arcade.dialog = async (opts) => { window.__consentPrompts.push(opts.message); return true; };
        });
        const devOnH = await setBackupFlag(s.H, true); // sender opted in; receiver never asked
        await kick(s.H, devOnH);

        check('receiver stored the generation after consenting',
            await waitFor(async () => {
                const dev = await s.J.evaluate(async () => {
                    const { readKnownPeers } = await import('./arcade-known-peers.js');
                    return Object.keys(readKnownPeers())[0];
                });
                return (await gens(s.J, dev)).length === 1;
            }, 20000));
        check('exactly one consent prompt fired',
            (await s.J.evaluate(() => window.__consentPrompts)).length === 1);
        check("consent set the receiver's own backupTarget flag",
            await s.J.evaluate(async () => {
                const { readKnownPeers } = await import('./arcade-known-peers.js');
                const known = readKnownPeers();
                return known[Object.keys(known)[0]].backupTarget === true;
            }));
        // Symmetric: J's yes fires a return offer, H (flag already true)
        // accepts and stores J's bundle.
        check("the symmetric return offer stored the receiver's bundle on the sender",
            await waitFor(async () => (await gens(s.H, devOnH)).length === 1, 20000));

        await s.ctxH.close(); await s.ctxJ.close();
    }

    // 5. AN EXPLICIT 'NO' IS REMEMBERED, AND HOSTILE FRAMES DIE AT THE
    //    VALIDATOR — no generation, no prompt, no crash.
    {
        console.log('\n  [declined flag blocks silently; hostile frames are rejected]');
        const s = await freshPair('D');
        await stateWrite(s.H, 'backfix', 'arcade.v1.backfix.d', '"blocked"');
        await s.J.evaluate(() => {
            window.__consentPrompts = [];
            window.__arcade.dialog = async (opts) => { window.__consentPrompts.push(opts.message); return true; };
        });
        const devOnH = await setBackupFlag(s.H, true);
        const devOnJ = await setBackupFlag(s.J, false); // explicit prior decline
        await kick(s.H, devOnH);
        await new Promise((r) => setTimeout(r, 2000));
        check('no generation stored on the declined side', (await gens(s.J, devOnJ)).length === 0);
        check('no consent prompt re-fired for a remembered decline',
            (await s.J.evaluate(() => window.__consentPrompts)).length === 0);

        // Hostile frames straight through the production send path: a chunk
        // for a transfer that was never offered/accepted, and an offer whose
        // parts count fails validateBackupEnvelope's structural cap.
        await s.H.evaluate((d) => {
            window.__arcade.p2p.sendBackupEnvelope(d, { v: 1, op: 'chunk', id: 'ghost', seq: 0, parts: 1, body: '{"boo":1}' });
            window.__arcade.p2p.sendBackupEnvelope(d, {
                v: 1, op: 'offer', id: 'huge', checksum: 'sha256:' + 'a'.repeat(64),
                chars: 5, parts: 99999, exportedAt: 'now'
            });
        }, devOnH);
        await new Promise((r) => setTimeout(r, 1500));
        check('hostile frames left no generation behind', (await gens(s.J, devOnJ)).length === 0);
        check('receiver page is still healthy after hostile frames',
            await s.J.evaluate(() => !!window.__arcade.backup && !!window.__arcade.p2p));

        await s.ctxH.close(); await s.ctxJ.close();
    }

    // 6. DELTA TRANSFERS (durability design §6, PR 8): after a full backup
    //    is acked, the next changed-state offer names deltaFrom, the
    //    receiver answers accept-delta, and only a small delta document
    //    crosses the wire — while the STORED generation is the materialized
    //    FULL bundle (a delta is a transfer optimization, never a storage
    //    format). Then the fallback: a receiver whose stored base is
    //    unreadable answers the delta with a plain 'accept' — the same wire
    //    outcome as an old receiver that ignores deltaFrom — and the sender
    //    delivers the full bundle under the same transfer id.
    {
        console.log('\n  [delta transfer round trip; unreadable base falls back to full]');
        const s = await freshPair('E');
        const bigValue = '"' + 'y'.repeat(200000) + '"';
        await stateWrite(s.H, 'backfix', 'arcade.v1.backfix.big', bigValue);
        const devOnH = await setBackupFlag(s.H, true);
        const devOnJ = await setBackupFlag(s.J, true);
        await kick(s.H, devOnH);
        check('baseline full generation stored and acked',
            await waitFor(async () => (await gens(s.J, devOnJ)).length === 1
                && (await acked(s.H, devOnH)) === (await gens(s.J, devOnJ))[0].checksum, 20000));

        // Small change → the transfer must go as a delta.
        await stateWrite(s.H, 'backfix', 'arcade.v1.backfix.small', '"d1"');
        await kick(s.H, devOnH);
        check('changed state stored a second generation',
            await waitFor(async () => (await gens(s.J, devOnJ)).length === 2, 20000));
        const newest = (await gens(s.J, devOnJ))[0];
        check('the stored generation is the materialized FULL bundle, not the delta document',
            newest.chars > 200000, JSON.stringify(newest));
        check('sender diag shows the transfer went as a delta (small vs full)',
            await s.H.evaluate(() => window.__arcadeDiag.entries().some((e) =>
                e.tag === 'backup' && /^delta transfer to /.test(e.msg))));
        check('receiver diag shows the delta materialized against the stored base',
            await s.J.evaluate(() => window.__arcadeDiag.entries().some((e) =>
                e.tag === 'backup' && /^delta from .* materialized/.test(e.msg))));
        check("sender's acked checksum advanced to the materialized bundle",
            await waitFor(async () => (await acked(s.H, devOnH)) === newest.checksum));

        // Restore the delta-built generation through the full import
        // pipeline: both the untouched big key and the delta'd key must land.
        s.J.on('dialog', (d) => d.accept());
        const [restored] = await Promise.all([
            s.J.evaluate((d) => window.__arcade.backup.restoreLatest(d), devOnJ),
            s.J.waitForEvent('download').catch(() => null)
        ]);
        check('restoring the materialized generation commits', restored === true);
        check('the delta-transferred key landed', (await lsGet(s.J, 'arcade.v1.backfix.small')) === '"d1"');
        check('the base-carried key landed intact', (await lsGet(s.J, 'arcade.v1.backfix.big')) === bigValue);

        // FORCED FALLBACK: destroy the receiver's stored bundle strings
        // ('g|' rows) while its in-RAM index still lists them — the next
        // delta materialization finds base-unreadable and re-requests the
        // full transfer under the same id (§6 failure ⇒ drop delta,
        // request full).
        await s.J.evaluate(() => new Promise((resolve, reject) => {
            const rq = indexedDB.open('arcade-backup', 1);
            rq.onsuccess = () => {
                const db = rq.result;
                const tx = db.transaction('kv', 'readwrite');
                const store = tx.objectStore('kv');
                const getKeys = store.getAllKeys();
                getKeys.onsuccess = () => {
                    for (const k of getKeys.result) {
                        if (typeof k === 'string' && k.startsWith('g|')) store.delete(k);
                    }
                };
                tx.oncomplete = () => { db.close(); resolve(); };
                tx.onerror = () => reject(tx.error);
            };
            rq.onerror = () => reject(rq.error);
        }));
        await stateWrite(s.H, 'backfix', 'arcade.v1.backfix.small', '"d2"');
        await kick(s.H, devOnH);
        check('the fallback still produced a stored generation (full transfer under the same id)',
            await waitFor(async () => {
                const list = await gens(s.J, devOnJ);
                return list.length === 3 && (await acked(s.H, devOnH)) === list[0].checksum;
            }, 25000));
        check('receiver diag shows the delta was dropped and full re-requested',
            await s.J.evaluate(() => window.__arcadeDiag.entries().some((e) =>
                e.tag === 'backup' && /unusable \(base-unreadable\) — requesting full transfer/.test(e.msg))));
        check('the full-fallback generation is full-sized',
            (await gens(s.J, devOnJ))[0].chars > 200000);

        await s.ctxH.close(); await s.ctxJ.close();
    }
} catch (e) {
    console.error('\nFATAL:', e.message);
    check('run completed', false, e.message);
} finally {
    await harness.shutdown();
}

console.log(failed() === 0 ? '\nAll backup acceptance checks passed.' : `\n${failed()} check(s) FAILED.`);
process.exit(failed() === 0 ? 0 : 1);
