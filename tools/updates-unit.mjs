/* updates-unit.mjs — hermetic Node unit tests for arcade-updates.js, the
 * launcher's origin-wide service-worker update control.
 *
 * No browser, no network, no real service worker: every test drives a fake
 * navigator whose registrations record what was posted to them. The point of
 * the module is that it behaves correctly against registrations it does not
 * own (sibling games), and degrades to a no-op against the SDK's inert
 * sandboxed-frame stub — both are shapes we can fake exactly.
 * Run: `node tools/updates-unit.mjs`.
 */
import ArcadeUpdatesDefault, {
    ArcadeUpdates, SKIP_WAITING, CONTROLLER_TIMEOUT_MS,
    checkAll, waiting, apply, waitForControllerChange, watch
} from '../arcade-updates.js';

let pass = 0, fail = 0;
function ok(cond, label) {
    if (cond) { pass++; console.log('  ✓ ' + label); }
    else { fail++; console.log('  ✗ ' + label); }
}

// ─── fakes ────────────────────────────────────────────────────────────

function fakeWorker(state) {
    const listeners = {};
    return {
        state: state || 'installed',
        posted: [],
        postMessage(msg) { this.posted.push(msg); },
        addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
        removeEventListener(t, fn) {
            listeners[t] = (listeners[t] || []).filter((f) => f !== fn);
        },
        emit(t) { for (const fn of (listeners[t] || []).slice()) fn(); }
    };
}

function fakeReg(scope, opts) {
    const o = opts || {};
    const listeners = {};
    return {
        scope,
        waiting: o.waiting || null,
        installing: o.installing || null,
        updates: 0,
        update() {
            this.updates++;
            if (o.updateThrows) return Promise.reject(new Error('offline'));
            if (o.installsOnUpdate) this.waiting = fakeWorker('installed');
            return Promise.resolve();
        },
        addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
        removeEventListener(t, fn) {
            listeners[t] = (listeners[t] || []).filter((f) => f !== fn);
        },
        emit(t) { for (const fn of (listeners[t] || []).slice()) fn(); },
        listenerCount(t) { return (listeners[t] || []).length; }
    };
}

function fakeNav(regs, opts) {
    const o = opts || {};
    const listeners = {};
    return {
        serviceWorker: {
            controller: 'controller' in o ? o.controller : {},
            getRegistrations() {
                if (o.listThrows) return Promise.reject(new Error('nope'));
                return Promise.resolve(regs);
            },
            addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
            removeEventListener(t, fn) {
                listeners[t] = (listeners[t] || []).filter((f) => f !== fn);
            },
            emit(t) { for (const fn of (listeners[t] || []).slice()) fn(); },
            listenerCount(t) { return (listeners[t] || []).length; }
        }
    };
}

/** The SDK's sandboxed-frame stub, copied in shape from arcade-sdk.js. */
function stubNav() {
    return {
        serviceWorker: {
            register: () => Promise.reject(new Error('sandboxed')),
            getRegistration: () => Promise.resolve(undefined),
            getRegistrations: () => Promise.resolve([]),
            addEventListener() {}, removeEventListener() {},
            controller: null,
            ready: new Promise(function () {})   // never settles, on purpose
        }
    };
}

/** A game page that never called Arcade.init: the GETTER throws SecurityError. */
function hostileNav() {
    return Object.defineProperty({}, 'serviceWorker', {
        get() { throw new Error('SecurityError'); }
    });
}

// ─── tests ────────────────────────────────────────────────────────────

function importSurfaceTests() {
    console.log('\nimport surface');
    ok(ArcadeUpdatesDefault === ArcadeUpdates, 'default export and named export are the same object');
    for (const m of ['checkAll', 'waiting', 'apply', 'waitForControllerChange', 'watch']) {
        ok(typeof ArcadeUpdates[m] === 'function', 'ArcadeUpdates.' + m + ' is a function');
    }
    // The wire contract with every game's sw.js. If this string changes on one
    // side only, updates install and then wait forever with no way to apply
    // them — silent, and indistinguishable from "no update available".
    ok(SKIP_WAITING === 'arcade:sw.skipWaiting', 'SKIP_WAITING matches the canonical sw.js message type');
    ok(typeof CONTROLLER_TIMEOUT_MS === 'number' && CONTROLLER_TIMEOUT_MS > 0,
        'CONTROLLER_TIMEOUT_MS is a positive number');
    ok(true, 'module imported with no window, no navigator, no DOM');
}

