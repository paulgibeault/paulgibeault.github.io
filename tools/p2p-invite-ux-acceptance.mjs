#!/usr/bin/env node
//
// tools/p2p-invite-ux-acceptance.mjs — the launcher's INVITE DOORS, driven
// through the buttons a person actually taps (plans/tables-2026-08.md WP4).
//
// The sibling suite (p2p-multiparty-acceptance) proves the SCOPE MODEL, and it
// deliberately opens its scopes by calling the bridge: inviteGame /
// acceptGameInvite, no UI involved. That leaves exactly one thing unproven, and
// it is the thing the whole redesign ships on — that a person can get from two
// paired phones to a shared game without a console. WP2 shipped scopes with no
// door: the only proposer in the product was a game calling
// Arcade.peer.invite(), so a game that had not adopted the cap could not be
// started at all. This suite is the proof that the doors exist and connect.
//
// Everything here goes through real DOM: the topbar's invite button, the
// launcher's own confirm dialog, the connection row's knock. Nothing calls the
// bridge to make the thing under test happen — bridge reads are used only to
// ASSERT what the UI caused.
//
// Proven here:
//   U1  the door with nobody to ask offers the pairing ceremony, and the offer
//       actually opens it (a dead button is the failure this replaces)
//   U2  host taps Invite → guest is asked, by name, for a named game →
//       accepting MOUNTS the game and focuses it → onReady cascades → frames
//       flow both ways. The end-to-end path WP4 exists to create.
//   U3  declining is silent: no scope, no mount, and nothing at all on the
//       inviter's screen
//   U4  the knock (D4's other half): a connection row offers the running game
//       to that one device, and offers nothing when that device is already
//       playing it
//   U5  D2's dead end, in copy: a device that isn't linked to the one already
//       playing gets "ask ⟨them⟩ to connect with ⟨device⟩" rather than a
//       silent nowhere-seat
//
// THE DIALOG TRAP, and why every click below names its dialog. The launcher has
// ONE confirm element with a serialized queue behind it (index.html's
// arcadeDialogChain), and a fresh ceremony puts two questions in that queue on
// BOTH devices — "Name this connection:" and the auto-reconnect opt-in. A test
// that clicks OK because *a* dialog is showing answers whichever question
// arrived first, and then passes or fails for reasons that have nothing to do
// with invites. answerDialog() therefore asserts the message text before it
// clicks and throws on anything else, so a queue that changes shape fails
// loudly instead of quietly answering the wrong question.
//
//   node tools/p2p-invite-ux-acceptance.mjs
//
// Self-contained like the other p2p suites: own static server (:4809), own
// dead-drop (:4810), local ICE only, local Google Chrome.
//
// Exit code: 0 if all checks pass, 1 otherwise.

import { startP2PHarness, makeCheck, waitFor } from './lib/p2p-test-harness.mjs';

const { check, failed } = makeCheck();
const harness = await startP2PHarness({ port: 4809, dropPort: 4810 });
const { launcherPage, deviceIdOf, ceremony, fixtureFrame } = harness;

// Two ids served by one fixture — what makes them different games is only
// their id, which is also all an invite carries.
const GAME = 'p2p-test-game';
const GAME_NAME = 'Peer Test';
const GAME2 = 'p2p-test-game-2';
const GAME2_NAME = 'Peer Test Two';
// One fixture, two URLs. The query string is inert to the server and exists so
// each game's FRAME is findable by a substring the other's url cannot contain:
// the paths are otherwise identical, and this suite deliberately evicts one
// game while looking up the other — a needle that matched both would find a
// frame in its 250ms retire grace and assert against a corpse.
const FIXTURE_ONE = '/tools/fixtures/p2p-test-game/index.html?one';
const FIXTURE_TWO = '/tools/fixtures/p2p-test-game/index.html?two';

// Device names are asserted verbatim in prompt copy ("⟨name⟩ wants to play
// ⟨game⟩"), so they are set rather than defaulted — and chosen with no
// substring overlap, so a check that matches one can't be satisfied by another.
const NAMES = { H: 'Attic Phone', G: 'Kitchen Phone', C: 'Porch Tablet' };

