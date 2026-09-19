/* motion-unit.mjs — hermetic tests for motion sensing
 * (plans/motion-sensing-2026-09.md): arcade-motion-core.js (orientation →
 * screen-frame gravity for all four screen angles, throttle, compass,
 * consent, op validation), the SDK's own copy of the maths pinned against
 * the core, and arcade-motion-bridge.js driven through fake window/document
 * glue (consent dialog, active-only streaming, first-event timeout, a switch
 * flipped mid-stream). Auto-discovered by run-units.mjs.
 *
 * No browser, no network. Run: `node tools/motion-unit.mjs`.
 */
import { readFile } from 'node:fs/promises';
import {
    screenGravity, normalizeScreenAngle, isFlat, clampHz, createThrottle,
    createCompass, sensorPlausible, normalizeConsent, decideStart,
    withAllowed, withMaster, validateMotionOp,
    FLAT_LENGTH, FIRST_EVENT_TIMEOUT_MS
} from '../arcade-motion-core.js';
import { initMotionBridge } from '../arcade-motion-bridge.js';

let pass = 0, fail = 0;
function ok(cond, label) {
    if (cond) { pass++; console.log('  ✓ ' + label); }
    else { fail++; console.log('  ✗ ' + label); }
}
const near = (v, want) => Math.abs(v - want) < 1e-9;
const vec = (g, x, y, z) => g && near(g.x, x) && near(g.y, y) && (z === undefined || near(g.z, z));
const S = Math.SQRT1_2;

console.log('\nscreenGravity — portrait');
ok(vec(screenGravity(90, 0, 0), 0, 1, 0), 'held upright: gravity runs down the screen');
ok(vec(screenGravity(0, 0, 0), 0, 0, -1), 'face up on a table: nothing in the plane, z = −1');
ok(vec(screenGravity(180, 0, 0), 0, 0, 1), 'face down: z = +1');
ok(vec(screenGravity(-90, 0, 0), 0, -1, 0), 'held upside down: gravity runs up the screen');
ok(vec(screenGravity(45, 90, 0), S, S), 'rolled 45° clockwise: down-right');
ok(vec(screenGravity(45, -90, 0), -S, S), 'rolled 45° counter-clockwise: down-left');
ok(vec(screenGravity(0, 90, 0), 1, 0), 'on its right edge: gravity to screen-right');
ok(near(Math.hypot(screenGravity(45, 90, 0).x, screenGravity(45, 90, 0).y), 1),
    'upright in any roll has length 1');
{
    // Near upright the Euler angles are gimbal-noisy (gamma swings wildly
    // for a hair of roll) but the vector is not: cos β ≈ 0 mutes gamma.
    const a = screenGravity(89.9, 80, 0), b = screenGravity(89.9, -80, 0);
    ok(Math.abs(a.x - b.x) < 0.004 && near(a.y, b.y), 'gimbal noise near upright barely moves the vector');
}

console.log('\nscreenGravity — the screen\'s rotation is taken out (spec convention:');
console.log('angle 90 ⇒ device turned counter-clockwise, its top to the player\'s left)');
// Held upright in each landscape, what the DEVICE reports, and the screen
// must still see gravity straight down.
ok(vec(screenGravity(0, -90, 90), 0, 1), 'angle 90: device on its LEFT edge (γ = −90) → down on screen');
ok(vec(screenGravity(0, 90, 270), 0, 1), 'angle 270: device on its RIGHT edge (γ = +90) → down on screen');
ok(vec(screenGravity(-90, 0, 180), 0, 1), 'angle 180: device upside down → down on screen');
ok(vec(screenGravity(0, 90, -90), 0, 1), 'window.orientation −90 is 270');
ok(vec(screenGravity(90, 0, 90), 1, 0), 'angle 90 but device held portrait-upright: gravity to screen-right');
ok(near(screenGravity(30, 20, 90).z, screenGravity(30, 20, 0).z), 'z does not depend on the screen angle');
for (const a of [0, 90, 180, 270]) {
    const g0 = screenGravity(37, -21, 0), g = screenGravity(37, -21, a);
    ok(near(Math.hypot(g.x, g.y), Math.hypot(g0.x, g0.y)), `angle ${a}: a rotation, length preserved`);
}
ok(normalizeScreenAngle(-90) === 270 && normalizeScreenAngle(360) === 0
    && normalizeScreenAngle(91) === 90 && normalizeScreenAngle('x') === 0, 'normalizeScreenAngle folds strays');

