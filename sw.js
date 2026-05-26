// RXS Event Manager — Service Worker
// Caches the app shell so judges can run tournaments with no signal.
// Bump CACHE_VERSION whenever you ship a new version of the HTML.

const CACHE_VERSION = 'rxs-em-v13';
const APP_SHELL = [
  '/eventmanager.html',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/weeeeeee-haha.mp3',
  '/fahhh.mp3'
];

// On install: pre-cache the app shell
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache => {
      // addAll is atomic — if any fail, none cache. So try them individually.
      return Promise.all(
        APP_SHELL.map(url =>
          cache.add(url).catch(err => console.warn('[SW] Failed to cache', url, err))
        )
      );
    })
  );
});

// On activate: clean up old caches from previous versions
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys
        .filter(k => k !== CACHE_VERSION)
        .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// On fetch: smart routing
//   /api/*    → network only (never cache API calls — they need fresh data)
//   GET html  → network first, fall back to cache (so you see updates when online)
//   GET other → cache first, fall back to network (fonts, icons, etc.)
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle GET requests — POST/PUT for /api/beyresults etc. should pass through
  if (req.method !== 'GET') return;

  // API calls: pass through to network, no caching. If offline, the app's
  // existing markDirty/localAutoSave logic handles the queueing locally.
  if (url.pathname.startsWith('/api/')) {
    return; // let the browser handle it normally
  }

  // Cross-origin (Google Fonts, etc.): cache-first
  if (url.origin !== self.location.origin) {
    event.respondWith(
      caches.match(req).then(cached => cached || fetch(req).then(res => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE_VERSION).then(c => c.put(req, clone));
        }
        return res;
      }).catch(() => cached))
    );
    return;
  }

  // Same-origin HTML and assets: network-first, fallback to cache
  event.respondWith(
    fetch(req).then(res => {
      // Update cache with fresh copy
      if (res && res.status === 200) {
        const clone = res.clone();
        caches.open(CACHE_VERSION).then(c => c.put(req, clone));
      }
      return res;
    }).catch(() =>
      // Offline: serve from cache
      caches.match(req).then(cached => cached || caches.match('/eventmanager.html'))
    )
  );
});

// Allow the page to tell the SW to update immediately
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
