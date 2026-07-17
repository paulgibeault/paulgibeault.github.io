#!/usr/bin/env node
//
// tools/p2p-crosssign-acceptance.mjs — end-to-end checks for the user-
// identity layer (#32) over REAL P2P links: four browser contexts stand in
// for four of one user's devices (same recovery code imported everywhere).
// The transport is star-topology (one host per session), so the scenario
// runs as consecutive sessions rather than a mesh:
//
//   session 1 (C hosts A+B+D): every ceremony pins C's userPub — but only
//     because a VALID device cert covered the live fingerprint,
//   session 2 (A hosts B): A revokes the now-dead C → local latch + direct
//     push latches it on B, and a revoked device can't be re-trusted,
//   session 2b (D joins A): D was offline for the push and learns the
//     revocation from the identity frame's gossip instead,
//   session 3 (fresh-session B rejoins A): a corrupted (stale) pin heals
//     silently when the live fingerprint arrives re-attested by the pinned
//     userPub under a NEWER cert — no pending pin, no suspect state.
//
//   node tools/p2p-crosssign-acceptance.mjs
//
// Exit code: 0 if all checks pass, 1 otherwise.

import { startP2PHarness, makeCheck, waitFor } from './lib/p2p-test-harness.mjs';

const { check, failed } = makeCheck();
const H = await startP2PHarness({ port: 4803, dropPort: 4804 });

const readPeers = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('arcade.v1._meta.knownPeers') || '{}'));
const myPub = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('arcade.v1._meta.userIdentity') || 'null')?.userPub || null);