console.log('\nscreenGravity — known answers from a real iPhone (tools/fixtures/motion/)');
{
    // Two independent sensors' worth of truth. deviceorientation's angles go
    // through OUR formula; devicemotion's accelerationIncludingGravity is the
    // accelerometer saying where down is with no Euler angles involved. On a
    // still hand they must agree — which checks the formula itself, not just
    // our arithmetic. (iOS reports a.i.g. as gravity itself: aigSign +1.)
    const fx = JSON.parse(await readFile(new URL('./fixtures/motion/ios-safari-18_7-landscapes.json', import.meta.url), 'utf8'));
    let worst = 0;
    for (const [, beta, gamma, , ax, ay, az] of fx.rows) {
        const g = screenGravity(beta, gamma, 0);           // angle 0 ⇒ device axes, y flipped
        const n = Math.hypot(ax, ay, az) * fx.aigSign;
        worst = Math.max(worst, Math.abs(g.x - ax / n), Math.abs(-g.y - ay / n), Math.abs(g.z - az / n));
    }
    ok(worst < 0.08, `the formula agrees with the accelerometer on all ${fx.rows.length} samples (worst axis error ${worst.toFixed(3)})`);
    const land = fx.rows.filter((r) => r[3] === 90).slice(0, 5);
    ok(land.length === 5 && land.every(([, b, g, a]) => { const v = screenGravity(b, g, a); return v.y > 0.95 && Math.abs(v.x) < 0.3; }),
        'ON GLASS: upright in landscape at angle 90 (γ ≈ −84) → gravity runs down the screen');
    ok(land.every(([, b, g]) => screenGravity(b, g, 270).y < -0.95),
        '…and the opposite convention (treating it as 270) would have pointed at the ceiling');
}

console.log('\nscreenGravity — hostile input');
ok(screenGravity(null, null, 0) === null, 'the all-null event a sensorless device fires → null');
ok(screenGravity(NaN, 0, 0) === null && screenGravity(0, Infinity, 0) === null, 'NaN / Infinity → null');
ok(screenGravity('90', 0, 0) === null, 'strings → null');
ok(Object.is(screenGravity(0, 0, 0).x, 0) && Object.is(screenGravity(0, 0, 0).y, 0), 'never −0');
ok(isFlat(0.1, 0.1) && !isFlat(0.2, 0.1) && FLAT_LENGTH === 0.2, 'isFlat at the documented length');

console.log('\nthrottle');
ok(clampHz(undefined) === 30 && clampHz(0) === 30 && clampHz(-5) === 30 && clampHz('x') === 30, 'default 30');
ok(clampHz(1000) === 60 && clampHz(0.2) === 1 && clampHz(15.4) === 15, 'clamped to 1..60, integer');
{
    const th = createThrottle(30);
    let sent = 0;
    for (let i = 0; i < 60; i++) if (th.accept(i * (1000 / 60))) sent++;
    ok(sent === 30, `a 60 Hz sensor feeds a 30 Hz stream every other event (${sent}/60)`);
    const jitter = createThrottle(30);
    let s2 = 0;
    for (let i = 0; i < 300; i++) if (jitter.accept(i * 16.67 + ((i * 7) % 5) - 2)) s2++;
    ok(s2 >= 140 && s2 <= 160, `steady under ±2 ms jitter (${s2}/300)`);
    const slow = createThrottle(60);
    let s3 = 0;
    for (let i = 0; i < 10; i++) if (slow.accept(i * 100)) s3++;
    ok(s3 === 10, 'a sensor slower than hz passes every event');
    th.reset();
    ok(th.accept(0) === true, 'reset re-arms');
}

