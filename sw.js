/* Paul's Arcade launcher service worker.
 *
 * Shares the fleet's version/cleanup/skip-waiting contract with every game's
 * sw.js (GAME_INTEGRATION §10 carries the canonical copy). The launcher is
 * served cache-first from a PINNED RELEASE: a stored pointer names one complete
 * cache, and only the player's explicit update (arcade-release.js) moves it.
 *
 * The pin is data rather than this file because this file changes on every
 * deploy, and a waiting worker activates by itself once its tabs close. So a
 * new worker may arrive unasked, but what it serves stays what the player
 * chose. See plans/offline-first-2026-11.md.
 */

// Written by fleet CI on every deploy (fleet-ci.yml, "Bump patch version").
// DO NOT EDIT BY HAND — a hand-maintained constant drifts, and when it drifts
// the origin serves a fix that no returning player ever executes. That is not
// hypothetical; it stranded a game's players for two releases and is why this
// line is CI-owned. tools/repo-gates-unit.mjs Gate D pins its exact shape,
// because if it stops matching CI's sed the rewrite silently stops firing —
// which is indistinguishable from a repo that never adopted it.
const APP_VERSION = '0.0.33';

// Every cache this app has ever owned starts with this prefix — including the
// old hand-numbered 'paul-arcade-v67' names, so the switch to a version-
// derived name still cleans them up. Cleanup is filtered to it; see activate.
const CACHE_PREFIX = 'paul-arcade-';
const CACHE_NAME = `${CACHE_PREFIX}v${APP_VERSION}`;

// The pointer to the release being served. arcade-release.js writes the same
// names; tools/release-unit.mjs pins the two copies together.
const POINTER_CACHE = `${CACHE_PREFIX}release`;
const PIN_KEY = '__release-pin';

async function pinnedVersion() {
  try {
    const hit = await (await caches.open(POINTER_CACHE)).match(PIN_KEY);
    return hit ? (await hit.json()).version || null : null;
  } catch (e) { return null; }
}

const cacheNameFor = (version) => `${CACHE_PREFIX}v${version}`;

// Bounds the wait on a file the pinned release doesn't hold, on lie-fi.
const NET_TIMEOUT_MS = 5000;
// GENERATED, not maintained — tools/stage.mjs rewrites the region below from
// the files this deploy actually publishes (tools/inject-precache.mjs). Adding
// a module to the SDK no longer means remembering to list it here, which is
// the edit the fleet kept forgetting. To publish something without caching it,
// add it to PRECACHE_EXCLUDE in tools/stage.mjs.
//
// Game icons are still NOT part of this: they're derived from catalog.json at
// install time (below), because they belong to the catalog rather than to the
// artifact. Everything else the launcher ships is now listed automatically.
//
// What is checked in is a placeholder; loopback skips the worker entirely.
// arcade:precache-begin
const ASSETS = [
  './',
  './index.html',
];
// arcade:precache-end

