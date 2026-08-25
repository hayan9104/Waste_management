/**
 * Minimal service worker for the citizen/driver PWA.
 *
 * App shell is cache-first so the UI opens without a connection; API calls are
 * network-first so data is never silently stale. Nothing that mutates state is
 * cached — a queued report must reach the server, not a cache.
 */

const CACHE = 'safaai-v3';
const SHELL = ['/', '/index.html', '/icon.svg', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/**
 * Store a copy, but only of something worth serving back.
 *
 * Caching every response meant an offline fallback could hand back a cached
 * 500 or a cached 404 forever, and `cache.put` rejects outright on a 206 or an
 * opaque cross-origin response — an unhandled rejection per asset, with no
 * effect anyone could see except the noise in the console.
 */
function remember(request, response) {
  if (!response || !response.ok || response.type === 'opaque') return response;
  const copy = response.clone();
  caches
    .open(CACHE)
    .then((cache) => cache.put(request, copy))
    .catch(() => {});
  return response;
}

/**
 * Every path out of a fetch handler must end at a Response.
 *
 * `caches.match()` resolves to `undefined` on a miss, and handing that to
 * `respondWith` does not fall through to the network — it rejects the
 * FetchEvent, which the browser surfaces as `Failed to convert value to
 * 'Response'` and serves as a network error. So a cold API call or a deep link
 * the cache had never seen (`/officer/queue` — only `/` and `/index.html` are
 * precached) failed inside the worker and looked like the server was down.
 *
 * These stand in for the miss so the failure stays legible: the app's own
 * error handling sees a real status instead of a dead socket.
 */
const OFFLINE_API = () =>
  new Response(JSON.stringify({ error: 'You appear to be offline. Reconnect and try again.' }), {
    status: 503,
    statusText: 'Offline',
    headers: { 'Content-Type': 'application/json' },
  });

const OFFLINE_ASSET = () =>
  new Response('', { status: 504, statusText: 'Offline' });

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // API: network first, fall back to the last good response when offline.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request)
        .then((response) => remember(request, response))
        .catch(() => caches.match(request).then((cached) => cached || OFFLINE_API()))
    );
    return;
  }

  // Page loads and hashed JS/CSS chunks: network first. A cache-first
  // strategy here means a fresh deploy's index.html can keep pointing at
  // chunk files a previous deploy already deleted from the server, which
  // crashes the app on load. Only fall back to cache when truly offline.
  if (request.mode === 'navigate' || /\.(js|css)$/.test(url.pathname)) {
    event.respondWith(
      fetch(request)
        .then((response) => remember(request, response))
        .catch(() =>
          caches.match(request).then((cached) => {
            if (cached) return cached;
            /**
             * A navigation is asking for a route, not a file. Every route in
             * this SPA is served by the one shell, so an uncached deep link
             * offline should open the app at that route and let the router
             * take it from there — not fail because nothing had ever cached
             * that exact path.
             */
            if (request.mode === 'navigate') {
              return caches.match('/index.html').then((shell) => shell || OFFLINE_ASSET());
            }
            return OFFLINE_ASSET();
          })
        )
    );
    return;
  }

  // Static assets (icons, manifest, images): cache first, refresh in the background.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => remember(request, response))
        .catch(() => cached || OFFLINE_ASSET());
      return cached || network;
    })
  );
});
