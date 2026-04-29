// ── Nutrì — Service Worker ────────────────────────────
const CACHE = 'nutri-v1';
const ASSETS = [
  '/nutri/',
  '/nutri/index.html',
  '/nutri/css/style.css',
  '/nutri/js/app.js',
  '/nutri/js/nutrition.js',
  '/nutri/js/supabase.js',
  '/nutri/assets/icon-192.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Network first per API Supabase, cache first per assets
  if (e.request.url.includes('supabase.co')) return;
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});

// ── Push notifications ────────────────────────────────
self.addEventListener('push', e => {
  const data = e.data?.json() || { title: 'Nutrì', body: 'Ricordati di confermare i tuoi pasti!' };
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/nutri/assets/icon-192.png',
      badge: '/nutri/assets/favicon-32.png',
      tag: 'nutri-reminder',
      renotify: true,
      data: { url: '/nutri/' },
      actions: [{ action: 'open', title: 'Apri Nutrì' }]
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.openWindow(e.notification.data?.url || '/nutri/'));
});
