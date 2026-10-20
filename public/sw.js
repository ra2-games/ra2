/*
 * RA2/YR PWA service worker: a minimal implementation meeting browser installation requirements.
 * Deliberately conservative policy:
 * - Navigation uses network-first, falling back to cached index.html when offline.
 * - Content-hashed dist/assets use cache-first with background updates.
 * - Other same-origin GETs (skins/icons, etc.) use network-first and cache only successful responses, never 404s.
 * - Players import game files locally and store them in browser IndexedDB; these bypass the SW.
 * - The development server (localhost:15174) does not register this worker, avoiding conflicts with its no-cache policy.
 */
const APP_SHELL = 'ra2vm-app-v7';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== APP_SHELL).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    // Offline fallback: prefer the network, then fall back to cached index.html on failure.
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          const cache = await caches.open(APP_SHELL);
          cache.put('/index.html', response.clone()).catch(() => {});
          return response;
        } catch {
          const cached = await caches.match('/index.html');
          return cached ?? Response.error();
        }
      })(),
    );
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    // Content-hashed build artifacts are immutable: cache-first with background updates.
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);
        const refresh = fetch(request).then(async (response) => {
          if (response.ok) {
            const cache = await caches.open(APP_SHELL);
            cache.put(request, response.clone()).catch(() => {});
          }
          return response;
        });
        return cached ?? refresh;
      })(),
    );
    return;
  }

  // Other same-origin resources (skins, icons, etc.): network-first, caching only successful responses.
  event.respondWith(
    (async () => {
      try {
        const response = await fetch(request);
        if (response.ok && response.type === 'basic') {
          const cache = await caches.open(APP_SHELL);
          cache.put(request, response.clone()).catch(() => {});
        }
        return response;
      } catch {
        const cached = await caches.match(request);
        return cached ?? Response.error();
      }
    })(),
  );
});
