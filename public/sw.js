const CACHE_NAME = 'sportivo-v4';
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
  // Never cache API or live stream chunks (HLS & MPEG-DASH)
  if (
    event.request.url.includes('/api/') ||
    event.request.url.includes('.m3u8') ||
    event.request.url.includes('.ts') ||
    event.request.url.includes('.mpd') ||
    event.request.url.includes('.m4v')
  ) {
    return;
  }

  // Network-First for HTML/Navigation: Always load fresh live stream configs from server!
  if (
    event.request.mode === 'navigate' ||
    event.request.destination === 'document' ||
    event.request.url.endsWith('/') ||
    event.request.url.includes('index.html')
  ) {
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return networkResponse;
        })
        .catch(() => caches.match(event.request) || caches.match('/index.html'))
    );
    return;
  }

  // Stale-While-Revalidate for other static assets
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetchPromise = fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, networkResponse.clone()));
          }
          return networkResponse;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});

// Web Push Notification Listener
// ONLY displays desktop/OS notification when the user is NOT actively watching the stream!
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
    tag: data.tag || 'sportivo-alert-' + (data.ball || data.id || Date.now()),
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

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Check if user is currently watching (tab is open and visible on screen)
      const isWatching = clientList.some((client) => client.visibilityState === 'visible');

      if (isWatching) {
        console.log('[SW] Push received, but user is actively watching. Suppressing OS notification.');
        return;
      }

      // User is NOT watching (tab in background, minimized, on another tab/app, or browser/tab closed)
      return self.registration.showNotification(title, options);
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  if (event.action === 'close') {
    return;
  }

  const targetUrl = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
