/* arcade-release.js — the launcher's pinned release (ES module, no deps).
 *
 * sw.js serves the launcher from whichever complete cache the pointer names.
 * This module is the only thing that moves the pointer, and it only runs when
 * the player accepts an update. check() is free to run any time: it reads one
 * small file and changes nothing. See plans/offline-first-2026-11.md.
 *
 * `env` is injectable for tools/release-unit.mjs; pages use the defaults.
 */

// sw.js carries the same names; tools/release-unit.mjs pins them together.
export const CACHE_PREFIX = 'paul-arcade-';
export const POINTER_CACHE = `${CACHE_PREFIX}release`;
export const PIN_KEY = '__release-pin';

const CHECK_TIMEOUT_MS = 8000;
const DOWNLOAD_CONCURRENCY = 6;

const cacheNameFor = (version) => `${CACHE_PREFIX}v${version}`;

// sw.js lets a request carrying this through to the network. Without it the
// worker answers an update's downloads from the release being replaced.
const fromNetwork = (asset, version) => `${asset}?arcade-release=${encodeURIComponent(version)}`;

function defaults(env) {
    return Object.assign({
        fetch: (...a) => fetch(...a),
        caches: globalThis.caches,
        digest: (buf) => crypto.subtle.digest('SHA-256', buf)
    }, env);
}

export async function pinned(env) {
    const { caches } = defaults(env);
    try {
        const hit = await (await caches.open(POINTER_CACHE)).match(PIN_KEY);
        return hit ? (await hit.json()).version || null : null;
    } catch (e) {
        return null;
    }
}

/**
 * Compare the deployed release to the pinned one. Never throws and never
 * writes. `failed` means the network didn't answer; a 404 is a deployment with
 * no manifest (a dev server), which is simply "nothing to update to".
 */
export async function check(env) {
    const e = defaults(env);
    let res;
    try {
        res = await e.fetch('./release.json', { cache: 'no-store', signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    } catch (err) {
        return { available: false, failed: true };
    }
    if (res.status === 404) return { available: false, failed: false };
    if (!res.ok) return { available: false, failed: true };
    try {
        const manifest = await res.json();
        if (!manifest || typeof manifest.version !== 'string' || !manifest.assets) throw new Error('bad manifest');
        return { available: manifest.version !== await pinned(e), failed: false, manifest };
    } catch (err) {
        return { available: false, failed: true };
    }
}

async function hex(e, buf) {
    return [...new Uint8Array(await e.digest(buf))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function pooled(items, fn) {
    const queue = items.slice();
    await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, queue.length) }, async () => {
        while (queue.length) await fn(queue.shift());
    }));
}

/**
 * Download and verify a whole release, then move the pointer in one write.
 * Throws on any missing or mismatched file, leaving the pinned release
 * untouched. Past the HTTP cache, because a stale copy would fail its hash.
 */
export async function install(manifest, env) {
    const e = defaults(env);
    const name = cacheNameFor(manifest.version);
    await e.caches.delete(name);
    const staged = await e.caches.open(name);
    try {
        await pooled(Object.entries(manifest.assets), async ([asset, sha]) => {
            const res = await e.fetch(fromNetwork(asset, manifest.version), { cache: 'reload' });
            if (!res.ok) throw new Error(`${asset}: HTTP ${res.status}`);
            if (await hex(e, await res.clone().arrayBuffer()) !== sha) throw new Error(`${asset}: hash mismatch`);
            await staged.put(asset, res);
        });
    } catch (err) {
        await e.caches.delete(name);
        throw err;
    }
    // A game's icon can be absent without the launcher being broken.
    await pooled(manifest.icons || [], async (icon) => {
        try {
            const res = await e.fetch(fromNetwork(icon, manifest.version), { cache: 'reload' });
            if (res.ok) await staged.put(icon, res);
        } catch (err) { /* the grid's fallback covers it */ }
    });

    await (await e.caches.open(POINTER_CACHE)).put(PIN_KEY,
        new Response(JSON.stringify({ version: manifest.version }), { headers: { 'content-type': 'application/json' } }));

    const names = await e.caches.keys();
    await Promise.all(names
        .filter((n) => n.startsWith(CACHE_PREFIX) && n !== POINTER_CACHE && n !== name)
        .map((n) => e.caches.delete(n)));
}

export default { CACHE_PREFIX, POINTER_CACHE, PIN_KEY, pinned, check, install };
