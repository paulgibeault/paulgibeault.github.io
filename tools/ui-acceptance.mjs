#!/usr/bin/env node
//
// tools/ui-acceptance.mjs — proves the launcher-mediated UI chrome bridge
// (issue #35) end to end: attributed confirm/prompt modals rendered by the
// launcher for sandboxed (opaque-origin) game frames, app-set topbar titles,
// the quit-veto round-trip (arcade:ui.beforeQuit), the consent-gated
// openFile broker, share's clipboard fallback, and in-frame copy.
//
//   node tools/ui-acceptance.mjs
//
// Self-contained: serves the repo on :4802 and drives the fixture app
// (tools/fixtures/ui-test/) through the real launcher iframe pool.
// Exit code: 0 if all checks pass, 1 otherwise.

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveRepo } from './lib/static-server.mjs';
import { createRecorder } from './lib/check-recorder.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4802;

// cors: opaque-origin frames send Origin: null — mirror GitHub Pages.
const server = await serveRepo({ root: ROOT, port: PORT, cors: true });

const BASE = `http://127.0.0.1:${PORT}`;
const GAME_PATH = '/tools/fixtures/ui-test/';

const { check, summarize } = createRecorder({ indent: '', detailStyle: 'wide-dash', emptyDetailOnFail: true });

const DIALOG_OPEN = '#arcade-dialog:not(.hidden)';

async function mount(page, gameId, src, name) {
    await page.evaluate(([gid, s, n]) => window.__arcade.showGame(gid, s, n), [gameId, src, name]);
    let frame = null;
    for (let i = 0; i < 100 && !frame; i++) {
        frame = page.frames().find(f => f.url().includes(src));
        if (!frame) await page.waitForTimeout(50);
    }
    if (!frame) throw new Error('fixture frame never appeared: ' + gameId);
    await frame.evaluate(() => window.Arcade.ready);
    return frame;
}

// Poll a frame-side expression until it turns truthy (or time runs out).
async function pollFrame(frame, fn, ms = 3000) {
    const deadline = Date.now() + ms;
    let v;
    while (Date.now() < deadline) {
        v = await frame.evaluate(fn);
        if (v !== null && v !== undefined) return v;
        await frame.waitForTimeout(50);
    }
    return v;
}

