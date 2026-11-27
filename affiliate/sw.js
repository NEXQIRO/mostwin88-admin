const CACHE_NAME = 'mw-affiliate-folder-v4';
const CDN_CACHE = 'mw-cdn-v1';
const ENTRY = './';
const PRECACHE = [
  ENTRY,
  './index.html',
  './manifest.json',
  '../pwa.js',
  '../passkey.js',
  '../firebase-config.js',
  '../partner-logo-192.png?v=2',
  '../partner-logo-512.png?v=2'
];
const CDN_PRECACHE = [
  'https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/10.7.1/firebase-database-compat.js',
  'https://fonts.googleapis.com/css2?family=Hind+Siliguri:wght@400;500;600;700&family=JetBrains+Mono:wght@500;600&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap'
];
const CDN_HOSTS = new Set(['www.gstatic.com', 'fonts.gstatic.com', 'fonts.googleapis.com', 'cdn.jsdelivr.net']);
const lastReval = new Map();
const REVAL_COOLDOWN_MS = 180000;

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const appCache = await caches.open(CACHE_NAME);
    await Promise.allSettled(PRECACHE.map((u) => appCache.add(u)));
    const cdnCache = await caches.open(CDN_CACHE);
    await Promise.allSettled(CDN_PRECACHE.map((u) => cdnCache.add(u)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k.startsWith('mw-affiliate-') && k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

async function revalidateIfChanged(req, cached) {
  try {
    if (self.navigator && self.navigator.onLine === false) return;
    if (self.navigator && self.navigator.connection && self.navigator.connection.saveData) return;
    const u = new URL(req.url);
    const cacheKey = u.origin + u.pathname;
    const now = Date.now();
    if (now - (lastReval.get(cacheKey) || 0) < REVAL_COOLDOWN_MS) return;
    lastReval.set(cacheKey, now);

    const headRes = await fetch(cacheKey, { method: 'HEAD', cache: 'no-cache' });
    if (!headRes || !headRes.ok) return;
    const newEtag = headRes.headers.get('etag');
    const oldEtag = cached.headers.get('etag');
    const newLm = headRes.headers.get('last-modified');
    const oldLm = cached.headers.get('last-modified');
    if (newEtag && oldEtag && newEtag === oldEtag) return;
    if (!newEtag && newLm && oldLm && newLm === oldLm) return;

    const fresh = await fetch(cacheKey, { cache: 'no-cache' });
    if (fresh && fresh.ok) {
      const c = await caches.open(CACHE_NAME);
      await c.put(cacheKey, fresh.clone());
    }
  } catch (err) {}
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);

  if (CDN_HOSTS.has(u.hostname)) {
    e.respondWith((async () => {
      const c = await caches.open(CDN_CACHE);
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res && (res.ok || res.type === 'opaque')) {
        c.put(req, res.clone()).catch(() => {});
      }
      return res;
    })());
    return;
  }

  if (u.origin !== self.location.origin) return;
  if (u.pathname.startsWith('/api/') || u.pathname === '/health' || u.pathname.endsWith('/sw.js') || u.pathname.endsWith('-sw.js')) return;

  if (req.mode === 'navigate' || u.pathname.endsWith('.html') || u.pathname.endsWith('.js') || u.pathname.endsWith('.json')) {
    e.respondWith((async () => {
      const c = await caches.open(CACHE_NAME);
      const lookup = req.mode === 'navigate' ? (u.origin + u.pathname) : req;
      let cached = await c.match(lookup, { ignoreSearch: req.mode === 'navigate' });
      if (!cached && req.mode === 'navigate') {
        cached = await c.match(ENTRY, { ignoreSearch: true }) || await c.match('./index.html');
      }
      if (cached) {
        e.waitUntil(revalidateIfChanged(req, cached));
        return cached;
      }
      const res = await fetch(req);
      if (res && res.ok) {
        c.put(lookup, res.clone()).catch(() => {});
      }
      return res;
    })());
    return;
  }

  e.respondWith((async () => {
    const c = await caches.open(CACHE_NAME);
    const hit = await c.match(req);
    if (hit) return hit;
    const res = await fetch(req);
    if (res && res.ok) {
      c.put(req, res.clone()).catch(() => {});
    }
    return res;
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cls) => {
      for (const c of cls) { if ('focus' in c) return c.focus(); }
      if (self.clients.openWindow) return self.clients.openWindow(ENTRY);
    })
  );
});