console.log('\ncompass(8) — the sand kernel\'s ring, hysteresis, flat-hold');
{
    const at = (deg, len = 1) => ({ x: len * Math.cos(deg * Math.PI / 180), y: len * Math.sin(deg * Math.PI / 180) });
    const c = createCompass(8, { margin: 8 });
    ok(c.dir === 2 && c.direction.gx === 0 && c.direction.gy === 1, 'starts straight down (index 2)');
    ok(c.update(at(90)) === null, 'already down: no answer');
    ok(c.update(at(70)) === null, '20° off: still down');
    ok(c.update(at(62)) === null, '28° off: inside the margin past 22.5°');
    const r = c.update(at(58));
    ok(r && r.dir === 1 && r.gx === 1 && r.gy === 1, '32° off: down-right now');
    ok(c.update(at(64)) === null, 'and it does not flip straight back');
    const d = c.update(at(80));
    ok(d && d.dir === 2, 'well back towards down');
    const l = c.update(at(180));
    ok(l && l.gx === -1 && l.gy === 0, 'left');
    const u = c.update(at(-90));
    ok(u && u.gx === 0 && u.gy === -1 && u.dir === 6, 'across the ±180 seam to up');
    ok(c.update(at(10, 0.1)) === null && c.dir === 6, 'lying flat: the last direction holds');
    ok(c.update(at(0, 0.25)) === null, 'leaving the hold takes 1.5× the length that entered it');
    const back = c.update(at(0, 0.35));
    ok(back && back.dir === 0 && back.gx === 1 && back.gy === 0, 'clearly tilted again: follows');
    c.reset();
    ok(c.dir === 2, 'reset → start');
    const ring = [];
    for (let k = 0; k < 8; k++) { const cc = createCompass(8, { start: null }); ring.push(cc.update(at(k * 45))); }
    ok(JSON.stringify(ring.map((a) => [a.gx, a.gy]))
        === '[[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1]]',
        'ring order is clockwise from screen-right, y down — what sim.tilt() takes');
}
{
    const c4 = createCompass(4);
    ok(c4.dir === 1, 'compass(4) starts down (index 1)');
    const r = c4.update({ x: 1, y: 0.1 });
    ok(r && r.dir === 0 && r.gx === 1 && r.gy === 0, 'compass(4): right');
    const c3 = createCompass(3);
    ok(c3.dir === null, 'a ring with no straight-down starts with no direction');
    ok(c3.update({ x: 0, y: 1 }) !== null, '…and answers the first real sample');
    let threw = false;
    try { createCompass(1); } catch (e) { threw = e instanceof RangeError; }
    ok(threw, 'n < 2 is a RangeError');
    ok(createCompass(8).update(null) === null && createCompass(8).update({ x: 'a' }) === null, 'garbage samples → null');
}

console.log('\nthe SDK\'s copy of the maths is the core\'s');
{
    const sdk = await readFile(new URL('../arcade-sdk.js', import.meta.url), 'utf8');
    const m = sdk.match(/\/\/ arcade:motion-maths-begin\n([\s\S]*?)\/\/ arcade:motion-maths-end/);
    ok(!!m, 'arcade-sdk.js carries the marked maths block');
    const mod = m && new Function(m[1] + '\nreturn { g: motionScreenGravity, c: motionCreateCompass, flat: MOTION_FLAT };')();
    ok(mod && mod.flat === FLAT_LENGTH, 'same flat length');
    let same = true, n = 0;
    for (let b = -180; b <= 180; b += 15) for (let g = -90; g <= 90; g += 15) for (const a of [0, 90, 180, 270, -90]) {
        const p = screenGravity(b, g, a), q = mod.g(b, g, a);
        n++;
        if (!(p.x === q.x && p.y === q.y && p.z === q.z)) same = false;
    }
    ok(same, `screenGravity bit-identical over ${n} orientations`);
    ok(mod.g(null, 0, 0) === null, 'same null rule');
    let sameC = true;
    const A = createCompass(8), B = mod.c(8);
    for (let i = 0; i < 2000; i++) {
        const deg = (i * 37) % 360, len = ((i * 13) % 10) / 9;
        const s = { x: len * Math.cos(deg * Math.PI / 180), y: len * Math.sin(deg * Math.PI / 180) };
        if (JSON.stringify(A.update(s)) !== JSON.stringify(B.update(s))) sameC = false;
    }
    ok(sameC, 'compass(8) answers identically over a 2000-sample walk');
}

console.log('\nsensorPlausible');
ok(sensorPlausible({ hasEvent: true, secure: true, touch: true }), 'a phone');
ok(!sensorPlausible({ hasEvent: true, secure: true, touch: false }), 'a desktop defines the event and has no touch → not offered');
ok(!sensorPlausible({ hasEvent: true, secure: false, touch: true }), 'insecure context');
ok(!sensorPlausible({ hasEvent: false, secure: true, touch: true }) && !sensorPlausible(null), 'no event / no env');

