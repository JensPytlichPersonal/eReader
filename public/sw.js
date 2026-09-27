// eReader service worker: caches the app shell and book content for offline reading.
const VERSION = 'ereader-v1';
const SHELL = ['/', '/login', '/settings', '/css/app.css', '/css/reader.css', '/js/api.js', '/js/settings.js', '/js/library.js', '/js/login.js', '/js/reader.js', '/js/pdf-view.js', '/js/settings-page.js', '/manifest.webmanifest', '/icons/icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== `${VERSION}-books`).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // always live

  // Book content is immutable per conversion: cache first.
  if (url.pathname.startsWith('/books/') || url.pathname.startsWith('/vendor/')) {
    if (url.pathname.endsWith('/book.json')) { e.respondWith(networkFirst(req, `${VERSION}-books`)); return; }
    if (url.pathname.endsWith('/original')) return;
    e.respondWith(cacheFirst(req, `${VERSION}-books`));
    return;
  }
  // App shell: network first, fall back to cache when offline.
  e.respondWith(networkFirst(req, VERSION));
});

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone()).catch(() => {});
  return res;
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
    if (hit) return hit;
    if (req.mode === 'navigate') {
      // Any cached reader page serves any book (the page is the same; the book id comes from the URL).
      const wantReader = new URL(req.url).pathname.startsWith('/read/');
      for (const key of await cache.keys()) {
        const p = new URL(key.url).pathname;
        if (wantReader ? p.startsWith('/read/') : p === '/') { const hit = await cache.match(key); if (hit) return hit; }
      }
    }
    throw err;
  }
}