try {
    // ── four devices, one user ──
    const ctxA = await H.newDeviceContext();
    const ctxB = await H.newDeviceContext();
    const ctxC = await H.newDeviceContext();
    const ctxD = await H.newDeviceContext();
    const A = await H.launcherPage('A', ctxA);
    const B = await H.launcherPage('B', ctxB);
    const C = await H.launcherPage('C', ctxC);
    const D = await H.launcherPage('D', ctxD);

    const code = await A.evaluate(async () => {
        const m = await import('./arcade-user-identity.js');
        await m.ensureUserIdentity();
        return m.exportRecoveryCode();
    });
    check('device A minted a user identity', typeof code === 'string' && code.length > 0);
    for (const [label, page] of [['B', B], ['C', C], ['D', D]]) {
        const ok = await page.evaluate(async (c) => {
            const m = await import('./arcade-user-identity.js');
            return (await m.importRecoveryCode(c)).ok;
        }, code);
        check(`device ${label} restored the same identity from the code`, ok === true);
    }
    const pubA = await myPub(A);
    check('all four devices share one userPub', pubA
        && pubA === await myPub(B) && pubA === await myPub(C) && pubA === await myPub(D));

    // The bridge mints deviceId lazily at first announce — seed it now so
    // the suite can key its assertions before any ceremony has run.
    for (const page of [A, B, C, D]) {
        await page.evaluate(() => {
            if (!localStorage.getItem('arcade.v1._meta.deviceId')) {
                localStorage.setItem('arcade.v1._meta.deviceId', crypto.randomUUID());
            }
        });
        await H.bootBridge(page, { closeDialog: true });
    }
    const [devA, devB, devC, devD] = await Promise.all([A, B, C, D].map((p) => H.deviceIdOf(p)));

    // ── session 1: C hosts A, B, D — ceremonies pin userPub via the cert ──
    await H.ceremony(C, A);
    await H.ceremony(C, B, { waitHost: false });
    await H.ceremony(C, D, { waitHost: false });
    check('A pinned C\'s userPub after the ceremony', await waitFor(async () =>
        (await readPeers(A))[devC]?.userPub === pubA));
    check('B pinned C\'s userPub after the ceremony', await waitFor(async () =>
        (await readPeers(B))[devC]?.userPub === pubA));
    check('D pinned C\'s userPub after the ceremony', await waitFor(async () =>
        (await readPeers(D))[devC]?.userPub === pubA));
    check('C pinned its joiners\' userPubs too (symmetric)', await waitFor(async () => {
        const peers = await readPeers(C);
        return peers[devA]?.userPub === pubA && peers[devB]?.userPub === pubA && peers[devD]?.userPub === pubA;
    }));
    const certIssuedAt = (await readPeers(A))[devC]?.deviceCertIssuedAt;
    check('the pin recorded the cert\'s issuedAt', typeof certIssuedAt === 'number' && certIssuedAt > 0);

    // ── session 2: the "phone C is lost" timeline ──
    // C dies; the ex-joiners clear their dead session (Start Over — the
    // real recover-a-dead-link path) so one of them can host the next one.
    await C.close();
    for (const page of [A, B, D]) {
        await page.evaluate((id) => window.__arcade.p2p.startOverKnownPeer(id), devC);
    }
    await H.ceremony(A, B);
    check('A sees B\'s userPub after their direct ceremony', await waitFor(async () =>
        (await readPeers(A))[devB]?.userPub === pubA));

    const revoked = await A.evaluate((id) => window.__arcade.p2p.revokeDevice(id), devC);
    check('revokeDevice succeeds on A (C is provably ours)', revoked === true);
    check('A latched the revocation', await waitFor(async () => {
        const rec = (await readPeers(A))[devC];
        return !!rec?.revoked && rec.autoReconnect === false;
    }));
    check('B latched the revocation from the direct push', await waitFor(async () => {
        const rec = (await readPeers(B))[devC];
        return !!rec?.revoked && rec.autoReconnect === false;
    }));
    const reEnable = await A.evaluate((id) => window.__arcade.p2p.enableAutoReconnect(id), devC);
    check('a revoked device cannot be re-trusted via enableAutoReconnect', reEnable === false);

    // ── session 2b: D missed the push — gossip catches it up ──
    // D joins A's live session; A's identity frame carries the revocation.
    await H.ceremony(A, D, { waitHost: false });
    check('D learned the revocation from identity-frame gossip', await waitFor(async () => {
        const rec = (await readPeers(D))[devC];
        return !!rec?.revoked && rec.autoReconnect === false;
    }));

    // ── session 3: verified rotation auto-promotes the pin silently ──
    // Simulate "B's fingerprint changed since A last saw it" by corrupting
    // A's stored pin for B, then re-running the ceremony from a FRESH B
    // session (a new session signs a new cert, so issuedAt advances — the
    // monotonic gate requires strictly newer). The live (real) fingerprint
    // arrives re-attested by the pinned userPub → pin heals with no pending
    // fingerprint, no suspect state, no warning path.
    const staleFp = 'AA:' + Array(31).fill('00').join(':');
    await A.evaluate(([id, fp]) => {
        const peers = JSON.parse(localStorage.getItem('arcade.v1._meta.knownPeers'));
        peers[id].fingerprint = fp;
        localStorage.setItem('arcade.v1._meta.knownPeers', JSON.stringify(peers));
    }, [devB, staleFp]);
    await B.close();
    const B2 = await H.launcherPage('B2', ctxB);
    await H.bootBridge(B2, { closeDialog: true });
    await H.ceremony(A, B2, { waitHost: false });
    check('the stale pin was auto-promoted to the live fingerprint', await waitFor(async () => {
        const rec = (await readPeers(A))[devB];
        return rec && rec.fingerprint !== staleFp && !rec.pinPendingFingerprint && !rec.fingerprintChangedAt;
    }));
    check('the promoted cert issuedAt advanced (monotonic gate)', await waitFor(async () => {
        const rec = (await readPeers(A))[devB];
        return typeof rec?.deviceCertIssuedAt === 'number' && rec.deviceCertIssuedAt > certIssuedAt;
    }));
    check('B is NOT fingerprint-suspect on A after the promotion',
        (await A.evaluate((id) => window.__arcade.p2p.isFingerprintSuspect(id), devB)) === false);
} catch (e) {
    check('suite completed without an exception', false, e.message);
} finally {
    await H.shutdown();
}

console.log('');
if (failed()) { console.log(`${failed()} check(s) FAILED.`); process.exit(1); }
console.log('All cross-sign acceptance checks passed.');
