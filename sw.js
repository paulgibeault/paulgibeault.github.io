const CACHE_NAME = 'paul-arcade-v21';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './profile.html',
  './styles.css',
  './manifest.json',
  './arcade-sdk.js',
  './arcade-p2p.js',
  './arcade-known-peers.js',
  './p2p/p2p-addon.js',
  './p2p/p2p-ui.js',
  './p2p/p2p-core.js',
  './p2p/sdp-codec.js',
  './p2p/p2p-addon.css',
  './p2p/rendezvous-crypto.js',
  './p2p/rendezvous-carriers.js',
  './p2p/rendezvous.js',
  './p2p/vendor/qrcode.min.js',
  './p2p/vendor/html5-qrcode.min.js',
  './images/icon-192.png',
  './images/icon-512.png',
  './images/pi-game.png',
  './images/si-syn.png',
  './images/hecknsic.png',
  './images/cozy-solitaire.png',
  './images/moon-lit.png',
  './images/sowduku.png',
  './images/qrcodep2p.png',
  './images/zibaldone.png',
  './images/usai.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Only handle launcher-owned URLs: root-level files plus the p2p/ and
  // images/ trees. Every game lives at /<gameId>/... — those requests fall
  // through untouched, so a game without its own service worker gets a
  // normal network error offline instead of an opaque failed cache lookup,
  // and games with their own SW are never shadowed by this one.
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const scopePath = new URL(self.registration.scope).pathname;
  if (!url.pathname.startsWith(scopePath)) return;
  const rel = url.pathname.slice(scopePath.length);
  const isLauncherAsset =
    !rel.includes('/') ||             // '' (root) or a root-level file
    rel.startsWith('p2p/') ||
    rel.startsWith('images/');
  if (!isLauncherAsset) return;
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
