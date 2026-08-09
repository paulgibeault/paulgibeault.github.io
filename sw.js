/* Paul's Arcade launcher service worker.
 *
 * Shares the fleet's version/cleanup/skip-waiting contract with every game's
 * sw.js (GAME_INTEGRATION §10 carries the canonical copy) but NOT its fetch
 * strategy: the launcher stays network-first with a cached fallback, because
 * it is the shell that decides which build of everything else the player gets.
 */

// Written by fleet CI on every deploy (fleet-ci.yml, "Bump patch version").
// DO NOT EDIT BY HAND — a hand-maintained constant drifts, and when it drifts
// the origin serves a fix that no returning player ever executes. That is not
// hypothetical; it stranded a game's players for two releases and is why this
// line is CI-owned. tools/repo-gates-unit.mjs Gate D pins its exact shape,
// because if it stops matching CI's sed the rewrite silently stops firing —
// which is indistinguishable from a repo that never adopted it.
const APP_VERSION = '0.0.11';

// Every cache this app has ever owned starts with this prefix — including the
// old hand-numbered 'paul-arcade-v67' names, so the switch to a version-
// derived name still cleans them up. Cleanup is filtered to it; see activate.
const CACHE_PREFIX = 'paul-arcade-';
const CACHE_NAME = `${CACHE_PREFIX}v${APP_VERSION}`;

// Network-first timeout: on lie-fi, stop waiting on the network and serve the
// cached shell/asset so first paint stays bounded.
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
  // Deliberately NOT skipWaiting(). The new worker installs and waits; the
  // update control in index.html ("Check for Updates", and the automatic
  // prompt) spots it and offers an explicit reload, then sends the message
  // below once the player accepts. Activating unannounced would swap the
  // cache under a running game — and it would also mean the launcher, the one
  // page that can apply the whole fleet's updates, never has an update of its
  // own to demonstrate the flow with.
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Game icons come from the catalog — the single authoritative game list.
    // A failed catalog fetch degrades to a shell-only precache; the runtime
    // network-first cache below backfills icons on first view.
    let icons = [];
    try {
      const doc = await (await fetch('./catalog.json')).json();
      icons = (doc.games || [])
        .map((g) => g && g.icon)
        .filter((i) => typeof i === 'string' && i)
        .map((i) => './' + i.replace(/^\.?\//, ''));
    } catch (e) { console.warn('[sw] catalog icon precache skipped', e && e.message); }
    // Cache each asset independently. cache.addAll() rejects the WHOLE install
    // if any single request 404s (a renamed/removed file), which would strand
    // offline users on the previous version with no diagnostic. Per-asset
    // add() tolerates gaps and logs them.
    await Promise.all([...ASSETS, ...icons].map((asset) =>
      cache.add(asset).catch((e) => { console.warn('[sw] precache skipped', asset, e && e.message); })
    ));
  })());
});

self.addEventListener('message', (event) => {
  // Sent by the update control in index.html once the player accepts a reload.
  if (event.data && event.data.type === 'arcade:sw.skipWaiting') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          // ONLY our own caches. caches.keys() is origin-scoped and the whole
          // fleet shares paulgibeault.github.io, so the bare `name !==
          // CACHE_NAME` filter this used to have deleted every game's cache on
          // each launcher activation — and each game's worker did the same
          // back. Every app silently destroying every other app's offline
          // support, on every deploy.
          .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    })
  );
  self.clients.claim();
});

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('network timeout')), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); },
                 (e) => { clearTimeout(t); reject(e); });
  });
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const resp = await withTimeout(fetch(request), NET_TIMEOUT_MS);
    // Runtime-cache good same-origin GET responses so a missed CACHE_NAME bump
    // (or an asset added since the last precache) doesn't leave offline users
    // stranded on a stale/absent entry.
    if (resp && resp.ok && resp.type === 'basic') {
      cache.put(request, resp.clone()).catch(() => {});
    }
    return resp;
  } catch (e) {
    const isNav = request.mode === 'navigate';
    // ignoreSearch on navigations so '/?dev=1' (or any query) still matches the
    // cached shell offline.
    const cached = await cache.match(request, { ignoreSearch: isNav });
    if (cached) return cached;
    if (isNav) {
      const shell = (await cache.match('./index.html')) || (await cache.match('./'));
      if (shell) return shell;
    }
    // Never let respondWith() resolve to undefined (that throws a TypeError and
    // surfaces as a noisy failure) — return an explicit error Response.
    return Response.error();
  }
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
  const isLauncherAsset =
    !rel.includes('/') ||             // '' (root) or a root-level file
    rel.startsWith('p2p/') ||
    rel.startsWith('images/') ||
    rel.startsWith('sdk/');           // major-pinned SDK URLs (sdk/v3/...)
  if (!isLauncherAsset) return;
  event.respondWith(networkFirst(event.request));
});
