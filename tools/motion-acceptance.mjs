#!/usr/bin/env node
//
// tools/motion-acceptance.mjs — proves brokered motion sensing end to end
// (plans/motion-sensing-2026-09.md WP4; cap 'motion.bridge'): the cap and
// welcome.motion arrive, the consent dialog's Allow / Not now, samples reach
// only the ACTIVE frame in screen axes, silence after suspend, stop, and a
// Motion switch flipped mid-stream, the master switch, a sensorless desktop,
// an older launcher without the cap, and the SDK's standalone path.
//
//   node tools/motion-acceptance.mjs
//
// The sensor is Chromium's CDP override (DeviceOrientation.
// setDeviceOrientationOverride), which only speaks to a context granted the
// sensor permissions — without them Chromium fires one all-null event, which
// is also what the "sensor that never speaks" check leans on. Contexts are
// created with hasTouch because motion is only offered on a device that could
// plausibly have a sensor.
// Self-contained: serves the repo on :4811 and drives the fixture app
// (tools/fixtures/motion-test/) through the real launcher iframe pool.
// Exit code: 0 if all checks pass, 1 otherwise.

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveRepo } from './lib/static-server.mjs';
import { createRecorder } from './lib/check-recorder.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4811;
const server = await serveRepo({ root: ROOT, port: PORT, cors: true });
const BASE = `http://127.0.0.1:${PORT}`;
const GAME_PATH = '/tools/fixtures/motion-test/';
const CONSENT_KEY = 'arcade.v1._meta.motion';
const DIALOG_OPEN = '#arcade-dialog:not(.hidden)';

const { check, summarize } = createRecorder({ indent: '', detailStyle: 'wide-dash', emptyDetailOnFail: true });

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
async function poll(target, fn, arg, ms = 4000) {
    const deadline = Date.now() + ms;
    let v;
    while (Date.now() < deadline) {
        v = await target.evaluate(fn, arg);
        if (v !== null && v !== undefined && v !== false) return v;
        await new Promise(r => setTimeout(r, 50));
    }
    return v;
}
// Each override call that CHANGES the reading is one deviceorientation event.
// A real sensor never goes quiet, so alpha (the compass heading, which gravity
// does not depend on) is walked to keep events coming without moving the answer.
let heading = 0;
async function orient(cdp, beta, gamma, n = 1) {
    for (let i = 0; i < n; i++) {
        heading = (heading + 1) % 360;
        await cdp.send('DeviceOrientation.setDeviceOrientationOverride',
            { alpha: heading, beta, gamma });
        if (n > 1) await new Promise(r => setTimeout(r, 45));
    }
}
const startIn = (frame, key, hz = 30) => frame.evaluate(([k, h]) => {
    window.motion.results[k] = 'pending';
    Arcade.motion.start({ hz: h }).then(v => { window.motion.results[k] = v; });
}, [key, hz]);
const resultOf = (frame, key) => poll(frame, (k) => window.motion.results[k] !== 'pending' ? window.motion.results[k] : null, key);
const sampleCount = (frame) => frame.evaluate(() => window.motion.samples.length);
const lastSample = (frame) => frame.evaluate(() => window.motion.samples[window.motion.samples.length - 1] || null);
const near = (a, b) => Math.abs(a - b) < 1e-3;

