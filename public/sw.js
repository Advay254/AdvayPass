// sw.js — AdvayPass
// Strategy matches AdvaySnapTik (proven working):
//   HTML pages  → network-first (always fresh, cache only as offline fallback)
//   JS/CSS      → stale-while-revalidate (instant load + background updates)
//   API calls   → never cached, always network
//   Ad scripts  → never intercepted (external origin)
//   On deploy   → auto-activates and reloads all open tabs immediately

const CACHE  = 'advaypass-v1';
const ASSETS = ['/manifest.json', '/offline.html'];

// ── Install: cache shell assets ───────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS).catch(() => {}))
  );
  self.skipWaiting();
});

// ── Activate: wipe old caches, claim all open tabs instantly ──────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── Fetch ─────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Never intercept API calls
  if (url.pathname.startsWith('/api/')) return;

  // Never intercept external origins (fonts, CDN, ad networks)
  if (url.origin !== self.location.origin) return;

  // HTML / navigation → network-first, offline.html fallback
  if (e.request.mode === 'navigate' ||
      (e.request.headers.get('accept') || '').includes('text/html')) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()));
          return res;
        })
        .catch(() => caches.match(e.request)
          .then(cached => cached || caches.match('/offline.html'))
        )
    );
    return;
  }

  // JS / CSS / images → stale-while-revalidate
  e.respondWith(
    caches.open(CACHE).then(cache =>
      cache.match(e.request).then(cached => {
        const network = fetch(e.request).then(res => {
          if (res.ok) cache.put(e.request, res.clone());
          return res;
        });
        return cached || network;
      })
    )
  );
});

// ── Background Sync ───────────────────────────────────────────────────────────
self.addEventListener('sync', e => {
  if (e.tag === 'advaypass-sync') {
    e.waitUntil(Promise.resolve());
  }
});

// ── Periodic Background Sync ──────────────────────────────────────────────────
self.addEventListener('periodicsync', e => {
  if (e.tag === 'advaypass-refresh') {
    e.waitUntil(Promise.resolve());
  }
});

// ── Listen for manual skip message from page ──────────────────────────────────
self.addEventListener('message', e => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});