const browser = await chromium.launch({ headless: true });
try {
    // clipboard-read for verifying share's fallback wrote the payload;
    // clipboard-write so the launcher-side writeText path isn't perm-gated.
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage();
    page.on('pageerror', e => check('no launcher page errors', false, e.message));

    await page.goto(BASE + '/', { waitUntil: 'load' });
    const frame = await mount(page, 'ui-test', GAME_PATH, 'UI Test');

    // ── 1. Capability advertised ──
    const caps = await frame.evaluate(() => Arcade.peer.caps());
    check('welcome advertises ui.bridge cap', caps.includes('ui.bridge'), JSON.stringify(caps));

    // ── 2. confirm: attributed modal, OK / cancel round-trips ──
    await frame.evaluate(() => {
        window.uiResults = {};
        Arcade.ui.confirm('Erase the journal?', { okLabel: 'Erase', cancelLabel: 'Keep' })
            .then(v => { window.uiResults.c1 = v; });
    });
    await page.waitForSelector(DIALOG_OPEN, { timeout: 5000 });
    const dlg = await page.evaluate(() => ({
        msg: document.getElementById('arcade-dialog-msg').textContent,
        ok: document.getElementById('arcade-dialog-ok').textContent,
        cancel: document.getElementById('arcade-dialog-cancel').textContent,
        inputHidden: document.getElementById('arcade-dialog-input').classList.contains('hidden'),
    }));
    check('confirm renders the launcher modal', true);
    check('confirm message is app-attributed', dlg.msg.startsWith('“UI Test” asks:'), dlg.msg);
    check('confirm carries the game message', dlg.msg.includes('Erase the journal?'), dlg.msg);
    check('confirm custom labels applied', dlg.ok === 'Erase' && dlg.cancel === 'Keep', JSON.stringify(dlg));
    check('confirm shows no input row', dlg.inputHidden === true);
    await page.click('#arcade-dialog-ok');
    const c1 = await pollFrame(frame, () => window.uiResults.c1);
    check('confirm OK resolves true in the frame', c1 === true, JSON.stringify(c1));

    await frame.evaluate(() => { Arcade.ui.confirm('Again?').then(v => { window.uiResults.c2 = v; }); });
    await page.waitForSelector(DIALOG_OPEN, { timeout: 5000 });
    await page.click('#arcade-dialog-cancel');
    const c2 = await pollFrame(frame, () => window.uiResults.c2 === false ? 'no' : null);
    check('confirm cancel resolves false', c2 === 'no');

    // ── 3. prompt: default value, typed reply, cancel → null ──
    await frame.evaluate(() => { Arcade.ui.prompt('Save as?', 'untitled').then(v => { window.uiResults.p1 = v; }); });
    await page.waitForSelector(DIALOG_OPEN, { timeout: 5000 });
    const promptState = await page.evaluate(() => ({
        value: document.getElementById('arcade-dialog-input').value,
        type: document.getElementById('arcade-dialog-input').type,
        hidden: document.getElementById('arcade-dialog-input').classList.contains('hidden'),
    }));
    check('prompt shows the input with the default value',
        promptState.hidden === false && promptState.value === 'untitled', JSON.stringify(promptState));
    check('prompt input is never password-masked', promptState.type === 'text', promptState.type);
    await page.fill('#arcade-dialog-input', 'my-save');
    await page.click('#arcade-dialog-ok');
    const p1 = await pollFrame(frame, () => window.uiResults.p1);
    check('prompt OK resolves the typed value', p1 === 'my-save', JSON.stringify(p1));

    await frame.evaluate(() => {
        window.uiResults.p2 = 'unset';
        Arcade.ui.prompt('Rename?').then(v => { window.uiResults.p2 = v; });
    });
    await page.waitForSelector(DIALOG_OPEN, { timeout: 5000 });
    await page.click('#arcade-dialog-cancel');
    const p2 = await pollFrame(frame, () => window.uiResults.p2 === null ? 'null' : null);
    check('prompt cancel resolves null', p2 === 'null');

    // ── 4. setTitle: topbar follows, empty resets, survives a switch ──
    await frame.evaluate(() => Arcade.ui.setTitle('Journal — draft 3'));
    let title = null;
    for (let i = 0; i < 40 && title !== 'Journal — draft 3'; i++) {
        title = await page.evaluate(() => document.getElementById('game-topbar-title').textContent);
        if (title !== 'Journal — draft 3') await page.waitForTimeout(50);
    }
    check('setTitle updates the topbar', title === 'Journal — draft 3', String(title));

    // Second app takes over the topbar; the first keeps its custom title
    // for its next activation (warm pooled frame).
    const frame2 = await mount(page, 'ui-2', GAME_PATH + '?gid=ui-2', 'UI Two');
    const titleTwo = await page.evaluate(() => document.getElementById('game-topbar-title').textContent);
    check('switching apps shows the new app title', titleTwo === 'UI Two', titleTwo);

    // ── 5. Background frames cannot pop dialogs ──
    await frame.evaluate(() => {
        window.uiResults.bg = 'pending';
        Arcade.ui.confirm('background spoof?').then(v => { window.uiResults.bg = v; });
    });
    const bg = await pollFrame(frame, () => window.uiResults.bg === false ? 'no' : null);
    check('background confirm resolves false (cancel answer)', bg === 'no');
    const bgDialogHidden = await page.evaluate(() =>
        document.getElementById('arcade-dialog').classList.contains('hidden'));
    check('background confirm never opened a dialog', bgDialogHidden === true);

    // Back to the first app: its custom title was kept on the pool entry.
    await page.evaluate(() => window.__arcade.showGame('ui-test', '/tools/fixtures/ui-test/', 'UI Test'));
    const titleBack = await page.evaluate(() => document.getElementById('game-topbar-title').textContent);
    check('custom title survives an app switch', titleBack === 'Journal — draft 3', titleBack);

    await frame.evaluate(() => Arcade.ui.setTitle(''));
    let titleReset = null;
    for (let i = 0; i < 40 && titleReset !== 'UI Test'; i++) {
        titleReset = await page.evaluate(() => document.getElementById('game-topbar-title').textContent);
        if (titleReset !== 'UI Test') await page.waitForTimeout(50);
    }
    check('setTitle("") resets to the catalog name', titleReset === 'UI Test', String(titleReset));

    // ── 6. beforeQuit: veto holds, allow quits, timeout never traps ──
    await frame.evaluate(() => {
        window.uiResults.quitAsked = 0;
        window.uiResults.allowQuit = false;
        Arcade.ui.onBeforeQuit(() => {
            window.uiResults.quitAsked++;
            return window.uiResults.allowQuit;
        });
    });
    await page.waitForTimeout(100); // quitHook registration is fire-and-forget
    await page.click('#quit-game-btn');
    await page.waitForTimeout(400);
    const vetoState = await page.evaluate(() => document.body.classList.contains('app-in-game'));
    const asked = await frame.evaluate(() => window.uiResults.quitAsked);
    check('vetoing hook keeps the app open', vetoState === true);
    check('hook was actually consulted', asked === 1, String(asked));

    await frame.evaluate(() => { window.uiResults.allowQuit = true; });
    await page.click('#quit-game-btn');
    let quitDone = false;
    for (let i = 0; i < 40 && !quitDone; i++) {
        quitDone = await page.evaluate(() => !document.body.classList.contains('app-in-game'));
        if (!quitDone) await page.waitForTimeout(50);
    }
    check('allowing hook quits to the launcher', quitDone === true);

    // Hung handler: the launcher's deadline forfeits the veto (no trap).
    await page.evaluate(() => window.__arcade.showGame('ui-test', '/tools/fixtures/ui-test/', 'UI Test'));
    await frame.evaluate(() => { Arcade.ui.onBeforeQuit(() => new Promise(() => {})); });
    await page.waitForTimeout(100);
    await page.click('#quit-game-btn');
    await page.waitForTimeout(400);
    const stillIn = await page.evaluate(() => document.body.classList.contains('app-in-game'));
    check('hung hook holds the quit briefly', stillIn === true);
    let timedOut = false;
    for (let i = 0; i < 60 && !timedOut; i++) {
        timedOut = await page.evaluate(() => !document.body.classList.contains('app-in-game'));
        if (!timedOut) await page.waitForTimeout(50);
    }
    check('hung hook forfeits the veto after the deadline', timedOut === true);

    // Unregistering restores the instant quit.
    await page.evaluate(() => window.__arcade.showGame('ui-test', '/tools/fixtures/ui-test/', 'UI Test'));
    await frame.evaluate(() => Arcade.ui.onBeforeQuit(null));
    await page.waitForTimeout(100);
    await page.click('#quit-game-btn');
    let instant = false;
    for (let i = 0; i < 20 && !instant; i++) {
        instant = await page.evaluate(() => !document.body.classList.contains('app-in-game'));
        if (!instant) await page.waitForTimeout(25);
    }
    check('unregistered hook quits immediately', instant === true);

    // ── 7. openFile: consent dialog → picker → File lands in the frame ──
    await page.evaluate(() => window.__arcade.showGame('ui-test', '/tools/fixtures/ui-test/', 'UI Test'));
    await frame.evaluate(() => {
        window.uiResults.file = 'pending';
        Arcade.ui.openFile({ accept: '.txt' }).then(async (f) => {
            window.uiResults.file = f ? { name: f.name, type: f.type, text: await f.text() } : null;
        });
    });
    await page.waitForSelector(DIALOG_OPEN, { timeout: 5000 });
    const consentMsg = await page.evaluate(() => document.getElementById('arcade-dialog-msg').textContent);
    check('openFile shows an attributed consent dialog',
        consentMsg.includes('“UI Test”') && consentMsg.includes('open a file'), consentMsg);
    const [chooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 5000 }),
        page.click('#arcade-dialog-ok'),
    ]);
    await chooser.setFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello from disk') });
    const fileGot = await pollFrame(frame, () =>
        (window.uiResults.file && window.uiResults.file !== 'pending') ? window.uiResults.file : null);
    check('openFile delivers the File across the bridge',
        !!fileGot && fileGot.name === 'notes.txt' && fileGot.text === 'hello from disk',
        JSON.stringify(fileGot));

    // openFile consent declined → null, no picker.
    await frame.evaluate(() => {
        window.uiResults.file2 = 'pending';
        Arcade.ui.openFile().then(f => { window.uiResults.file2 = f === null ? 'null' : 'file'; });
    });
    await page.waitForSelector(DIALOG_OPEN, { timeout: 5000 });
    await page.click('#arcade-dialog-cancel');
    const file2 = await pollFrame(frame, () =>
        window.uiResults.file2 !== 'pending' ? window.uiResults.file2 : null);
    check('openFile consent declined resolves null', file2 === 'null', String(file2));

    // ── 8. share: no Web Share in headless → consent → clipboard fallback ──
    await frame.evaluate(() => {
        window.uiResults.share = 'pending';
        Arcade.ui.share({ text: 'come play', url: 'https://example.test/g' })
            .then(v => { window.uiResults.share = v; });
    });
    await page.waitForSelector(DIALOG_OPEN, { timeout: 5000 });
    const shareMsg = await page.evaluate(() => document.getElementById('arcade-dialog-msg').textContent);
    check('share shows an attributed consent dialog with the payload',
        shareMsg.includes('“UI Test”') && shareMsg.includes('come play'), shareMsg);
    await page.click('#arcade-dialog-ok');
    const shareRes = await pollFrame(frame, () =>
        window.uiResults.share !== 'pending' ? window.uiResults.share : null);
    check("share falls back to 'copied' without Web Share", shareRes === 'copied', JSON.stringify(shareRes));
    const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => '(unreadable)'));
    check('share fallback put the payload on the clipboard',
        clip.includes('come play') && clip.includes('https://example.test/g'), clip);

    // share declined → null, clipboard untouched.
    await page.evaluate(() => navigator.clipboard.writeText('sentinel'));
    await frame.evaluate(() => {
        window.uiResults.share2 = 'pending';
        Arcade.ui.share({ text: 'nope' }).then(v => { window.uiResults.share2 = v === null ? 'null' : v; });
    });
    await page.waitForSelector(DIALOG_OPEN, { timeout: 5000 });
    await page.click('#arcade-dialog-cancel');
    const share2 = await pollFrame(frame, () =>
        window.uiResults.share2 !== 'pending' ? window.uiResults.share2 : null);
    check('share declined resolves null', share2 === 'null', String(share2));
    const clip2 = await page.evaluate(() => navigator.clipboard.readText().catch(() => '(unreadable)'));
    check('declined share left the clipboard alone', clip2 === 'sentinel', clip2);

    // ── 9. Raw malformed ui.op is dropped (no dialog, no crash) ──
    await frame.evaluate(() => {
        // Bypass the SDK: confirm without an id must be rejected by shape.
        window.parent.postMessage({ type: 'arcade:ui.op', op: 'confirm', message: 'spoof' }, '*');
    });
    await page.waitForTimeout(300);
    const spoofHidden = await page.evaluate(() =>
        document.getElementById('arcade-dialog').classList.contains('hidden'));
    check('id-less ui.op never renders a dialog', spoofHidden === true);

    // ── 10. copy: in-frame write via the granted clipboard-write policy ──
    // Driven by a REAL click inside the frame (evaluate carries no user
    // gesture, and clipboard writes want one).
    await frame.evaluate(() => {
        const btn = document.createElement('button');
        btn.id = 'copy-btn';
        btn.textContent = 'copy';
        btn.addEventListener('click', () => {
            window.uiResults.copy = 'pending';
            Arcade.ui.copy('copied-from-frame').then(ok => { window.uiResults.copy = ok; });
        });
        document.body.appendChild(btn);
    });
    await frame.click('#copy-btn');
    const copyRes = await pollFrame(frame, () =>
        window.uiResults.copy !== 'pending' ? window.uiResults.copy : null);
    check('ui.copy resolves a boolean (API contract)', typeof copyRes === 'boolean', JSON.stringify(copyRes));
    check('ui.copy succeeds in the sandboxed frame', copyRes === true, JSON.stringify(copyRes));

    // ── 11. Standalone regression: fixture opened directly ──
    const solo = await context.newPage();
    await solo.goto(BASE + GAME_PATH, { waitUntil: 'load' });
    const soloFramed = await solo.evaluate(async () => {
        await Arcade.ready;
        Arcade.ui.setTitle('Solo Title'); // fire-and-forget: lands a tick later
        return Arcade.context.framed;
    });
    let soloTitle = null;
    for (let i = 0; i < 40 && soloTitle !== 'Solo Title'; i++) {
        soloTitle = await solo.evaluate(() => document.title);
        if (soloTitle !== 'Solo Title') await solo.waitForTimeout(50);
    }
    check('standalone setTitle drives document.title',
        soloFramed === false && soloTitle === 'Solo Title', JSON.stringify({ soloFramed, soloTitle }));
    await solo.close();
} catch (e) {
    check('run completed', false, e.stack || String(e));
} finally {
    await browser.close();
    server.close();
}

process.exit(summarize({ style: 'ratio', label: 'ui-acceptance' }));
