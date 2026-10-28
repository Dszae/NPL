const CACHE_NAME = 'sportivo-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) return caches.delete(key);
        })
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Never cache API or live stream chunks
  if (event.request.url.includes('/api/') || event.request.url.includes('.m3u8') || event.request.url.includes('.ts')) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      return (
        cached ||
        fetch(event.request).catch(() => caches.match('/index.html'))
      );
    })
  );
});

self.addEventListener('push', (event) => {
  let data = {
    title: '🏏 Sportivo Cricket Alert',
    message: 'New match update!',
    type: 'INFO',
  };

  if (event.data) {
    try {
      data = event.data.json();
    } catch {
      data.message = event.data.text();
    }
  }

  const title = data.title || '🏏 Sportivo NPL Alert';
  const options = {
    body: data.message || (data.score ? `Score: ${data.score} (${data.overs || ''} ov)` : 'Live match update!'),
    icon: '/og-image.jpg',
    badge: '/og-image.jpg',
    tag: data.tag || 'sportivo-alert-' + Date.now(),
    renotify: true,
    requireInteraction: true,
    vibrate: data.type === 'WICKET' ? [300, 100, 300, 100, 400] : [200, 100, 200],
    data: {
      url: data.url || '/',
    },
    actions: [
      { action: 'open', title: '🔴 Watch Live' },
      { action: 'close', title: 'Dismiss' },
    ],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes('/') && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow('/');
      }
    })
  );
});

