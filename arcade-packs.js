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
const packUrl = (game) => `${game.url.replace(/\/?$/, '/')}arcade-pack.json`;

function defaults(env) {
    return Object.assign({ fetch: (...a) => fetch(...a), caches: globalThis.caches }, env);
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
            html = html.split(rootMarker(src)).join(`<script>${text}</script>`);
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

/** First run: fetch only packs not yet stored, so nothing updates unasked. */
export async function downloadMissing(games, env) {
    const e = defaults(env);
    const cache = await e.caches.open(PACK_CACHE);
    let got = 0;
    for (const game of games) {
        if (await cache.match(packKey(game.id))) continue;
        if (await download(game, cache, e)) got++;
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

export default { PACK_CACHE, documentFor, downloadMissing, downloadAll };
