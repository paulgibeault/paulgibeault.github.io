/* arcade-motion-core.js — the pure half of motion sensing
 * (plans/motion-sensing-2026-09.md, WP1). DOM-free and clock-free: angles,
 * numbers and plain objects in, the same out, so tools/motion-unit.mjs runs
 * it under node with no browser. arcade-motion-bridge.js is the half that
 * touches the sensor, the dialog and localStorage.
 *
 * THE MATHS. deviceorientation's angles are used rather than devicemotion's
 * acceleration because the platforms disagree about the sign of the latter
 * and agree about the former. With R = Rz(alpha)·Rx(beta)·Ry(gamma) taking
 * device axes to earth axes, gravity in the device's own frame is
 *     (cos β · sin γ,  −sin β,  −cos β · cos γ)
 * — x to the right of the glass, y to its top, z out of it. alpha (the
 * compass heading) never appears: which way is down does not depend on
 * which way is north. Games draw upright on the SCREEN, not the device, so
 * the screen's rotation is then taken out, and y is flipped because a
 * game's y runs down.
 *
 * THE SCREEN ANGLE CONVENTION (the spec's, Android's Surface.ROTATION_* and
 * iOS's window.orientation all agree): angle 90 means the device was turned
 * 90° counter-clockwise — its top points to the player's left — and the
 * content was turned clockwise to compensate. So at angle a the screen's
 * right, in device axes, is (cos a, −sin a) and its up is (sin a, cos a).
 * The hardware probe (motion-probe.html, WP0) exists to confirm this on
 * real phones; the unit tier pins it.
 *
 * The SDK carries its own copy of screenGravity() and the compass (it is a
 * classic script and cannot import); tools/motion-acceptance.mjs drives both
 * from the same orientation and compares the numbers.
 */

const RAD = Math.PI / 180;

// Under this length the screen-plane vector is too short to mean a
// direction: the phone is within ~11.5° of lying flat.
export const FLAT_LENGTH = 0.2;
export const DEFAULT_HZ = 30;
export const MAX_HZ = 60;
// A desktop browser defines DeviceOrientationEvent and never fires it; no
// event within this long of listening means there is no sensor.
export const FIRST_EVENT_TIMEOUT_MS = 1500;

/** window.orientation's −90 and any other stray value → 0 | 90 | 180 | 270. */
export function normalizeScreenAngle(angle) {
    const a = Number(angle);
    if (!isFinite(a)) return 0;
    return (((Math.round(a / 90) * 90) % 360) + 360) % 360;
}

/**
 * Gravity in the axes of the screen — x right, y down, z out of the glass
 * towards the player — from deviceorientation's beta and gamma (degrees) and
 * the screen's rotation. (x, y) has length ≈ 1 held upright in any roll and
 * → 0 lying flat; z is −1 face up on a table. null when the angles are not
 * numbers (some browsers fire one all-null event on a device with no sensor).
 */
export function screenGravity(beta, gamma, screenAngle) {
    if (typeof beta !== 'number' || typeof gamma !== 'number'
            || !isFinite(beta) || !isFinite(gamma)) return null;
    const b = beta * RAD, g = gamma * RAD;
    const a = normalizeScreenAngle(screenAngle) * RAD;
    const dx = Math.cos(b) * Math.sin(g);
    const dy = -Math.sin(b);
    const dz = -Math.cos(b) * Math.cos(g);
    const right = dx * Math.cos(a) - dy * Math.sin(a);
    const up = dx * Math.sin(a) + dy * Math.cos(a);
    // `+ 0` folds −0 into 0 so a sample never prints or compares as −0.
    return { x: right + 0, y: -up + 0, z: dz + 0 };
}

export function isFlat(x, y) {
    return Math.hypot(x, y) < FLAT_LENGTH;
}

/** A game's requested rate → an integer in 1..MAX_HZ (default DEFAULT_HZ). */
export function clampHz(hz) {
    const n = Number(hz);
    if (!isFinite(n) || n <= 0) return DEFAULT_HZ;
    return Math.max(1, Math.min(MAX_HZ, Math.round(n)));
}

/**
 * accept(t) answers whether a sample at time t (ms) should go out at `hz`.
 * A quarter-interval of slack keeps a 60 Hz sensor feeding a 30 Hz stream at
 * a steady every-other-event instead of beating against its own jitter.
 */
export function createThrottle(hz) {
    const interval = 1000 / clampHz(hz);
    let last = -Infinity;
    return {
        accept(t) {
            if (t - last < interval * 0.75) return false;
            last = t;
            return true;
        },
        reset() { last = -Infinity; }
    };
}

/**
 * Quantise a stream of samples to `n` directions with hysteresis and a
 * flat-hold. The ring runs clockwise from screen-right with y down — the
 * sand kernel's own order — so with n = 8 index 2 is straight down and
 * `gx, gy` are exactly what sim.tilt() takes.
 *
 * update(m) answers { dir, gx, gy } when the direction CHANGES and null
 * otherwise. A new direction is taken only once the vector is `margin`
 * degrees past the boundary between two of them, so a hand held on a
 * boundary does not flip a game's world twenty times a second; and a phone
 * lying nearly flat has no "down" worth following, so the last direction
 * holds (leaving the hold takes 1.5× the length that entered it).
 *
 * opts: margin (degrees, default a fifth of a sector), flat (length, default
 * FLAT_LENGTH), start (ring index the follower begins on, null for "none
 * yet"; defaults to straight down when the ring has one).
 */