const contexts = {};
for (const label of ['H', 'G', 'C']) {
    contexts[label] = await harness.newDeviceContext();
    await contexts[label].addInitScript(
        `try { localStorage.setItem('arcade.v1._meta.deviceName', ${JSON.stringify(NAMES[label])}); } catch (e) {}`);
}

// ---- dialog helpers (see THE DIALOG TRAP above) ----------------------------

function visibleDialog(page) {
    return page.evaluate(() => {
        const el = document.getElementById('arcade-dialog');
        if (!el || el.classList.contains('hidden')) return null;
        return document.getElementById('arcade-dialog-msg').textContent;
    });
}

/**
 * Answer the confirm that is showing — and refuse to answer a different one.
 * `which` is 'ok' or 'cancel'. Returns the text it answered, so a caller can
 * assert the exact copy on top of the substring this matched.
 */
async function answerDialog(page, expect, which = 'ok') {
    const appeared = await waitFor(async () => (await visibleDialog(page)) !== null, 20000);
    if (!appeared) throw new Error(`no dialog appeared; expected one containing ${JSON.stringify(expect)}`);
    const text = await visibleDialog(page);
    if (!text.includes(expect)) {
        throw new Error(`wrong dialog answered: wanted ${JSON.stringify(expect)}, saw ${JSON.stringify(text)}`);
    }
    await page.evaluate((w) => document.getElementById('arcade-dialog-' + w).click(), which);
    // The element is REUSED by the next queued question, so "answered" means
    // gone or replaced — never just "hidden", which the next dialog's own
    // microtask may already have undone.
    await waitFor(async () => (await visibleDialog(page)) !== text, 10000);
    return text;
}

/** Assert nothing is asking anything — the shape a silent decline must leave. */
async function expectNoDialog(page, ms = 1200) {
    await new Promise((r) => setTimeout(r, ms));
    return (await visibleDialog(page)) === null;
}

/**
 * Drain the two questions a first-time pairing raises on each device, in the
 * order index.html chains them. Keeping auto-reconnect OFF ("No") keeps the
 * rendezvous layer quiet for the rest of the run.
 */
async function settleCeremonyDialogs(page) {
    await answerDialog(page, 'Name this connection:', 'ok');
    await answerDialog(page, 'automatically if the connection breaks', 'cancel');
}

// ---- launcher helpers ------------------------------------------------------

// The fixture is not in catalog.json (Gate C: the framework must not know which
// games exist), but the guest's accept path resolves a game id THROUGH the
// catalog — that is the security rule, an id is looked up, never trusted as a
// URL. So the fixture is registered the way a real game is, and the accept path
// under test runs exactly as it ships.
async function seedCatalog(page) {
    await page.waitForFunction('Array.isArray(window.__arcade.catalog)', null, { timeout: 20000 });
    await page.evaluate((entries) => { window.__arcade.catalog.push(...entries); }, [
        { id: GAME, name: GAME_NAME, url: FIXTURE_ONE },
        { id: GAME2, name: GAME2_NAME, url: FIXTURE_TWO }
    ]);
}

const launch = (page, gameId, name, src) =>
    page.evaluate(([g, n, s]) => window.__arcade.showGame(g, s, n), [gameId, name, src]);

const tapInviteButton = (page) =>
    page.evaluate(() => document.getElementById('game-invite-btn').click());

const toastText = (page) =>
    page.evaluate(() => document.getElementById('launcher-toast').textContent);

const openConnections = (page) =>
    page.evaluate(() => document.getElementById('menu-multiplayer').click());

const closeConnections = (page) =>
    page.evaluate(() => window.__arcade.closeConnectionsDialog());

/**
 * A connection row, addressed the way a person addresses it: by the name on it.
 * Expands the row first — the actions live in a body that opens on tap, so a
 * click on a collapsed row's button would be a click on display:none.
 */
async function openRow(page, name) {
    const found = await page.evaluate((n) => {
        const rows = [...document.querySelectorAll('.connections-row')];
        const row = rows.find((r) => {
            const el = r.querySelector('.connections-row__name');
            return el && el.textContent === n;
        });
        if (!row) return false;
        if (!row.classList.contains('connections-row--open')) {
            row.querySelector('.connections-row__toggle').click();
        }
        return true;
    }, name);
    if (!found) throw new Error(`no connection row named ${JSON.stringify(name)}`);
}

