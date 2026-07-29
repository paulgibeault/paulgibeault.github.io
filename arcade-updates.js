/* arcade-updates.js — origin-wide service-worker update control (ES module,
 * no deps, import-safe from anywhere).
 *
 * WHY THIS LIVES IN THE LAUNCHER AND NOWHERE ELSE
 * The whole fleet shares paulgibeault.github.io, so ONE page can see every
 * game's service-worker registration — `getRegistrations()` is origin-scoped
 * the same way `caches.keys()` is. The launcher owns that origin, so it can
 * refresh and apply updates for every game with one implementation.
 *
 * A game can't do this for itself: inside a launcher-sandboxed frame the SDK
 * shadows navigator.serviceWorker with an inert stub (arcade-sdk.js
 * §"Sandboxed-frame service-worker shim") where getRegistrations() resolves
 * empty and `ready` never settles. Every function here is written to degrade
 * to a clean no-op against that stub rather than hang — which is also what
 * makes it safe to call from a game page on a standalone visit.
 *
 * PAIRS WITH the canonical sw.js: those workers deliberately do NOT
 * skipWaiting() on install, so a new build installs and waits instead of
 * swapping the cache under a running game. Something has to tell them to go.
 * That something is apply() below, via the `arcade:sw.skipWaiting` message.
 * Without this module the fleet's workers would wait forever.
 */

/** Message the canonical sw.js listens for. Changing this breaks every game. */
export const SKIP_WAITING = 'arcade:sw.skipWaiting';

/** Cap on waitForControllerChange(); see its docstring for why it must exist. */
export const CONTROLLER_TIMEOUT_MS = 4000;

function container(nav) {
    const n = nav || (typeof navigator !== 'undefined' ? navigator : null);
    // The getter itself throws SecurityError in a sandboxed frame that the SDK
    // hasn't shimmed (a game page that never called Arcade.init).
    try {
        const c = n && n.serviceWorker;
        return c && typeof c.getRegistrations === 'function' ? c : null;
    } catch (e) {
        return null;
    }
}

/** Registration → the worker that has installed and is waiting to take over. */
function waitingOf(reg) {
    return (reg && reg.waiting) || null;
}

/**
 * Ask every registration on the origin to re-fetch its worker script.
 *
 * This is the "check" half and it is deliberately harmless: update() installs
 * a new worker into the WAITING slot, it never activates one. Nothing swaps
 * under a running game until apply() says so, so this is safe to call on a
 * timer, on launcher boot, or from a menu item.
 *
 * Resolves { total, ready, scopes, errors } — `ready` counts registrations
 * with a waiting worker AFTER the refresh, i.e. updates the player could take
 * right now. A registration whose update() rejects (offline, 404, a game
 * removed from the origin) is counted in `errors` and skipped, never thrown:
 * one dead game must not block the rest of the fleet from updating.
 */
export async function checkAll(nav) {
    const c = container(nav);
    if (!c) return { total: 0, ready: 0, scopes: [], errors: 0 };

    let regs;
    try {
        regs = await c.getRegistrations();
    } catch (e) {
        return { total: 0, ready: 0, scopes: [], errors: 1 };
    }
    regs = Array.isArray(regs) ? regs : [];

    let errors = 0;
    await Promise.all(regs.map(async (reg) => {
        try {
            if (typeof reg.update === 'function') await reg.update();
        } catch (e) {
            errors++;
        }
    }));

    const scopes = regs.filter(waitingOf).map((reg) => reg.scope || '');
    return { total: regs.length, ready: scopes.length, scopes, errors };
}

/** Every registration on the origin that currently has a waiting worker. */
export async function waiting(nav) {
    const c = container(nav);
    if (!c) return [];
    try {
        const regs = await c.getRegistrations();
        return (Array.isArray(regs) ? regs : []).filter(waitingOf);
    } catch (e) {
        return [];
    }
}