export function createCompass(n, opts) {
    n = Math.round(Number(n));
    if (!(n >= 2 && n <= 360)) throw new RangeError('compass: n must be 2..360');
    opts = opts || {};
    const sector = 360 / n;
    const margin = (typeof opts.margin === 'number' && opts.margin >= 0)
        ? Math.min(opts.margin, sector / 2) : sector / 5;
    const flat = (typeof opts.flat === 'number' && opts.flat > 0) ? opts.flat : FLAT_LENGTH;
    const startDefault = (n % 4 === 0) ? n / 4 : null;
    const start = (opts.start === null) ? null
        : (typeof opts.start === 'number' && opts.start >= 0 && opts.start < n)
            ? Math.round(opts.start) : startDefault;
    let k = start;
    let held = false;

    function answer(dir) {
        const a = dir * sector * RAD;
        return { dir: dir, gx: Math.round(Math.cos(a)) + 0, gy: Math.round(Math.sin(a)) + 0 };
    }
    return {
        get dir() { return k; },
        get direction() { return k === null ? null : answer(k); },
        reset(dir) { k = (dir === undefined) ? start : dir; held = false; },
        update(m) {
            if (!m || typeof m.x !== 'number' || typeof m.y !== 'number') return null;
            const len = Math.hypot(m.x, m.y);
            if (held ? len < flat * 1.5 : len < flat) { held = true; return null; }
            held = false;
            const angle = Math.atan2(m.y, m.x) / RAD;
            if (k !== null) {
                let off = angle - k * sector;
                off = ((off + 180) % 360 + 360) % 360 - 180;
                if (Math.abs(off) <= sector / 2 + margin) return null;
            }
            const next = ((Math.round(angle / sector) % n) + n) % n;
            if (next === k) return null;
            k = next;
            return answer(k);
        }
    };
}

/**
 * Could this environment have a motion sensor at all? Conservative on
 * purpose: a desktop defines DeviceOrientationEvent and never fires it, and
 * a Tilt control that answers 'unavailable' on tap is worse than one that was
 * never offered — so a touch screen is required too. env is
 * { hasEvent, secure, touch } so the rule is testable without a window.
 */
export function sensorPlausible(env) {
    return !!(env && env.hasEvent && env.secure && env.touch);
}

/* ─── Consent ────────────────────────────────────────────────────────
 * The stored record (arcade.v1._meta.motion, launcher-owned, outside every
 * game's namespace):
 *     { enabled: bool, games: { <gameId>: { allowed: bool, at: ms } } }
 * `enabled` is the master switch (default on). A game has a row only once
 * the player has ANSWERED for it: Allow writes allowed:true, the Motion
 * section's toggle writes either. "Not now" writes nothing — it is not a
 * refusal, and the game may ask again from the player's next tap.
 */
const MAX_GAMES = 200;
const GAME_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export function emptyConsent() {
    return { enabled: true, games: {} };
}

/** Anything (parsed JSON, garbage, null) → a well-formed consent record. */
export function normalizeConsent(raw) {
    const out = emptyConsent();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    if (raw.enabled === false) out.enabled = false;
    const games = raw.games;
    if (games && typeof games === 'object' && !Array.isArray(games)) {
        let count = 0;
        for (const id of Object.keys(games)) {
            if (count >= MAX_GAMES) break;
            const row = games[id];
            if (!GAME_ID_RE.test(id) || !row || typeof row !== 'object') continue;
            if (typeof row.allowed !== 'boolean') continue;
            out.games[id] = {
                allowed: row.allowed,
                at: (typeof row.at === 'number' && isFinite(row.at)) ? row.at : 0
            };
            count++;
        }
    }
    return out;
}

/**
 * What a start() from `gameId` should do, before any sensor is touched:
 *   'off'   — master switch off, or this game's row is Off: answer 'denied'
 *             (available() is already false for it; this is the race)
 *   'allow' — remembered Allow: no dialog
 *   'ask'   — no answer on record: the consent dialog
 */
export function decideStart(consent, gameId) {
    if (!consent.enabled) return 'off';
    const row = consent.games[gameId];
    if (!row) return 'ask';
    return row.allowed ? 'allow' : 'off';
}

/** Is motion offered to this game at all (welcome.motion.enabled)? */
export function enabledFor(consent, gameId) {
    return decideStart(consent, gameId) !== 'off';
}

export function withAnswer(consent, gameId, allowed, now) {
    const next = normalizeConsent(consent);
    if (!GAME_ID_RE.test(gameId)) return next;
    next.games[gameId] = { allowed: !!allowed, at: (typeof now === 'number') ? now : 0 };
    return next;
}

/** Stamp "last used" without changing the answer. */
export function withUse(consent, gameId, now) {
    const next = normalizeConsent(consent);
    const row = next.games[gameId];
    if (row && row.allowed) row.at = now;
    return next;
}

export function withMaster(consent, enabled) {
    const next = normalizeConsent(consent);
    next.enabled = !!enabled;
    return next;
}

/**
 * Shape rules for an inbound arcade:motion.op, in the style of
 * arcade-envelope.js's validators: a clean copy or null, never the caller's
 * object. `start` is an RPC (needs an id); `stop` is fire-and-forget.
 */
export function validateMotionOp(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    if (data.op === 'start') {
        if (typeof data.id !== 'string' || !data.id || data.id.length > 64) return null;
        return { op: 'start', id: data.id, hz: clampHz(data.hz) };
    }
    if (data.op === 'stop') return { op: 'stop' };
    return null;
}