/** Read a row's knock button label and D2 hint, after openRow(). */
const readRow = (page, name) => page.evaluate((n) => {
    const rows = [...document.querySelectorAll('.connections-row')];
    const row = rows.find((r) => {
        const el = r.querySelector('.connections-row__name');
        return el && el.textContent === n;
    });
    if (!row) return null;
    const knock = [...row.querySelectorAll('.connections-row__btn')]
        .find((b) => b.textContent.startsWith('🎮'));
    const hint = row.querySelector('.connections-row__hint');
    return { knock: knock ? knock.textContent : null, hint: hint ? hint.textContent : null };
}, name);

const tapKnock = (page, name) => page.evaluate((n) => {
    const row = [...document.querySelectorAll('.connections-row')].find((r) => {
        const el = r.querySelector('.connections-row__name');
        return el && el.textContent === n;
    });
    [...row.querySelectorAll('.connections-row__btn')]
        .find((b) => b.textContent.startsWith('🎮')).click();
}, name);

const scopesOf = (page) => page.evaluate(() => window.__arcade.p2p._gameScopes());
const mounted = (page) => page.evaluate(() => window.__arcade.pool.mountedGameIds());

try {
    console.log('\nP2P invite-door acceptance — the buttons, not the bridge\n');

    const H = await launcherPage('H', contexts.H);
    const G = await launcherPage('G', contexts.G);
    const C = await launcherPage('C', contexts.C);
    for (const page of [H, G, C]) {
        await harness.bootBridge(page, { closeDialog: true });
        await seedCatalog(page);
    }

    // ── U1: the door with nobody to ask ───────────────────────────────────
    // Before this, a running game's only invite affordance was inside the
    // game. A launcher-side door that greyed itself out when the list was
    // empty would be honest and useless; the design asks it to offer the
    // ceremony instead, because "nobody to invite" and "invite" are one
    // intention as far as the person tapping is concerned.
    await launch(H, GAME, GAME_NAME, FIXTURE_ONE);
    await tapInviteButton(H);
    const noPeers = await answerDialog(H, 'No devices connected yet.', 'ok');
    check('U1: the invite door with zero connections offers the ceremony',
        noPeers.includes('Show an invite code'), JSON.stringify(noPeers));
    await H.waitForFunction(`(() => {
        const o = document.getElementById('p2p-modal-overlay');
        const qr = document.getElementById('p2p-qr-container');
        return o && o.style.display === 'flex' && qr && qr.style.display === 'block';
    })()`, null, { timeout: 20000 });
    check('U1: … and taking the offer opens a fresh invite code, not a menu', true);
    // Abandon that half-started ceremony through the modal's own escape hatch,
    // so the real ceremony below starts from a clean transport.
    await H.evaluate(() => {
        document.getElementById('p2p-btn-restart').click();
        document.getElementById('p2p-modal-overlay').style.display = 'none';
    });

    // ── the pairing itself (not what this suite tests — just its ground) ──
    await ceremony(H, G);
    await settleCeremonyDialogs(H);
    await settleCeremonyDialogs(G);
    const H_dev = await deviceIdOf(H);
    const G_dev = await deviceIdOf(G);
    for (const [page, dev] of [[H, G_dev], [G, H_dev]]) {
        await page.waitForFunction((d) => d in window.__arcade.p2p._identityLinks(), dev, { timeout: 20000 });
    }
    check('paired, named, and identity-bound — the ground U2 stands on', true);

    // ── U2: the whole point ───────────────────────────────────────────────
    // Host taps one button; guest is asked one question; the game arrives.
    const fH = await fixtureFrame(H, 'one');
    await fH.waitForFunction(`window.__peerStatus && typeof window.__peers === 'function'`, null, { timeout: 15000 });
    check("U2: before the invite, the host's game is 'idle' — a connection is not permission to play",
        (await fH.evaluate(() => window.__peerStatus())) === 'idle');
    check('U2: … and the guest has not mounted the game at all',
        !(await mounted(G)).includes(GAME), JSON.stringify(await mounted(G)));

    // Arm the guest's pool to EVICT on the next mount. Accepting mounts a
    // game; mounting can evict an LRU frame; eviction fires the pool-shape
    // event, and the launcher's listener closes the scopes of every open game
    // the pool no longer holds. So an accept that opened the scope BEFORE
    // mounting would have it swept away by its own mount — the guest says yes,
    // and a beat later the inviter is told they left. Cap 1 plus a warm frame
    // makes that window certain rather than a thing that bites one user in
    // ten; the check after the accept is what pins the ordering.
    await G.evaluate(() => localStorage.setItem('arcade.v1.global.poolCap', '1'));
    await launch(G, GAME2, GAME2_NAME, FIXTURE_TWO);

    await tapInviteButton(H);
    const asked = await answerDialog(G, 'wants to play', 'ok');
    check('U2: the guest is asked by name, for a named game, in one sentence',
        asked === NAMES.H + ' wants to play ' + GAME_NAME + '.', JSON.stringify(asked));
    check('U2: the host is told how many were asked, and claims nothing more',
        (await toastText(H)) === 'Asked 1 device to play ' + GAME_NAME + '.',
        JSON.stringify(await toastText(H)));

    // Accepting MOUNTS the game and focuses it. The stub WP2 shipped opened a
    // scope and left the guest looking at the launcher grid.
    const fG = await fixtureFrame(G, 'one');
    await fG.waitForFunction(`window.__peerStatus && typeof window.__peers === 'function'`, null, { timeout: 15000 });
    check('U2: accepting MOUNTED the game on the guest', (await mounted(G)).includes(GAME));
    check('U2: … and focused it — the guest is looking at the game, not the launcher',
        await G.evaluate(() => document.body.classList.contains('app-in-game')
            && window.__arcade.pool.getActiveGameId() === 'p2p-test-game'));
    const afterEvict = await mounted(G);
    check('U2: … and the mount really did evict, so the next check is not vacuous',
        !afterEvict.includes(GAME2), JSON.stringify(afterEvict));
    check('U2: … and the scope SURVIVED the eviction its own mount caused (mount before accept)',
        ((await scopesOf(G))[GAME] || []).includes(H_dev), JSON.stringify(await scopesOf(G)));
    await G.evaluate(() => localStorage.setItem('arcade.v1.global.poolCap', '2'));

    await fG.waitForFunction(`window.__peerStatus() === 'connected'`, null, { timeout: 20000 });
    await fH.waitForFunction(`window.__peerStatus() === 'connected'`, null, { timeout: 20000 });
    check('U2: both games read connected off their own scope', true);
    // The cascade the design counted on: accepting mounts, mounting announces
    // presence at arcade:hello, presence fires onReady on both ends. No new
    // machinery — but nothing proved it ran until this check.
    const readyBoth = await waitFor(async () =>
        (await fH.evaluate(() => window.__readyEvents.length > 0))
        && (await fG.evaluate(() => window.__readyEvents.length > 0)), 20000);
    check('U2: onReady cascaded on BOTH ends off the accept alone', readyBoth);
    const rosterH = await fH.evaluate(() => window.__peers());
    check('U2: the host now sees the guest, direct and connected',
        rosterH.length === 1 && rosterH[0].deviceId === G_dev && rosterH[0].direct === true,
        JSON.stringify(rosterH));

    await fH.evaluate(() => window.__send({ fromHost: 1 }));
    const gotHost = await fG.waitForFunction(
        `window.__rx.some(r => r.payload && r.payload.fromHost === 1)`, null, { timeout: 20000 }).then(() => true, () => false);
    await fG.evaluate(() => window.__send({ fromGuest: 1 }));
    const gotGuest = await fH.waitForFunction(
        `window.__rx.some(r => r.payload && r.payload.fromGuest === 1)`, null, { timeout: 20000 }).then(() => true, () => false);
    check('U2: a frame flows host → guest, and guest → host, off one tap and one Play',
        gotHost && gotGuest, JSON.stringify([gotHost, gotGuest]));

    // ── U3: declining is silent ───────────────────────────────────────────
    await launch(H, GAME2, GAME2_NAME, FIXTURE_TWO);
    await tapInviteButton(H);
    await answerDialog(G, NAMES.H + ' wants to play ' + GAME2_NAME + '.', 'cancel');
    check('U3: a declined invite opens no scope on the inviter',
        !(GAME2 in (await scopesOf(H))), JSON.stringify(await scopesOf(H)));
    check('U3: … and mounts nothing on the decliner',
        !(await mounted(G)).includes(GAME2), JSON.stringify(await mounted(G)));
    check('U3: … and says nothing at all to the inviter — a refusal that notifies is a refusal that pressures',
        await expectNoDialog(H));
    check("U3: … while the game they ARE playing together is untouched",
        (await scopesOf(H))[GAME].includes(G_dev));

    // ── U4: the knock — D4's other half ───────────────────────────────────
    // A row offers the running game to that one device. It must NOT offer a
    // game that device is already playing: inviteGame skips those, so the
    // button's entire effect would be to send nothing.
    await openConnections(G);
    await G.waitForFunction(`document.querySelectorAll('.connections-row').length > 0`, null, { timeout: 15000 });
    await openRow(G, NAMES.H);
    const playingRow = await readRow(G, NAMES.H);
    check('U4: no knock for a device already playing the running game',
        playingRow.knock === null, JSON.stringify(playingRow));
    await closeConnections(G);

    // Same row, different running game — the one H declined, so no scope.
    await launch(G, GAME2, GAME2_NAME, FIXTURE_TWO);
    await openConnections(G);
    await openRow(G, NAMES.H);
    const knockRow = await readRow(G, NAMES.H);
    check('U4: the knock names the running game, so you know what you are proposing',
        knockRow.knock === '🎮 Ask to play ' + GAME2_NAME, JSON.stringify(knockRow));

    await tapKnock(G, NAMES.H);
    await answerDialog(H, NAMES.G + ' wants to play ' + GAME2_NAME + '.', 'ok');
    check('U4: the knock reaches exactly that device, and it is symmetric — the guest proposed to the host',
        await waitFor(async () => ((await scopesOf(G))[GAME2] || []).includes(H_dev), 20000));
    check('U4: … and accepting a knock mounts the game on the host too',
        await waitFor(async () => (await mounted(H)).includes(GAME2), 20000));
    await closeConnections(G);

    // ── U5: D2's dead end, in copy ────────────────────────────────────────
    // The field-test shape, from the guest's side: G is linked to H and to C;
    // H and C are not linked and never will be. G can open a game with C, but
    // C cannot join the game G is in — seating needs a link to the host. That
    // is physics, so it gets a sentence rather than machinery.
    await ceremony(G, C, { waitHost: false });
    await settleCeremonyDialogs(G);
    await settleCeremonyDialogs(C);
    const C_dev = await deviceIdOf(C);
    await G.waitForFunction((d) => d in window.__arcade.p2p._identityLinks(), C_dev, { timeout: 20000 });

    await openConnections(G);
    await openRow(G, NAMES.C);
    const cRow = await readRow(G, NAMES.C);
    check('U5: the unlinked device still gets a knock — it can play with us, and that much is true',
        cRow.knock === '🎮 Ask to play ' + GAME2_NAME, JSON.stringify(cRow));
    check('U5: … under D2 copy naming the device it would have to be linked to',
        cRow.hint === 'Joining ' + NAMES.H + '’s game needs a link to ' + NAMES.H
        + ' — ask ' + NAMES.H + ' to connect with ' + NAMES.C + '.', JSON.stringify(cRow.hint));
    check('U5: … and no such warning on the device that IS playing it',
        (await readRow(G, NAMES.H)).hint === null);

    await H.close(); await G.close(); await C.close();
} catch (e) {
    console.error('\nFATAL:', e.message);
    check('run completed', false, e.message);
} finally {
    await harness.shutdown();
}

console.log(failed() === 0 ? '\nAll invite-door checks passed.' : `\n${failed()} check(s) FAILED.`);
process.exit(failed() === 0 ? 0 : 1);
