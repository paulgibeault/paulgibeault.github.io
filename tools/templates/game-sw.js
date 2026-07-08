/* game-sw.js — reference service worker for Paul's Arcade games.
 *
 * Copy this file into your game repo as sw.js (at the repo root, so it lives
 * inside your scope) and register it from your game's index.html:
 *
 *   if ('serviceWorker' in navigator &&
 *       !/^(127\.|localhost$|0\.0\.0\.0$|::1$)/.test(location.hostname)) {
 *     navigator.serviceWorker.register('sw.js', { scope: '/YOUR-GAME-ID/' });
 *   }
 *
 * (The loopback guard keeps local-dev edits from being masked by stale
 * cache, matching the launcher's own behavior.)
 *
 * THE TWO RULES — every game and the launcher share ONE origin:
 *
 *   1. Never serve or cache anything outside /YOUR-GAME-ID/. The fetch
 *      handler below early-returns for out-of-scope URLs, so /arcade-sdk.js
 *      and launcher assets always come from the network (or the launcher's
 *      own SW). The Arcade SDK reports a console error — and a visible toast
 *      in ?dev=1 mode — if it finds launcher files in a game's cache.
 *
 *   2. Never clean up origin-wide. `caches.keys()` and
 *      `getRegistrations()` see EVERY game's caches and workers plus the
 *      launcher's. Delete only cache names you created (the version-keyed
 *      prefix filter below); never call registration.unregister() on
 *      registrations that aren't yours.
 */

const GAME_ID = 'YOUR-GAME-ID';          // must match Arcade.init({ gameId })
const CACHE_NAME = `${GAME_ID}-v1`;      // bump the suffix on every deploy
const SCOPE = `/${GAME_ID}/`;

// Everything your game needs to boot offline. All paths must be inside SCOPE.
const ASSETS = [
  SCOPE,
  `${SCOPE}index.html`,
  // `${SCOPE}main.js`,
  // `${SCOPE}style.css`,
  // `${SCOPE}images/...`,
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(
      names
        .filter((n) => n.startsWith(`${GAME_ID}-`) && n !== CACHE_NAME) // OURS only
        .map((n) => caches.delete(n))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Scope guard — the load-bearing line. Requests for the SDK, the launcher,
  // or any other game fall through to the network untouched.
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(SCOPE)) return;

  // Cache-first for our own assets; network fallback keeps un-listed files
  // working online.
  event.respondWith(
    caches.match(event.request).then((hit) => hit || fetch(event.request))
  );
});
