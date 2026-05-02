const CACHE_NAME = 'paul-arcade-v7';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './profile.html',
  './styles.css',
  './manifest.json',
  './arcade-sdk.js',
  './images/icon-192.png',
  './images/icon-512.png',
  './images/pi-game.png',
  './images/si-syn.png',
  './images/hecknsic.png',
  './images/cozy-solitaire.png',
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
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