async function checkAllTests() {
    console.log('\ncheckAll() — refresh every registration on the origin');
    const a = fakeReg('https://x.gh.io/alpha/');
    const b = fakeReg('https://x.gh.io/beta/', { installsOnUpdate: true });
    const c = fakeReg('https://x.gh.io/', { waiting: fakeWorker() });
    const res = await checkAll(fakeNav([a, b, c]));

    ok(a.updates === 1 && b.updates === 1 && c.updates === 1,
        'update() is called on EVERY registration, not just the launcher\'s');
    ok(res.total === 3, 'total counts all registrations on the origin');
    ok(res.ready === 2, 'ready counts registrations with a waiting worker after the refresh');
    ok(res.scopes.includes('https://x.gh.io/beta/') && res.scopes.includes('https://x.gh.io/'),
        'scopes name which apps have an update ready');
    ok(res.errors === 0, 'no errors on the happy path');

    const bad = fakeReg('https://x.gh.io/dead/', { updateThrows: true });
    const good = fakeReg('https://x.gh.io/live/', { installsOnUpdate: true });
    const res2 = await checkAll(fakeNav([bad, good]));
    // One removed/offline game must not strand the rest of the fleet.
    ok(res2.errors === 1, 'a registration whose update() rejects is counted, not thrown');
    ok(res2.ready === 1 && good.updates === 1, 'sibling registrations still refresh after one fails');

    const res3 = await checkAll(fakeNav([], { listThrows: true }));
    ok(res3.total === 0 && res3.errors === 1, 'getRegistrations() rejecting resolves an empty result');
}

async function applyTests() {
    console.log('\napply() — tell waiting workers to activate');
    const w1 = fakeWorker(), w2 = fakeWorker();
    const regs = [
        fakeReg('https://x.gh.io/', { waiting: w1 }),
        fakeReg('https://x.gh.io/alpha/', { waiting: w2 }),
        fakeReg('https://x.gh.io/delta/')            // nothing waiting
    ];
    const sent = await apply(fakeNav(regs));
    ok(sent === 2, 'posts to exactly the registrations that have a waiting worker');
    ok(w1.posted.length === 1 && w1.posted[0].type === SKIP_WAITING,
        'the launcher\'s own waiting worker gets the skipWaiting message');
    ok(w2.posted.length === 1 && w2.posted[0].type === SKIP_WAITING,
        'a SIBLING GAME\'s waiting worker gets it too — one control updates the fleet');

    const none = await apply(fakeNav([fakeReg('https://x.gh.io/')]));
    ok(none === 0, 'nothing waiting → nothing posted');

    const dead = fakeReg('https://x.gh.io/gone/', { waiting: fakeWorker() });
    dead.waiting.postMessage = () => { throw new Error('worker is gone'); };
    const live = fakeWorker();
    const sent2 = await apply(fakeNav([dead, fakeReg('https://x.gh.io/', { waiting: live })]));
    ok(sent2 === 1 && live.posted.length === 1,
        'a worker that dies between listing and posting does not block the others');
}

async function waitingTests() {
    console.log('\nwaiting() — enumerate pending updates');
    const regs = [
        fakeReg('https://x.gh.io/', { waiting: fakeWorker() }),
        fakeReg('https://x.gh.io/gamma/')
    ];
    const w = await waiting(fakeNav(regs));
    ok(w.length === 1 && w[0].scope === 'https://x.gh.io/', 'returns only registrations with a waiting worker');
    ok((await waiting(fakeNav([], { listThrows: true }))).length === 0, 'rejection resolves to an empty list');
}

async function controllerChangeTests() {
    console.log('\nwaitForControllerChange()');
    const nav = fakeNav([]);
    const p = waitForControllerChange(nav, 1000);
    ok(nav.serviceWorker.listenerCount('controllerchange') === 1, 'subscribes to controllerchange');
    nav.serviceWorker.emit('controllerchange');
    ok((await p) === true, 'resolves true when a new worker takes control');
    ok(nav.serviceWorker.listenerCount('controllerchange') === 0, 'unsubscribes after resolving');

    // The normal path when apply() only activated SIBLING workers: the
    // launcher's own controller never changes, and the caller must still be
    // free to reload rather than hang on a promise that will never settle.
    const nav2 = fakeNav([]);
    const t0 = Date.now();
    const timedOut = await waitForControllerChange(nav2, 60);
    ok(timedOut === false, 'resolves false on timeout instead of hanging');
    ok(Date.now() - t0 >= 55, 'the timeout actually waited');
    ok(nav2.serviceWorker.listenerCount('controllerchange') === 0, 'unsubscribes after timing out');

    const nav3 = fakeNav([]);
    nav3.serviceWorker.emit('controllerchange');
    const both = await Promise.all([
        waitForControllerChange(nav3, 40),
        waitForControllerChange(nav3, 40)
    ]);
    ok(both.every((v) => v === false), 'independent waiters each settle exactly once');
}