console.log('\nconsent — one switch for the whole fleet');
{
    const c0 = normalizeConsent(null);
    ok(c0.enabled === true && c0.asked === false, 'default: switch on (so a tilt control can be discovered), never asked');
    ok(decideStart(c0) === 'ask', 'never asked → the one-time dialog');
    const c1 = withAllowed(c0);
    ok(decideStart(c1) === 'allow' && decideStart(c0) === 'ask', 'Allow is remembered (and the input untouched)');
    const c2 = withMaster(c1, false);
    ok(decideStart(c2) === 'off' && c2.asked === true, 'switch off: denied without a dialog');
    ok(decideStart(withMaster(c2, true)) === 'allow', 'switch back on re-arms the dialog-free path');
    ok(decideStart(withMaster(withMaster(c0, false), true)) === 'allow', 'turning the switch ON yourself is saying yes: no dialog after');
    ok(normalizeConsent({ enabled: true, games: { a: { allowed: false }, b: { allowed: true, at: 5 } } }).asked === true
        && normalizeConsent({ enabled: false, games: { a: { allowed: false } } }).asked === false,
        'the older per-game record migrates: any game allowed ⇒ asked');
    const dirty = normalizeConsent({ enabled: 'no', asked: 'yes', junk: 1 });
    ok(dirty.enabled === true && dirty.asked === false && Object.keys(dirty).length === 2, 'normalizeConsent keeps only well-formed fields');
    ok(normalizeConsent([1, 2]).enabled === true && normalizeConsent('x').enabled === true, 'garbage → defaults');
}

console.log('\nvalidateMotionOp');
ok(JSON.stringify(validateMotionOp({ op: 'start', id: 'r1', hz: 500, extra: 1 })) === '{"op":"start","id":"r1","hz":60}', 'start: clean copy, hz clamped');
ok(validateMotionOp({ op: 'start', hz: 30 }) === null && validateMotionOp({ op: 'start', id: 7 }) === null
    && validateMotionOp({ op: 'start', id: 'x'.repeat(65) }) === null, 'start needs a sane string id');
ok(JSON.stringify(validateMotionOp({ op: 'stop', id: 'ignored' })) === '{"op":"stop"}', 'stop: fire-and-forget');
ok(validateMotionOp({ op: 'sample' }) === null && validateMotionOp(null) === null && validateMotionOp([]) === null, 'anything else → null');

/* ─── the bridge, through fakes ─────────────────────────────────────── */
function makeWorld(opts) {
    opts = opts || {};
    const handlers = {};
    const data = {};
    const world = {
        posts: [], dialogs: [], toasts: [], active: 'tilt-game', dialogAnswer: true,
        poolListeners: [],
        win: {
            DeviceOrientationEvent: opts.noEvent ? undefined : function () {},
            isSecureContext: true,
            screen: { orientation: { angle: 0 } },
            performance: { now: () => 0 },
            matchMedia: () => ({ matches: false }),
            addEventListener: (t, fn) => { (handlers[t] = handlers[t] || []).push(fn); },
            removeEventListener: (t, fn) => { handlers[t] = (handlers[t] || []).filter((f) => f !== fn); }
        },
        doc: { hidden: false, addEventListener: (t, fn) => { (handlers['doc:' + t] = handlers['doc:' + t] || []).push(fn); }, createElement: () => ({}) },
        nav: { maxTouchPoints: opts.noTouch ? 0 : 5 },
        store: { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); } },
        listenerCount: () => (handlers.deviceorientation || []).length,
        orient: (beta, gamma, t) => (handlers.deviceorientation || []).slice().forEach((fn) => fn({ beta, gamma, timeStamp: t })),
        setHidden: (h) => { world.doc.hidden = h; (handlers['doc:visibilitychange'] || []).forEach((fn) => fn()); },
        setActive: (gid) => { world.active = gid; world.poolListeners.forEach((fn) => fn()); },
        fire: (type, e) => (handlers[type] || []).slice().forEach((fn) => fn(e)),
        samples: (gid) => world.posts.filter((p) => p[0] === gid && p[1].type === 'arcade:motion.sample'),
        result: (id) => { const p = world.posts.find((q) => q[1].type === 'arcade:bridge.result' && q[1].id === id); return p ? p[1].value : undefined; },
        consent: () => JSON.parse(data['arcade.v1._meta.motion'] || 'null')
    };
    if (opts.ios) {
        world.permissionCalls = 0;
        world.win.DeviceOrientationEvent.requestPermission = () => {
            world.permissionCalls++;
            return Promise.resolve(opts.ios);
        };
    }
    world.bridge = initMotionBridge({
        env: { window: world.win, document: world.doc, navigator: world.nav, localStorage: world.store },
        postToIframe: (gid, msg) => world.posts.push([gid, msg]),
        dialog: (o) => {
            world.dialogs.push(o);
            if (world.dialogAnswer === true && o.onOk) o.onOk();
            return Promise.resolve(world.dialogAnswer);
        },
        showToast: (msg, o) => world.toasts.push([msg, o]),
        getActiveGameId: () => world.active,
        getMountedGameIds: () => ['tilt-game', 'never-asked'],
        getGameName: (gid) => (gid === 'tilt-game' ? 'Tilt Game' : gid),
        onPoolChanged: (fn) => world.poolListeners.push(fn),
        onChange: () => { world.renders = (world.renders || 0) + 1; }
    });
    return world;
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));
// Let the bridge reach "listening, waiting for its first event", then feed one.
async function startAndFeed(w, gid, id, hz) {
    w.bridge.motionOp(gid, { op: 'start', id, hz });
    await tick(5);
    w.orient(90, 0, 1);
    await tick(5);
}

