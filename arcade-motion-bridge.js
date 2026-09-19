/* arcade-motion-bridge.js — the launcher owns the sensor and the consent
 * (plans/motion-sensing-2026-09.md, WP2; cap 'motion.bridge').
 *
 * A game frame is sandboxed with no accelerometer/gyroscope in its `allow`
 * list, so it gets no deviceorientation events at all. Motion is BROKERED
 * instead of delegated: the frame asks (arcade:motion.op), the player
 * answers once per game in a launcher dialog, and from then on the launcher
 * streams one small sample — gravity in the axes of the screen — to the
 * ACTIVE frame only (arcade:motion.sample). Delegating the sensors would let
 * any game read them silently on Android; motion is a known side channel
 * (tap inference, fingerprinting), and "a game gets what the launcher hands
 * it" has no other exception.
 *
 * Trust model, same as arcade-ui-bridge.js: the router's single 'message'
 * listener owns frame identity and hands each authenticated message here as
 * (gameId, data); shape rules are validateMotionOp in arcade-motion-core.js;
 * the dialog is attributed with the app's catalog name; only the ACTIVE
 * frame may raise it — a background frame's start() answers 'denied'.
 *
 * Cost model: ONE top-level deviceorientation listener for the whole
 * launcher, attached only while the active game has started (and the page
 * is visible), removed otherwise. Never one per game.
 *
 * initMotionBridge(host) — host supplies launcher-owned glue:
 *   postToIframe(gameId, msg), dialog(opts) [opts.onOk runs synchronously in
 *   the OK click — the gesture iOS's requestPermission() needs], showToast,
 *   getActiveGameId(), getMountedGameIds(), getGameName(gameId) [catalog
 *   name], onPoolChanged(fn),
 *   openSettings() [open the menu], and `els`
 *   { section, master, masterLabel, list, mark } for the menu section and the
 *   top-bar mark. `env` (optional) overrides window/document/navigator/
 *   localStorage for tests.
 */
import { KEY_PREFIX } from './arcade-storage-core.js';
import {
    screenGravity, createThrottle, sensorPlausible, validateMotionOp,
    normalizeConsent, decideStart, enabledFor, withAnswer, withMaster,
    FIRST_EVENT_TIMEOUT_MS
} from './arcade-motion-core.js';

const CONSENT_KEY = KEY_PREFIX + '_meta.motion';
// How long a remembered Allow waits for the one-tap "Enable motion" toast
// (iOS only, and only if Safari wants a fresh gesture this page load).
const REGRANT_TIMEOUT_MS = 8000;

