/* arcade-packs.js — offline game packs (ES module, no deps).
 *
 * A pack is a game's whole artifact as one document (tools/build-pack.mjs), so
 * a sandboxed launcher frame, which no service worker can serve, runs with no
 * network. The launcher injects its own SDK from the pinned release, so a
 * game always runs against the launcher it is talking to. A game without a
 * usable pack simply loads from the network as before.
 *
 * The cache name deliberately lacks the launcher's `paul-arcade-` prefix:
 * release cleanup deletes everything under that prefix, and packs outlive
 * launcher releases.
 */
import { CACHE_PREFIX, pinned } from './arcade-release.js';

export const PACK_CACHE = 'arcade-packs';

const packKey = (gameId) => `__pack/${gameId}`;
const rootMarker = (src) => `<!--arcade:root ${src}-->`;
const gameFile = (game, name) => `${game.url.replace(/\/?$/, '/')}${name}`;
const packUrl = (game) => gameFile(game, 'arcade-pack.json');

function defaults(env) {
    return Object.assign({ fetch: (...a) => fetch(...a), caches: globalThis.caches }, env);
}

/** A compiled kernel finds its .wasm by URL, which an inline script lacks. */
async function kernelBinary(src, release) {
    if (!/\/arcade-sim-[^/]+\.js$/.test(src)) return '';
    const wasmSrc = src.replace(/\.js$/, '.wasm');
    const hit = await release.match(`.${wasmSrc}`);
    if (!hit) return '';
    const bytes = new Uint8Array(await hit.arrayBuffer());
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    const name = wasmSrc.split('/').pop();
    return `<script>(self.__arcadePackWasm=self.__arcadePackWasm||{})[${JSON.stringify(name)}]="data:application/wasm;base64,${btoa(binary)}";</script>`;
}

/** The ready-to-mount document for a game, or null to use the network. */
export async function documentFor(gameId, env) {
    const e = defaults(env);
    try {
        const hit = await (await e.caches.open(PACK_CACHE)).match(packKey(gameId));
        if (!hit) return null;
        const pack = await hit.json();
        const version = await pinned(e);
        if (!version) return null;
        const release = await e.caches.open(`${CACHE_PREFIX}v${version}`);
        let html = pack.html;
        for (const src of pack.roots) {
            const script = await release.match(`.${src}`);
            if (!script) return null;     // an SDK-less pack can't run
            const text = (await script.text()).replace(/<\/script/gi, '<\\/script');
            html = html.split(rootMarker(src)).join(`${await kernelBinary(src, release)}<script>${text}</script>`);
        }
        return html;
    } catch (err) {
        return null;
    }
}

/** Fetch one game's pack. A failure keeps whatever pack is already stored. */
async function download(game, cache, e) {
    try {
        const res = await e.fetch(packUrl(game), { cache: 'reload' });
        if (!res.ok) return false;
        const pack = await res.clone().json();
        if (typeof pack.html !== 'string' || !Array.isArray(pack.roots)) return false;
        await cache.put(packKey(game.id), res);
        return true;
    } catch (err) {
        return false;
    }
}

/**
 * How many stored packs have a newer deploy. Reads one tiny file per stored
 * pack and changes nothing, so the passive check can call it freely.
 */
export async function updatesAvailable(games, env) {
    const e = defaults(env);
    const cache = await e.caches.open(PACK_CACHE);
    const results = await Promise.all(games.map(async (game) => {
        try {
            const hit = await cache.match(packKey(game.id));
            if (!hit) return false;
            const res = await e.fetch(gameFile(game, 'arcade-pack.version.json'), { cache: 'no-store' });
            if (!res.ok) return false;
            return (await res.json()).version !== (await hit.json()).version;
        } catch (err) {
            return false;
        }
    }));
    return results.filter(Boolean).length;
}

/**
 * How many games would mount offline right now: a stored pack plus a pinned
 * release to take the SDK from. Only looks up keys, never reads a pack's
 * body, so the menu can ask whenever it is shown. Never throws.
 */
export async function readiness(games, env) {
    const e = defaults(env);
    const total = games.length;
    const none = { ready: 0, total, missing: games.map((g) => g.id) };
    try {
        if (!await pinned(e)) return none;
        const cache = await e.caches.open(PACK_CACHE);
        const stored = await Promise.all(games.map((g) => cache.match(packKey(g.id)).then(Boolean, () => false)));
        const missing = games.filter((g, i) => !stored[i]).map((g) => g.id);
        return { ready: total - missing.length, total, missing };
    } catch (err) {
        return none;
    }
}

/**
 * First run: fetch only packs not yet stored, so nothing updates unasked.
 * `onStored(gameId)` fires as each pack lands, so a readiness count can follow.
 */
export async function downloadMissing(games, env, onStored) {
    const e = defaults(env);
    const cache = await e.caches.open(PACK_CACHE);
    let got = 0;
    for (const game of games) {
        if (await cache.match(packKey(game.id))) continue;
        if (await download(game, cache, e)) {
            got++;
            if (onStored) try { onStored(game.id); } catch (err) {}
        }
    }
    return got;
}

/** An accepted update: refresh every pack. */
export async function downloadAll(games, env) {
    const e = defaults(env);
    const cache = await e.caches.open(PACK_CACHE);
    const results = await Promise.all(games.map((g) => download(g, cache, e)));
    return results.filter(Boolean).length;
}

export default { PACK_CACHE, documentFor, updatesAvailable, readiness, downloadMissing, downloadAll };