console.log('\nbridge — consent, then a stream');
{
    const w = makeWorld();
    ok(w.bridge.enabledFor('tilt-game') === true, 'a phone, no history: motion is offered');
    ok(w.listenerCount() === 0, 'idle: the sensor is not listened to');
    await startAndFeed(w, 'tilt-game', 'r1', 30);
    ok(w.dialogs.length === 1 && /“Tilt Game” would like to use your device’s motion/.test(w.dialogs[0].message)
        && w.dialogs[0].okLabel === 'Allow' && w.dialogs[0].cancelLabel === 'Not now',
        'first start raises the attributed dialog: Allow / Not now');
    ok(/every game in the arcade/.test(w.dialogs[0].message) && /Settings row/.test(w.dialogs[0].message),
        '…which says it is for the whole arcade, and where to change it later');
    ok(w.result('r1') === 'granted', 'Allow + a first event → granted');
    ok(w.consent().asked === true && w.consent().enabled === true && !('games' in w.consent()), 'the answer is remembered — once, for the fleet');
    ok(w.listenerCount() === 1, 'exactly one listener while streaming');
    w.orient(90, 0, 100);
    const s = w.samples('tilt-game');
    ok(s.length >= 1 && s[s.length - 1][1].x === 0 && s[s.length - 1][1].y === 1 && s[s.length - 1][1].z === 0
        && typeof s[s.length - 1][1].t === 'number', 'samples carry { x, y, z, t } in screen axes');
    w.win.screen.orientation.angle = 90;
    w.orient(0, -90, 200);
    ok(w.samples('tilt-game').slice(-1)[0][1].y === 1, 'the screen angle is read per event');
    w.win.screen.orientation.angle = 0;
    const before = w.samples('tilt-game').length;
    for (let i = 0; i < 60; i++) w.orient(90, 0, 1000 + i * (1000 / 60));
    ok(w.samples('tilt-game').length - before === 30, 'throttled to the requested 30 Hz');
    w.orient(null, null, 5000);
    ok(w.samples('tilt-game').length - before === 30, 'an all-null event sends nothing');

    // dialog-free next time
    w.bridge.motionOp('tilt-game', { op: 'stop' });
    ok(w.listenerCount() === 0, 'stop: the listener is removed');
    w.bridge.motionOp('tilt-game', { op: 'start', id: 'r2', hz: 30 });
    await tick(5);
    ok(w.dialogs.length === 1 && w.result('r2') === 'granted', 'a remembered Allow starts without a dialog (sensor already seen: at once)');

    // active app only
    const n0 = w.samples('tilt-game').length;
    w.setActive('other-game');
    ok(w.listenerCount() === 0, 'another app becomes active: the listener is removed');
    w.orient(90, 0, 9000);
    ok(w.samples('tilt-game').length === n0 && w.samples('other-game').length === 0, '…and nobody receives samples');
    w.setActive('tilt-game');
    ok(w.listenerCount() === 1, 'back to the started game: listening again, no new start needed');
    w.setHidden(true);
    ok(w.listenerCount() === 0, 'page hidden: not listening');
    w.setHidden(false);
    ok(w.listenerCount() === 1, 'page visible: listening');

    // a background frame may not start (it could be raising the dialog)
    w.bridge.motionOp('other-game', { op: 'start', id: 'r3', hz: 30 });
    await tick(5);
    ok(w.result('r3') === 'denied' && w.dialogs.length === 1, 'a background frame\'s start → denied, no dialog');
    // …but once active, a SECOND game needs no dialog of its own
    w.setActive('other-game');
    w.bridge.motionOp('other-game', { op: 'start', id: 'r4', hz: 30 });
    await tick(5);
    ok(w.result('r4') === 'granted' && w.dialogs.length === 1, 'a second game, now active: granted with no dialog — consent is the fleet\'s');
    w.setActive('tilt-game');

}

