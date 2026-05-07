/**
 * Da Nang 2026 — Service Worker
 *
 * Strategy:
 *   • App shell (HTML / CSS / JS bundles)  → Network-first, fallback to cache
 *   • Photos / tile images                 → Cache-first, background revalidate
 *   • Map tiles (unpkg CDN / tile servers) → Cache-first
 *   • Everything else                      → Network-first, fallback to cache
 */

const CACHE_NAME    = 'danang2026-v1';
const PHOTO_CACHE   = 'danang2026-photos-v1';
const TILE_CACHE    = 'danang2026-tiles-v1';

// Resources to pre-cache on install (app shell)
const PRECACHE_URLS = [
  './app.html',
  './manifest.json',
];

// ─── Install ────────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE_URLS))
  );
  // Activate immediately without waiting for old tabs to close
  self.skipWaiting();
});

// ─── Activate ───────────────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  const CURRENT_CACHES = [CACHE_NAME, PHOTO_CACHE, TILE_CACHE];
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => !CURRENT_CACHES.includes(key))
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// ─── Fetch ───────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET and chrome-extension requests
  if (request.method !== 'GET') return;
  if (url.protocol === 'chrome-extension:') return;

  // Map tiles (OpenStreetMap, tile.openstreetmap.org, unpkg Leaflet assets)
  if (isTileRequest(url)) {
    event.respondWith(cacheFirst(request, TILE_CACHE));
    return;
  }

  // Photos: jpg / jpeg / png / webp / avif hosted anywhere
  if (isPhotoRequest(url)) {
    event.respondWith(cacheFirst(request, PHOTO_CACHE));
    return;
  }

  // App shell and everything else → Network-first
  event.respondWith(networkFirst(request, CACHE_NAME));
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isTileRequest(url) {
  return (
    url.hostname.includes('tile.openstreetmap.org') ||
    url.hostname.includes('unpkg.com') ||
    url.hostname.includes('cdn.tailwindcss.com') ||
    /\/(tiles?|map)\//i.test(url.pathname)
  );
}

function isPhotoRequest(url) {
  return /\.(jpe?g|png|webp|avif|gif|svg)(\?.*)?$/i.test(url.pathname);
}

/**
 * Cache-first: serve from cache immediately; if missing, fetch & store.
 */
async function cacheFirst(request, cacheName) {
  const cache    = await caches.open(cacheName);
  const cached   = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    // Offline and not cached — return a minimal fallback
    return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
  }
}

/**
 * Network-first: try network; on failure serve stale cache.
 */
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);

  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;

    // If the request is for a page navigation, return the cached app shell
    if (request.mode === 'navigate') {
      const shell = await cache.match('./app.html');
      if (shell) return shell;
    }

    return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
  }
}
