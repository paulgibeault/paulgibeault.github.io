/* sw.js — service worker for Starter App.
 *
 * Registered (loopback-guarded) from index.html. See tools/templates/game-sw.js
 * for the fully-commented reference. THE TWO RULES, both load-bearing on a
 * shared origin:
 *   1. Never serve or cache anything outside /starter-app/ (the SDK errors — and
 *      toasts in ?dev=1 — if launcher files land in a game cache).
 *   2. Never clean up origin-wide: delete only your own starter-app-* caches.
 * Bump CACHE_NAME's suffix on every deploy so clients pick up new assets.
 */

const GAME_ID = 'starter-app';
const CACHE_NAME = `${GAME_ID}-v1`;
const SCOPE = `/${GAME_ID}/`;

const ASSETS = [
  SCOPE,
  `${SCOPE}index.html`,
  `${SCOPE}main.js`,
  `${SCOPE}style.css`,
  `${SCOPE}manifest.json`,
  `${SCOPE}icon.svg`,
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
  // Scope guard — the load-bearing line. The SDK, launcher, and other games
  // fall through to the network untouched.
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(SCOPE)) return;
  event.respondWith(
    caches.match(event.request).then((hit) => hit || fetch(event.request))
  );
});