console.log('\nbridge — the switch flipped mid-stream stops it at once');
{
    const w = makeWorld();
    await startAndFeed(w, 'tilt-game', 'r1', 60);
    ok(w.result('r1') === 'granted' && w.listenerCount() === 1, '(stream up)');
    ok(w.bridge.isEnabled() === true && w.bridge.plausible() === true, 'isEnabled() / plausible() feed the Settings row');
    w.posts.length = 0;
    w.bridge.setEnabled(false);
    ok(w.listenerCount() === 0 && w.bridge.snapshot().started.length === 0, 'switch off: the listener is gone, every stream ended');
    ok(['tilt-game', 'never-asked'].every((g) => w.posts.some((p) => p[0] === g && p[1].type === 'arcade:motion.state' && p[1].enabled === false)),
        'every mounted frame is told (arcade:motion.state enabled:false → available() false), including one that never asked');
    w.orient(90, 0, 50000);
    ok(w.samples('tilt-game').length === 0, 'no sample after the flip');
    ok(w.bridge.enabledFor('tilt-game') === false && w.bridge.enabledFor('never-asked') === false, 'offered to nobody while off');
    w.bridge.motionOp('tilt-game', { op: 'start', id: 'r2', hz: 30 });
    await tick(5);
    ok(w.result('r2') === 'denied' && w.dialogs.length === 1, 'start while off → denied without a dialog');
    w.posts.length = 0;
    w.bridge.setEnabled(true);
    ok(w.bridge.enabledFor('tilt-game') === true && w.posts.some((p) => p[1].type === 'arcade:motion.state' && p[1].enabled === true), 'switch on: offered again, frames told');
    ok((w.renders || 0) > 0, 'the host is asked to re-render the switch');
    // flipped in ANOTHER launcher tab: the storage event runs the same path
    w.store.setItem('arcade.v1._meta.motion', JSON.stringify({ enabled: false, asked: true }));
    w.fire('storage', { key: 'arcade.v1._meta.motion' });
    ok(w.bridge.enabledFor('tilt-game') === false, 'a flip in another tab lands here too');
    w.fire('storage', { key: 'some.other.key' });
    ok(true, 'unrelated storage events are ignored');

    const fresh = makeWorld();
    fresh.bridge.setEnabled(false); fresh.bridge.setEnabled(true);
    await startAndFeed(fresh, 'tilt-game', 'r1', 30);
    ok(fresh.result('r1') === 'granted' && fresh.dialogs.length === 0, 'a player who turned the switch on themselves is never shown the dialog');
    const ios = makeWorld({ ios: 'granted' });
    ios.bridge.setEnabled(false); ios.bridge.setEnabled(true);
    ok(ios.permissionCalls === 1, 'on iOS, turning the switch on IS the gesture: requestPermission() is called in it');
}