const PHONE = { hasTouch: true, permissions: ['accelerometer', 'gyroscope', 'magnetometer'] };
const browser = await chromium.launch({ headless: true });
try {
    // ── A phone: touch, a sensor (CDP), the real launcher ──
    const context = await browser.newContext(PHONE);
    const page = await context.newPage();
    page.on('pageerror', e => check('no launcher page errors', false, e.message));
    const cdp = await context.newCDPSession(page);
    await page.goto(BASE + '/', { waitUntil: 'load' });
    const frame = await mount(page, 'motion-test', GAME_PATH, 'Motion Test');

    // 1. the contract arrives
    const hello = await frame.evaluate(() => ({
        caps: Arcade.peer.caps(), available: Arcade.motion.available(),
        running: Arcade.motion.running()
    }));
    check('welcome advertises motion.bridge', hello.caps.includes('motion.bridge'), JSON.stringify(hello.caps));
    check('available() is true on a touch device; not running',
        hello.available === true && hello.running === false, JSON.stringify(hello));
    check('idle: the launcher is not listening to the sensor',
        await page.evaluate(() => window.__arcade.motion.snapshot().listening === false));
    check('idle: no top-bar mark', await page.evaluate(() => (getComputedStyle(document.getElementById('game-motion-mark')).display === 'none')));

    // 2. Not now
    await startIn(frame, 'notnow');
    await page.waitForSelector(DIALOG_OPEN, { timeout: 5000 });
    const dlg = await page.evaluate(() => ({
        msg: document.getElementById('arcade-dialog-msg').textContent,
        ok: document.getElementById('arcade-dialog-ok').textContent,
        cancel: document.getElementById('arcade-dialog-cancel').textContent
    }));
    check('start() raises the launcher dialog, attributed to the app',
        dlg.msg.startsWith('“Motion Test” would like to use your device’s motion'), dlg.msg);
    check('dialog offers Allow / Not now and says where to change it',
        dlg.ok === 'Allow' && dlg.cancel === 'Not now' && dlg.msg.includes('Menu → Motion'), JSON.stringify(dlg));
    await page.click('#arcade-dialog-cancel');
    check('Not now → denied', (await resultOf(frame, 'notnow')) === 'denied');
    check('Not now is not remembered', await page.evaluate((k) => localStorage.getItem(k) === null, CONSENT_KEY));

    // 3. Allow
    await startIn(frame, 'allow');
    await page.waitForSelector(DIALOG_OPEN, { timeout: 5000 });
    check('the game may ask again after Not now', true);
    await page.click('#arcade-dialog-ok');
    await orient(cdp, 90, 0, 3);
    check('Allow + a live sensor → granted', (await resultOf(frame, 'allow')) === 'granted');
    const consent = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)), CONSENT_KEY);
    check('the answer is remembered per game', consent && consent.games['motion-test'] && consent.games['motion-test'].allowed === true, JSON.stringify(consent));
    check('running() true and onChange fired', await frame.evaluate(() =>
        Arcade.motion.running() === true && window.motion.changes.some(c => c.running === true)));

    // 4. samples, in screen axes
    await orient(cdp, 90, 0, 4);
    let s = await poll(frame, () => window.motion.samples[window.motion.samples.length - 1] || null);
    check('upright → { x: 0, y: 1, z: 0 }, not flat, with t',
        s && near(s.x, 0) && near(s.y, 1) && near(s.z, 0) && s.flat === false && typeof s.t === 'number', JSON.stringify(s));
    await orient(cdp, 45, -90, 4);
    s = await lastSample(frame);
    check('rolled 45° counter-clockwise → down-left', s && near(s.x, -Math.SQRT1_2) && near(s.y, Math.SQRT1_2), JSON.stringify(s));
    await orient(cdp, 2, 1, 4);
    s = await lastSample(frame);
    check('lying flat → flat: true, z ≈ −1', s && s.flat === true && s.z < -0.99, JSON.stringify(s));
    const dirs = await frame.evaluate(() => {
        const c = Arcade.motion.compass(8);
        return [c.update({ x: 0, y: 1 }), c.update({ x: 1, y: 1 }), c.update({ x: 1.01, y: 1 })];
    });
    check('compass(8): null while unchanged, { dir, gx, gy } on a change',
        dirs[0] === null && dirs[1] && dirs[1].gx === 1 && dirs[1].gy === 1 && dirs[1].dir === 1 && dirs[2] === null, JSON.stringify(dirs));
    check('streaming: exactly the top-bar mark shows',
        await page.evaluate(() => (getComputedStyle(document.getElementById('game-motion-mark')).display !== 'none')));
    const n30 = await sampleCount(frame);
    await orient(cdp, 80, 0, 20); // ~22 events/s for ~0.9 s
    const got = (await sampleCount(frame)) - n30;
    check('samples flow while events do', got >= 10 && got <= 20, String(got));

    // 5. active app only
    const frame2 = await mount(page, 'motion-2', GAME_PATH + '?gid=motion-2', 'Motion Two');
    await page.waitForTimeout(150);
    const frozen = await sampleCount(frame);
    await orient(cdp, 70, 10, 6);
    check('a backgrounded game receives nothing', (await sampleCount(frame)) === frozen);
    check('…nor does an active game that never started', (await sampleCount(frame2)) === 0);
    check('…and the launcher stopped listening + hid the mark', await page.evaluate(() =>
        window.__arcade.motion.snapshot().listening === false && (getComputedStyle(document.getElementById('game-motion-mark')).display === 'none')));
    await startIn(frame, 'background');
    check('a background frame\'s start() → denied, no dialog',
        (await resultOf(frame, 'background')) === 'denied' && await page.evaluate((sel) => !document.querySelector(sel), DIALOG_OPEN));
    // (that denied start ended the first game's stream SDK-side — restart it
    // once it is active again: remembered Allow, so no dialog.)
    await mount(page, 'motion-test', GAME_PATH, 'Motion Test');
    await startIn(frame, 'again');
    check('a remembered Allow starts without a dialog',
        (await resultOf(frame, 'again')) === 'granted' && await page.evaluate((sel) => !document.querySelector(sel), DIALOG_OPEN));
    const resumed = await sampleCount(frame);
    await orient(cdp, 60, 0, 5);
    check('active again: samples flow', (await sampleCount(frame)) > resumed);

    // 6. suspend/resume is the SDK's and the launcher's, not the game's
    await page.evaluate(() => window.__arcade.hideGameView());
    await page.waitForTimeout(150);
    const hiddenAt = await sampleCount(frame);
    await orient(cdp, 50, 0, 5);
    check('launcher view (game suspended): silence', (await sampleCount(frame)) === hiddenAt);
    await mount(page, 'motion-test', GAME_PATH, 'Motion Test');
    await orient(cdp, 55, 0, 5);
    check('resumed: samples return with no new start()', (await sampleCount(frame)) > hiddenAt);

    // 7. stop
    await frame.evaluate(() => Arcade.motion.stop());
    await page.waitForTimeout(150);
    const stoppedAt = await sampleCount(frame);
    await orient(cdp, 40, 0, 5);
    check('stop(): silence, listener released, mark gone', (await sampleCount(frame)) === stoppedAt
        && await page.evaluate(() => window.__arcade.motion.snapshot().listening === false
            && (getComputedStyle(document.getElementById('game-motion-mark')).display === 'none')));

    // 8. the Motion section: a row flipped Off mid-stream
    await startIn(frame, 'forflip');
    await resultOf(frame, 'forflip');
    await orient(cdp, 45, 0, 3);
    await page.click('#game-motion-mark');
    check('the top-bar mark opens the menu at the Motion section', await page.evaluate(() =>
        document.getElementById('launcher-menu').dataset.open === 'true'
        && !document.getElementById('menu-motion-section').hidden));
    const row = '[data-motion-game="motion-test"]';
    check('the section lists the game as Allowed', await page.evaluate((sel) => {
        const b = document.querySelector(sel);
        return !!b && b.getAttribute('aria-checked') === 'true' && /Motion Test/.test(b.textContent) && /Allowed/.test(b.textContent);
    }, row));
    await page.click(row);
    check('flipping a row leaves the menu open', await page.evaluate(() => document.getElementById('launcher-menu').dataset.open === 'true'));
    await poll(frame, () => Arcade.motion.available() === false);
    const flippedAt = await sampleCount(frame);
    await orient(cdp, 30, 0, 5);
    const afterFlip = await frame.evaluate(() => ({
        available: Arcade.motion.available(), running: Arcade.motion.running(),
        told: window.motion.changes.some(c => c.available === false && c.running === false)
    }));
    check('row Off: the stream stops at once', (await sampleCount(frame)) === flippedAt);
    check('row Off: available() false, running() false, onChange told the game',
        afterFlip.available === false && afterFlip.running === false && afterFlip.told, JSON.stringify(afterFlip));
    check('row Off: the other game is untouched', await frame2.evaluate(() => Arcade.motion.available() === true));
    await startIn(frame, 'whileoff');
    check('row Off: start() → denied without a dialog',
        (await resultOf(frame, 'whileoff')) === 'denied' && await page.evaluate((sel) => !document.querySelector(sel), DIALOG_OPEN));
    await page.click(row);
    check('row back on: available() true again', (await poll(frame, () => Arcade.motion.available())) === true);

    // 9. the master switch
    await page.click('#menu-motion-master');
    await poll(frame, () => Arcade.motion.available() === false);
    const off = await Promise.all([frame, frame2].map(f => f.evaluate(() => ({ a: Arcade.motion.available() }))));
    check('master Off: available() false for every game',
        off.every(o => o.a === false), JSON.stringify(off));
    check('master Off: label says so and the rows are disabled', await page.evaluate((sel) =>
        document.getElementById('menu-motion-master-label').textContent === 'Motion Off'
        && document.querySelector(sel).disabled === true, row));
    await page.click('#menu-motion-master');
    check('master back On: available() returns', (await poll(frame, () => Arcade.motion.available())) === true);
    await page.keyboard.press('Escape');

    // 10. a reloaded launcher remembers; a fresh frame starts dialog-free
    await page.reload({ waitUntil: 'load' });
    const frameR = await mount(page, 'motion-test', GAME_PATH, 'Motion Test');
    await startIn(frameR, 'reloaded');
    await orient(cdp, 90, 0, 3);
    check('after a launcher reload: granted with no dialog',
        (await resultOf(frameR, 'reloaded')) === 'granted' && await page.evaluate((sel) => !document.querySelector(sel), DIALOG_OPEN));
    await context.close();

    // ── A desktop: no touch ⇒ not offered, nothing prompts ──
    {
        const ctx = await browser.newContext();
        const p = await ctx.newPage();
        await p.goto(BASE + '/', { waitUntil: 'load' });
        const f = await mount(p, 'motion-test', GAME_PATH, 'Motion Test');
        check('desktop: cap present but available() false', await f.evaluate(() =>
            Arcade.peer.caps().includes('motion.bridge') && Arcade.motion.available() === false));
        check('desktop: the Motion section is hidden', await p.evaluate(() => document.getElementById('menu-motion-section').hidden));
        await startIn(f, 'desk');
        check('desktop: start() → denied/unavailable, no dialog',
            ['denied', 'unavailable'].includes(await resultOf(f, 'desk')) && await p.evaluate((sel) => !document.querySelector(sel), DIALOG_OPEN));
        await ctx.close();
    }

    // ── An older launcher: no cap ⇒ the SDK degrades, nothing is posted ──
    {
        const ctx = await browser.newContext({ hasTouch: true });
        const p = await ctx.newPage();
        await p.route('**/arcade-router.js', async (route) => {
            const res = await route.fetch();
            const body = (await res.text()).replace(", 'motion.bridge']", ']');
            await route.fulfill({ response: res, body });
        });
        await p.goto(BASE + '/', { waitUntil: 'load' });
        const f = await mount(p, 'motion-test', GAME_PATH, 'Motion Test');
        const old = await f.evaluate(async () => ({
            caps: Arcade.peer.caps(), available: Arcade.motion.available(), how: await Arcade.motion.start()
        }));
        check('older launcher (no cap): available() false and start() → unavailable',
            !old.caps.includes('motion.bridge') && old.available === false && old.how === 'unavailable', JSON.stringify(old));
        await ctx.close();
    }

    // ── Standalone: the SDK listens directly, same numbers ──
    {
        const ctx = await browser.newContext(PHONE);
        const p = await ctx.newPage();
        const c = await ctx.newCDPSession(p);
        await p.goto(BASE + GAME_PATH + '?gid=motion-solo', { waitUntil: 'load' });
        await p.evaluate(() => Arcade.ready);
        check('standalone: available() true at top level on a touch device',
            await p.evaluate(() => Arcade.context.framed === false && Arcade.motion.available() === true));
        await startIn(p, 'solo');
        await orient(c, 45, -90, 4);
        check('standalone: start() → granted once the sensor speaks', (await resultOf(p, 'solo')) === 'granted');
        await orient(c, 45, -90, 3);
        const ss = await lastSample(p);
        check('standalone: the same vector the launcher would have sent',
            ss && near(ss.x, -Math.SQRT1_2) && near(ss.y, Math.SQRT1_2) && ss.flat === false, JSON.stringify(ss));
        await p.evaluate(() => Arcade.motion.stop());
        await p.waitForTimeout(100);
        const n = await sampleCount(p);
        await orient(c, 10, 0, 4);
        check('standalone: stop() → silence', (await sampleCount(p)) === n);
        await ctx.close();
    }
    {
        const ctx = await browser.newContext({ hasTouch: true });
        const p = await ctx.newPage();
        await p.goto(BASE + GAME_PATH + '?gid=motion-mute', { waitUntil: 'load' });
        await p.evaluate(() => Arcade.ready);
        const t0 = Date.now();
        const how = await p.evaluate(() => Arcade.motion.start());
        check('standalone: a sensor that never speaks → unavailable in ~1.5 s',
            how === 'unavailable' && Date.now() - t0 < 4000, how);
        await ctx.close();
    }
} catch (e) {
    check('suite ran to completion', false, e && e.stack || String(e));
} finally {
    await browser.close();
    server.close();
}
process.exit(summarize({ style: 'ratio', label: 'motion-acceptance' }));