self.addEventListener('install', (event) => {
  // Deliberately NOT skipWaiting(); only the player's accepted update sends
  // the message below. Activating unannounced would swap the worker under a
  // running game.
  event.waitUntil((async () => {
    // Already pinned: this is a routine new worker, not a first install, and
    // new builds download only when the player asks.
    const pinned = await pinnedVersion();
    if (pinned && await caches.has(cacheNameFor(pinned))) return;

    const cache = await caches.open(CACHE_NAME);
    // Game icons come from the catalog — the single authoritative game list.
    // A failed catalog fetch degrades to a shell-only precache.
    let icons = [];
    try {
      const doc = await (await fetch('./catalog.json', { cache: 'reload' })).json();
      icons = (doc.games || [])
        .map((g) => g && g.icon)
        .filter((i) => typeof i === 'string' && i)
        .map((i) => './' + i.replace(/^\.?\//, ''));
    } catch (e) { console.warn('[sw] catalog icon precache skipped', e && e.message); }
    // Per-asset add(), and past the 10-minute HTTP cache: addAll() rejects the
    // whole install on one 404, and a stale copy would pin a mixed build.
    await Promise.all([...ASSETS, ...icons].map((asset) =>
      cache.add(new Request(asset, { cache: 'reload' }))
        .catch((e) => { console.warn('[sw] precache skipped', asset, e && e.message); })
    ));
    // Pin only a shell that can actually boot; a failed install retries later.
    if (!(await cache.match('./index.html'))) throw new Error('shell precache failed');
    await (await caches.open(POINTER_CACHE)).put(PIN_KEY,
      new Response(JSON.stringify({ version: APP_VERSION }), { headers: { 'content-type': 'application/json' } }));
  })());
});

self.addEventListener('message', (event) => {
  // Sent by the update control in index.html once the player accepts a reload.
  if (event.data && event.data.type === 'arcade:sw.skipWaiting') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const pinned = await pinnedVersion();
    const keep = new Set([POINTER_CACHE, CACHE_NAME, cacheNameFor(pinned || APP_VERSION)]);
    const cacheNames = await caches.keys();
    await Promise.all(
      cacheNames
        // ONLY our own caches. caches.keys() is origin-scoped and the whole
        // fleet shares paulgibeault.github.io, so an unfiltered cleanup here
        // deletes every game's offline support on each activation.
        .filter((name) => name.startsWith(CACHE_PREFIX) && !keep.has(name))
        .map((name) => caches.delete(name))
    );
  })());
  self.clients.claim();
});

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('network timeout')), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); },
                 (e) => { clearTimeout(t); reject(e); });
  });
}

async function servingCache() {
  const pinned = await pinnedVersion();
  return caches.open(pinned ? cacheNameFor(pinned) : CACHE_NAME);
}

// A hit never touches the network, so launch needs no connection and can't be
// slowed by a bad one.
async function cacheFirst(request) {
  const cache = await servingCache();
  const isNav = request.mode === 'navigate';
  // ignoreSearch: '/?dev=1' is still the cached shell.
  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit) return hit;
  try {
    const resp = await withTimeout(fetch(request), NET_TIMEOUT_MS);
    // Fill gaps from a tolerant first install. Only ever a miss, so this can't
    // replace a pinned file. Navigations are the docs, which stay uncached.
    if (!isNav && resp && resp.ok && resp.type === 'basic') {
      cache.put(request, resp.clone()).catch(() => {});
    }
    return resp;
  } catch (e) {
    if (isNav) {
      const shell = (await cache.match('./index.html')) || (await cache.match('./'));
      if (shell) return shell;
    }
    // Never let respondWith() resolve to undefined (that throws a TypeError and
    // surfaces as a noisy failure) — return an explicit error Response.
    return Response.error();
  }
}

// Game icons live under /<gameId>/ but belong to the launcher's grid.
async function cachedOrNetwork(request) {
  const hit = await (await servingCache()).match(request, { ignoreSearch: true });
  if (hit) return hit;
  try { return await fetch(request); } catch (e) { return Response.error(); }
}

self.addEventListener('fetch', (event) => {
  // Only GET, and only launcher-owned URLs: root-level files plus the p2p/ and
  // images/ trees. Every game lives at /<gameId>/... — those requests fall
  // through untouched, so a game without its own service worker gets a normal
  // network error offline instead of an opaque failed cache lookup, and games
  // with their own SW are never shadowed by this one. (In-arcade play mounts
  // games in opaque-origin frames no SW can control, so their offline story is
  // the launcher's loading/error card, not this cache — see GAME_INTEGRATION.)
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const scopePath = new URL(self.registration.scope).pathname;
  if (!url.pathname.startsWith(scopePath)) return;
  const rel = url.pathname.slice(scopePath.length);
  // The update check's own request: answering it from a cache would make the
  // current release look permanently up to date.
  if (rel === 'release.json') return;
  // An update's downloads (arcade-release.js) must see the new build.
  if (url.searchParams.has('arcade-release')) return;
  const isLauncherAsset =
    !rel.includes('/') ||             // '' (root) or a root-level file
    rel.startsWith('p2p/') ||
    rel.startsWith('images/') ||
    rel.startsWith('sdk/');           // major-pinned SDK URLs (sdk/v3/...)
  if (!isLauncherAsset) {
    if (event.request.destination === 'image') event.respondWith(cachedOrNetwork(event.request));
    return;
  }
  event.respondWith(cacheFirst(event.request));
});