console.log('\nbridge — Not now, eviction, unavailable');
{
    const w = makeWorld();
    w.dialogAnswer = null;
    w.bridge.motionOp('tilt-game', { op: 'start', id: 'r1', hz: 30 });
    await tick(5);
    ok(w.result('r1') === 'denied' && w.consent() === null, '"Not now" → denied and NOTHING is remembered');
    ok(w.listenerCount() === 0, '…and the sensor was never touched');
    w.bridge.motionOp('tilt-game', { op: 'start', id: 'r2', hz: 30 });
    await tick(5);
    ok(w.dialogs.length === 2, 'the game may ask again from the next tap');

    w.dialogAnswer = true;
    await startAndFeed(w, 'tilt-game', 'r3', 30);
    ok(w.result('r3') === 'granted', '(allowed this time)');
    w.bridge.clearGame('tilt-game');
    ok(w.listenerCount() === 0 && w.bridge.snapshot().started.length === 0, 'an evicted frame\'s stream dies with it');
    w.bridge.motionOp('tilt-game', { bogus: true });
    w.bridge.motionOp('tilt-game', { op: 'start' });
    ok(w.bridge.snapshot().started.length === 0, 'malformed ops are dropped');
}
{
    const desk = makeWorld({ noTouch: true });
    ok(desk.bridge.enabledFor('tilt-game') === false, 'a desktop (no touch): not offered');
    desk.bridge.motionOp('tilt-game', { op: 'start', id: 'r1', hz: 30 });
    await tick(5);
    ok(desk.result('r1') === 'unavailable' && desk.dialogs.length === 0, '…and a start answers unavailable, no dialog');
    const none = makeWorld({ noEvent: true });
    none.bridge.motionOp('tilt-game', { op: 'start', id: 'r1', hz: 30 });
    await tick(5);
    ok(none.result('r1') === 'unavailable', 'no DeviceOrientationEvent → unavailable');

    const mute = makeWorld();
    mute.bridge.motionOp('tilt-game', { op: 'start', id: 'r1', hz: 30 });
    await tick(20);
    ok(mute.result('r1') === undefined && mute.listenerCount() === 1, 'a touch device with a silent sensor: listening, waiting');
    mute.orient(null, null, 5);
    await tick(FIRST_EVENT_TIMEOUT_MS + 100);
    ok(mute.result('r1') === 'unavailable', `no real event within ${FIRST_EVENT_TIMEOUT_MS} ms → unavailable`);
    ok(mute.listenerCount() === 0 && mute.bridge.snapshot().started.length === 0, '…and the listener is released');
}

console.log('\nbridge — iOS permission');
{
    const w = makeWorld({ ios: 'granted' });
    await startAndFeed(w, 'tilt-game', 'r1', 30);
    ok(w.permissionCalls === 1 && w.result('r1') === 'granted', 'Allow\'s click calls requestPermission() (synchronously, via onOk)');
    w.bridge.motionOp('tilt-game', { op: 'stop' });
    w.bridge.motionOp('tilt-game', { op: 'start', id: 'r2', hz: 30 });
    await tick(5);
    ok(w.permissionCalls === 1 && w.result('r2') === 'granted', 'granted once per page load — not asked again');

    const no = makeWorld({ ios: 'denied' });
    no.bridge.motionOp('tilt-game', { op: 'start', id: 'r1', hz: 30 });
    await tick(5);
    ok(no.result('r1') === 'denied' && no.consent() === null, 'iOS says no → denied, and the launcher remembers nothing');

    // A remembered Allow on a fresh page load where Safari wants a gesture.
    const again = makeWorld({ ios: 'granted' });
    again.store.setItem('arcade.v1._meta.motion', JSON.stringify(withAllowed(normalizeConsent(null))));
    let gestureless = true;
    again.win.DeviceOrientationEvent.requestPermission = () => {
        again.permissionCalls++;
        if (gestureless) return Promise.reject(new Error('NotAllowedError'));
        return Promise.resolve('granted');
    };
    again.bridge.motionOp('tilt-game', { op: 'start', id: 'r1', hz: 30 });
    await tick(5);
    ok(again.dialogs.length === 0 && again.toasts.length === 1 && /Tap to enable motion for Tilt Game/.test(again.toasts[0][0]),
        'remembered Allow + gesture needed → a one-tap toast, not the full dialog');
    gestureless = false;
    again.toasts[0][1].onClick();
    await tick(5);
    again.orient(90, 0, 1);
    await tick(5);
    ok(again.result('r1') === 'granted', 'the toast\'s tap is the gesture → granted');
}

console.log('');
if (fail) { console.log(fail + ' check(s) FAILED.'); process.exit(1); }
console.log('All ' + pass + ' motion checks passed.');
