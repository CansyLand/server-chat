const CACHE = 'xqlytskg-shell';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first for the app shell: this project is under active development,
// so every load must pick up whatever was last deployed. The cache is only
// an offline fallback — it must never be the reason a device gets stuck on
// an old version (that's exactly what a cache-first strategy did before).
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Claude', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Claude';
  const body = data.body || 'New message';
  const unread = typeof data.unread === 'number' ? data.unread : undefined;
  const agentId = typeof data.agentId === 'string' ? data.agentId : null;

  event.waitUntil(
    (async () => {
      await self.registration.showNotification(title, {
        body,
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        tag: agentId || 'xqlytskg-chat',
        renotify: true,
        data: { agentId },
      });
      if (unread !== undefined && 'setAppBadge' in self.navigator) {
        try {
          if (unread > 0) await self.navigator.setAppBadge(unread);
          else await self.navigator.clearAppBadge();
        } catch {
          /* Badging API not available on this platform */
        }
      }
    })()
  );
});

self.addEventListener('notificationclick', (event) => {
  const agentId = event.notification.data?.agentId || null;
  event.notification.close();
  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of allClients) {
        if ('focus' in client) {
          client.postMessage({ type: 'notification-click', agentId });
          return client.focus();
        }
      }
      // No running tab to postMessage into (app was fully closed, common on
      // iOS) — fall back to a URL param so the fresh page load can deep-link
      // once it boots, instead of silently landing on the plain agent list.
      if (self.clients.openWindow) {
        return self.clients.openWindow(agentId ? `/?agent=${encodeURIComponent(agentId)}` : '/');
      }
    })()
  );
});
