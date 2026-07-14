const CACHE_NAME = 'paul-arcade-v27';
// Network-first timeout: on lie-fi, stop waiting on the network and serve the
// cached shell/asset so first paint stays bounded.
const NET_TIMEOUT_MS = 5000;
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './profile.html',
  './styles.css',
  './manifest.json',
  './arcade-sdk.js',
  './arcade-p2p.js',
  './arcade-known-peers.js',
  './arcade-diag.js',
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
  './images/p2p-chat.png',
  './images/qrcodep2p.png',
  './images/zibaldone.png',
  './images/usai.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // Cache each asset independently. cache.addAll() rejects the WHOLE install
      // if any single request 404s (a renamed/removed file), which would strand
      // offline users on the previous version with no diagnostic. Per-asset
      // add() tolerates gaps and logs them.
      Promise.all(ASSETS_TO_CACHE.map((asset) =>
        cache.add(asset).catch((e) => { console.warn('[sw] precache skipped', asset, e && e.message); })
      ))
    )
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
    rel.startsWith('images/');
  if (!isLauncherAsset) return;
  event.respondWith(networkFirst(event.request));
});