export function initMotionBridge(host) {
    const env = host.env || {};
    const win = env.window || window;
    const doc = env.document || document;
    const nav = env.navigator || navigator;
    const store = env.localStorage || localStorage;
    const els = host.els || {};

    // gameId → { throttle } for every frame between its start and its stop.
    const started = new Map();
    let listening = false;
    // Has a real sample (numeric angles) arrived this page load? Until one
    // has, a start() waits up to FIRST_EVENT_TIMEOUT_MS before answering.
    let sensorSeen = false;
    let firstWaiters = [];
    // iOS: what requestPermission() last said this page load.
    let permission = 'unknown';

    function plausible() {
        let touch = false;
        try {
            touch = (nav.maxTouchPoints > 0)
                || !!(win.matchMedia && win.matchMedia('(pointer: coarse)').matches);
        } catch (e) {}
        return sensorPlausible({
            hasEvent: typeof win.DeviceOrientationEvent !== 'undefined',
            secure: win.isSecureContext !== false,
            touch: touch
        });
    }

    function readConsent() {
        try { return normalizeConsent(JSON.parse(store.getItem(CONSENT_KEY))); }
        catch (e) { return normalizeConsent(null); }
    }
    function writeConsent(consent) {
        try { store.setItem(CONSENT_KEY, JSON.stringify(consent)); } catch (e) {}
    }

    function isEnabledFor(gameId) {
        return plausible() && enabledFor(readConsent(), gameId);
    }

    function reply(gameId, id, value) {
        host.postToIframe(gameId, { type: 'arcade:bridge.result', id: id, ok: true, value: value });
    }

    function screenAngle() {
        try {
            const so = win.screen && win.screen.orientation;
            if (so && typeof so.angle === 'number') return so.angle;
            if (typeof win.orientation === 'number') return win.orientation; // older iOS
        } catch (e) {}
        return 0;
    }

    function round4(v) { return Math.round(v * 1e4) / 1e4; }

    function onOrientation(e) {
        const g = screenGravity(e.beta, e.gamma, screenAngle());
        if (!g) return;
        if (!sensorSeen) {
            sensorSeen = true;
            const waiters = firstWaiters; firstWaiters = [];
            waiters.forEach((fn) => fn(true));
        }
        const active = host.getActiveGameId();
        const s = active && started.get(active);
        if (!s || doc.hidden) return;
        const t = (typeof e.timeStamp === 'number' && e.timeStamp > 0)
            ? e.timeStamp : win.performance.now();
        if (!s.throttle.accept(t)) return;
        host.postToIframe(active, {
            type: 'arcade:motion.sample',
            x: round4(g.x), y: round4(g.y), z: round4(g.z), t: Math.round(t)
        });
    }

    // Listen exactly when someone can use it: the active game has started
    // (or a start is waiting on its first event) and the page is visible.
    function reevaluate() {
        const active = host.getActiveGameId();
        const want = !doc.hidden
            && ((!!active && started.has(active)) || firstWaiters.length > 0);
        if (want && !listening) {
            win.addEventListener('deviceorientation', onOrientation);
            listening = true;
        } else if (!want && listening) {
            win.removeEventListener('deviceorientation', onOrientation);
            listening = false;
        }
        render();
    }

    function waitForFirstEvent() {
        if (sensorSeen) return Promise.resolve(true);
        return new Promise((resolve) => {
            let done = false;
            const finish = (ok) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                firstWaiters = firstWaiters.filter((fn) => fn !== finish);
                resolve(ok);
            };
            const timer = setTimeout(() => finish(false), FIRST_EVENT_TIMEOUT_MS);
            firstWaiters.push(finish);
            reevaluate();
        });
    }

    function needsPermissionCall() {
        const E = win.DeviceOrientationEvent;
        return !!(E && typeof E.requestPermission === 'function') && permission !== 'granted';
    }
    function requestPermission() {
        let p;
        try { p = win.DeviceOrientationEvent.requestPermission(); }
        catch (e) { p = Promise.reject(e); }
        return Promise.resolve(p).then((r) => {
            permission = (r === 'granted') ? 'granted' : 'denied';
            return permission;
        });
    }

    // A remembered Allow on iOS: try without a gesture first (Safari keeps a
    // grant for the browsing session); if it wants a fresh gesture, the full
    // dialog would be nagging — a one-tap toast is the gesture instead.
    function regrant(gameId) {
        return requestPermission().catch(() => new Promise((resolve) => {
            let done = false;
            const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
            const timer = setTimeout(() => finish('denied'), REGRANT_TIMEOUT_MS);
            host.showToast('Tap to enable motion for ' + (host.getGameName(gameId) || gameId), {
                duration: REGRANT_TIMEOUT_MS,
                onClick: () => { requestPermission().then(finish, () => finish('denied')); }
            });
        }));
    }

    async function opStart(gameId, op) {
        if (!plausible()) return reply(gameId, op.id, 'unavailable');
        // Anything that interrupts belongs to the active app only.
        if (host.getActiveGameId() !== gameId) return reply(gameId, op.id, 'denied');
        const decision = decideStart(readConsent(), gameId);
        if (decision === 'off') return reply(gameId, op.id, 'denied');

        if (decision === 'ask') {
            let asked = null;
            const name = host.getGameName(gameId) || gameId;
            const answer = await host.dialog({
                message: '“' + name + '” would like to use your device’s motion.\n\n'
                    + 'You can turn this off any time in Menu → Motion.',
                okLabel: 'Allow',
                cancelLabel: 'Not now',
                // Synchronous in the click: the top-level gesture iOS wants.
                onOk: () => { if (needsPermissionCall()) asked = requestPermission().catch(() => 'denied'); }
            });
            // "Not now" is not a refusal — nothing is remembered.
            if (answer === null) return reply(gameId, op.id, 'denied');
            if (asked && (await asked) !== 'granted') return reply(gameId, op.id, 'denied');
            writeConsent(withAnswer(readConsent(), gameId, true, Date.now()));
            notifyGame(gameId);
        } else if (needsPermissionCall()) {
            if ((await regrant(gameId)) !== 'granted') return reply(gameId, op.id, 'denied');
        }

        // The dialog took human time: re-check everything it could outlive.
        if (host.getActiveGameId() !== gameId
                || decideStart(readConsent(), gameId) !== 'allow') {
            return reply(gameId, op.id, 'denied');
        }
        started.set(gameId, { throttle: createThrottle(op.hz) });
        reevaluate();
        if (!(await waitForFirstEvent())) {
            started.delete(gameId);
            reevaluate();
            return reply(gameId, op.id, 'unavailable');
        }
        if (!started.has(gameId)) return reply(gameId, op.id, 'denied'); // stopped or switched off meanwhile
        reevaluate();
        reply(gameId, op.id, 'granted');
    }

    function dispatch(gameId, data) {
        const op = validateMotionOp(data);
        if (!op) return;
        if (op.op === 'start') opStart(gameId, op);
        else if (started.delete(gameId)) reevaluate();
    }

    // Tell one frame whether motion is offered to it. The SDK turns a false
    // into available() === false and an ended stream.
    function notifyGame(gameId) {
        host.postToIframe(gameId, { type: 'arcade:motion.state', enabled: isEnabledFor(gameId) });
    }

    // A switch flipped (here or in another launcher tab): stop what is no
    // longer allowed AT ONCE, then tell every frame that could care.
    function consentChanged() {
        const consent = readConsent();
        // Every mounted frame: the master switch changes available() even
        // for a game that has never asked.
        const ids = new Set([...started.keys(), ...Object.keys(consent.games),
            ...(host.getMountedGameIds ? host.getMountedGameIds() : [])]);
        const active = host.getActiveGameId();
        if (active) ids.add(active);
        for (const gid of started.keys()) {
            if (!enabledFor(consent, gid)) started.delete(gid);
        }
        ids.forEach(notifyGame);
        reevaluate();
    }

    function setMaster(enabled) {
        writeConsent(withMaster(readConsent(), enabled));
        consentChanged();
    }
    function setGame(gameId, allowed) {
        writeConsent(withAnswer(readConsent(), gameId, allowed, Date.now()));
        consentChanged();
    }

    // ─── The Motion section + the top-bar mark ─────────────────────────
    let scrollTarget = null;
    const rows = new Map(); // gameId → its switch button
    function render() {
        const consent = readConsent();
        const active = host.getActiveGameId();
        const streaming = !!active && started.has(active) && listening;
        if (els.mark) {
            els.mark.hidden = !streaming;
            if (streaming) {
                const label = (host.getGameName(active) || 'This game')
                    + ' is using motion — tap to change';
                els.mark.title = label;
                els.mark.setAttribute('aria-label', label);
            }
        }
        if (!els.section) return;
        const ids = Object.keys(consent.games);
        // A device with no sensor and no history has nothing to show here.
        els.section.hidden = !plausible() && ids.length === 0;
        if (els.master) {
            els.master.setAttribute('aria-checked', consent.enabled ? 'true' : 'false');
            if (els.masterLabel) els.masterLabel.textContent = consent.enabled ? 'Motion On' : 'Motion Off';
        }
        if (!els.list) return;
        // Rows are updated IN PLACE, never rebuilt: a rebuilt row is detached
        // mid-click, and the menu's outside-click closer then reads the tap
        // as "outside" and shuts the menu under the player's finger.
        ids.sort((a, b) => (host.getGameName(a) || a).localeCompare(host.getGameName(b) || b));
        for (const [gid, btn] of rows) {
            if (!consent.games[gid]) { btn.remove(); rows.delete(gid); }
        }
        for (const gid of ids) {
            const row = consent.games[gid];
            let btn = rows.get(gid);
            if (!btn) {
                btn = doc.createElement('button');
                btn.type = 'button';
                btn.className = 'launcher-menu__item launcher-menu__item--sub';
                btn.setAttribute('role', 'switch');
                btn.setAttribute('data-menu-stay', '');
                btn.setAttribute('data-motion-game', gid);
                const name = doc.createElement('span');
                name.className = 'launcher-menu__item-label';
                const tag = doc.createElement('span');
                tag.className = 'launcher-menu__item-tag';
                btn.appendChild(name);
                btn.appendChild(tag);
                btn.addEventListener('click', () => {
                    const now = readConsent().games[gid];
                    setGame(gid, !(now && now.allowed));
                });
                rows.set(gid, btn);
            }
            btn.setAttribute('aria-checked', row.allowed ? 'true' : 'false');
            btn.disabled = !consent.enabled;
            btn.firstChild.textContent = host.getGameName(gid) || gid;
            btn.lastChild.textContent = row.allowed ? 'Allowed' : 'Off';
            btn.title = row.allowed
                ? 'Motion allowed for this game. Tap to turn off.'
                : 'Motion off for this game. Tap to allow.';
            els.list.appendChild(btn); // (re)append in sorted order; a no-op move when already there
            if (scrollTarget === gid) {
                scrollTarget = null;
                try { btn.scrollIntoView({ block: 'nearest' }); btn.focus(); } catch (e) {}
            }
        }
    }

    if (els.master) {
        els.master.addEventListener('click', () => setMaster(!readConsent().enabled));
    }
    if (els.mark) {
        els.mark.addEventListener('click', (e) => {
            e.stopPropagation(); // the menu's outside-click closer must not see this
            scrollTarget = host.getActiveGameId();
            if (host.openSettings) host.openSettings();
            render();
        });
    }

    doc.addEventListener('visibilitychange', reevaluate);
    if (host.onPoolChanged) host.onPoolChanged(reevaluate);
    // Another launcher tab flipped a switch.
    win.addEventListener('storage', (e) => { if (e.key === CONSENT_KEY) consentChanged(); });
    render();

    return {
        motionOp: dispatch,
        enabledFor: isEnabledFor,
        // A frame evicted or reloaded: its stream dies with it; a fresh mount
        // must start() again (dialog-free once allowed).
        clearGame: (gameId) => { if (started.delete(gameId)) reevaluate(); },
        // For tests and the diag view.
        snapshot: () => ({
            listening: listening, sensorSeen: sensorSeen, permission: permission,
            started: [...started.keys()], consent: readConsent()
        })
    };
}
