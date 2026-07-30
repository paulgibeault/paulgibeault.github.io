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
 *
 *   3. Never activate unannounced. install() must NOT skipWaiting(); the new
 *      worker waits, and the launcher's update control offers the player a
 *      reload and then sends the message handled below. Swapping the cache
 *      under a running game means code from one build fetching assets from
 *      another. This is also the recovery path that makes cache-first safe.
 */

const GAME_ID = 'YOUR-GAME-ID';          // must match Arcade.init({ gameId })
const SCOPE = `/${GAME_ID}/`;

// Written by fleet CI on every deploy (fleet-ci.yml, "Bump patch version"),
// which requires `version_bump: true` in your repo's thin caller workflow.
// DO NOT EDIT BY HAND, and keep the line exactly as written — single quotes,
// no leading whitespace. CI matches it with
//   grep -q "^const APP_VERSION = '"   and rewrites it with an anchored sed,
// so re-indenting it or switching to double quotes turns the deploy-time
// rewrite into a silent no-op: the cache identity freezes, activate-time
// cleanup never runs, and every fix you ship afterwards reaches nobody who
// has already visited. A hand-bumped counter here has cost the fleet exactly
// that, twice.
const APP_VERSION = '0.0.0';

const CACHE_NAME = `${GAME_ID}-v${APP_VERSION}`;

// Everything your game needs to boot offline — GENERATED, not maintained.
// tools/stage.mjs rewrites the region between the markers below from the files
// the deploy actually publishes, so this list cannot drift from the artifact
// and a content-hashed bundle name needs no hand edit. Leave a file out by
// naming it in PRECACHE_EXCLUDE in tools/stage.mjs, never by editing here.
//
// What is checked in is only a placeholder: service workers are off on
// loopback, so a dev checkout never reads it.
// arcade:precache-begin
const ASSETS = [
  './',
  './index.html',
];
// arcade:precache-end

self.addEventListener('install', (event) => {
  // Per-asset add(), not addAll(). addAll() rejects the WHOLE install if any
  // single entry 404s, so one missing file costs every returning player their
  // entire offline shell — silently, and for as long as nobody notices. That
  // has happened in this fleet; a gap should cost one file and a console line.
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => Promise.all(
    ASSETS.map((asset) => cache.add(asset).catch((e) => {
      console.warn('[sw] precache skipped', asset, e && e.message);
    }))
  )));
  // No skipWaiting() — see rule 3 above.
});

self.addEventListener('message', (event) => {
  // Sent by the launcher's update control once the player accepts the reload.
  // Without this handler your worker installs and then waits forever, which
  // looks exactly like "no update available".
  if (event.data && event.data.type === 'arcade:sw.skipWaiting') self.skipWaiting();
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
  //
  // ignoreSearch because the precache is generated from filenames on disk,
  // which carry no query string, while markup may request the same file with
  // a cache-busting `?v=` suffix. Matched strictly, every one of those would
  // miss the cache and silently fall through to the network — an app that
  // looks fully precached and is entirely offline-broken. (Those suffixes are
  // also now redundant: CI's APP_VERSION keys the whole cache per deploy.)
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true })
      .then((hit) => hit || fetch(event.request))
  );
});