async function watchTests() {
    console.log('\nwatch() — announce updates as they become available');
    const seen = [];
    const already = fakeReg('https://x.gh.io/', { waiting: fakeWorker() });
    const stop = watch(fakeNav([already]), (scopes) => seen.push(scopes));
    await new Promise((r) => setTimeout(r, 10));
    ok(seen.length === 1 && seen[0][0] === 'https://x.gh.io/',
        'announces an update that was already waiting at boot');
    stop();

    // First visit: a worker installs with NO controller. Prompting "update
    // ready, reload?" to someone who just arrived is nonsense.
    const seen2 = [];
    const installing = fakeWorker('installing');
    const fresh = fakeReg('https://x.gh.io/', { installing });
    const stop2 = watch(fakeNav([fresh], { controller: null }), (s) => seen2.push(s));
    await new Promise((r) => setTimeout(r, 10));
    fresh.emit('updatefound');
    installing.state = 'installed';
    installing.emit('statechange');
    ok(seen2.length === 0, 'a FIRST INSTALL (no controller) is not announced as an update');
    stop2();

    const seen3 = [];
    const installing3 = fakeWorker('installing');
    const upd = fakeReg('https://x.gh.io/alpha/', { installing: installing3 });
    const stop3 = watch(fakeNav([upd]), (s) => seen3.push(s));
    await new Promise((r) => setTimeout(r, 10));
    upd.emit('updatefound');
    installing3.state = 'installed';
    installing3.emit('statechange');
    upd.waiting = installing3;
    installing3.emit('statechange');
    ok(seen3.length >= 1, 'an install WITH a controller present is announced as an update');

    stop3();
    ok(upd.listenerCount('updatefound') === 0, 'unsubscribe removes the updatefound listener');
    const before = seen3.length;
    upd.emit('updatefound');
    installing3.emit('statechange');
    ok(seen3.length === before, 'no announcements after unsubscribe');
}

async function degradationTests() {
    console.log('\ndegradation — sandboxed frames and hostile navigators');
    // arcade-sdk.js hands framed games this stub. Every call must resolve to a
    // clean no-op; `ready` never settles, so anything that awaited it hangs
    // the caller forever. Nothing here may touch it.
    const stub = stubNav();
    const res = await checkAll(stub);
    ok(res.total === 0 && res.ready === 0 && res.errors === 0, 'checkAll() is a clean no-op against the SDK stub');
    ok((await waiting(stub)).length === 0, 'waiting() is empty against the stub');
    ok((await apply(stub)) === 0, 'apply() posts nothing against the stub');
    ok((await waitForControllerChange(stub, 30)) === false, 'waitForControllerChange() resolves against the stub');
    ok(typeof watch(stub, () => {}) === 'function', 'watch() still returns an unsubscribe against the stub');

    // A game page that never called Arcade.init(): the getter itself throws.
    const hostile = hostileNav();
    const res2 = await checkAll(hostile);
    ok(res2.total === 0, 'checkAll() survives a serviceWorker getter that throws SecurityError');
    ok((await apply(hostile)) === 0, 'apply() survives it too');
    ok(typeof watch(hostile, () => {}) === 'function', 'watch() survives it too');

    const bare = {};
    ok((await checkAll(bare)).total === 0, 'a navigator with no serviceWorker at all is a no-op');
}

(async function run() {
    console.log('arcade-updates.js — unit tests');
    importSurfaceTests();
    await checkAllTests();
    await applyTests();
    await waitingTests();
    await controllerChangeTests();
    await watchTests();
    await degradationTests();
    console.log('\n' + (fail ? `✗ ${fail} failed, ${pass} passed` : `✓ all ${pass} assertions passed`));
    process.exit(fail ? 1 : 0);
})();