/**
 * Tell every waiting worker to activate. Returns how many were told.
 *
 * ALWAYS pair this with a reload. A worker that skips waiting also claims its
 * clients, so the page that called this is now controlled by a worker serving
 * a DIFFERENT build's cache than the code currently running — exactly the
 * mismatch the canonical sw.js avoids by not skipWaiting()ing on install. The
 * reload is what makes the swap coherent, which is why the only caller in the
 * launcher is the confirmed "update ready → reload" path.
 */
export async function apply(nav) {
    const regs = await waiting(nav);
    let sent = 0;
    for (const reg of regs) {
        try {
            reg.waiting.postMessage({ type: SKIP_WAITING });
            sent++;
        } catch (e) { /* a worker that died between listing and posting */ }
    }
    return sent;
}

/**
 * Resolve once a new worker has taken control, or on timeout.
 *
 * The timeout is not defensive padding, it is the normal path: apply() may
 * have activated only SIBLING games' workers, and those never fire
 * controllerchange on the launcher's page. Resolving false there still lets
 * the caller reload — which is what remounts a framed game against its new
 * cache. It also covers the sandboxed-frame stub, whose `ready` never settles.
 */
export function waitForControllerChange(nav, timeoutMs) {
    const c = container(nav);
    if (!c || typeof c.addEventListener !== 'function') return Promise.resolve(false);
    return new Promise((resolve) => {
        let done = false;
        const finish = (v) => {
            if (done) return;
            done = true;
            try { c.removeEventListener('controllerchange', onChange); } catch (e) {}
            clearTimeout(timer);
            resolve(v);
        };
        const onChange = () => finish(true);
        const timer = setTimeout(() => finish(false),
            typeof timeoutMs === 'number' ? timeoutMs : CONTROLLER_TIMEOUT_MS);
        try { c.addEventListener('controllerchange', onChange); } catch (e) { finish(false); }
    });
}

/**
 * Call `onReady(scopes)` whenever an update becomes available — once at boot
 * if one is already waiting, and again whenever a worker finishes installing.
 *
 * The `controller` check is what separates an UPDATE from a FIRST INSTALL. On
 * a first visit a worker installs with no controller present; prompting "an
 * update is ready, reload?" to someone who just arrived is nonsense, and the
 * reload would gain them nothing. Returns an unsubscribe function.
 */
export function watch(nav, onReady) {
    const c = container(nav);
    if (!c) return () => {};
    let stopped = false;
    const cleanups = [];

    const announce = (regs) => {
        if (stopped) return;
        const scopes = regs.filter(waitingOf).map((reg) => reg.scope || '');
        if (scopes.length) { try { onReady(scopes); } catch (e) {} }
    };

    Promise.resolve()
        .then(() => c.getRegistrations())
        .then((raw) => {
            if (stopped) return;
            const regs = Array.isArray(raw) ? raw : [];
            announce(regs);
            for (const reg of regs) {
                if (typeof reg.addEventListener !== 'function') continue;
                const onFound = () => {
                    const sw = reg.installing;
                    if (!sw || typeof sw.addEventListener !== 'function') return;
                    const onState = () => {
                        // 'installed' + an existing controller = a real update.
                        if (sw.state === 'installed' && c.controller) announce([reg]);
                    };
                    sw.addEventListener('statechange', onState);
                    cleanups.push(() => { try { sw.removeEventListener('statechange', onState); } catch (e) {} });
                };
                reg.addEventListener('updatefound', onFound);
                cleanups.push(() => { try { reg.removeEventListener('updatefound', onFound); } catch (e) {} });
            }
        })
        .catch(() => {});

    return () => {
        stopped = true;
        for (const fn of cleanups) fn();
        cleanups.length = 0;
    };
}

export const ArcadeUpdates = {
    SKIP_WAITING, CONTROLLER_TIMEOUT_MS,
    checkAll, waiting, apply, waitForControllerChange, watch
};

export default ArcadeUpdates;
