// ── Nutrì — Service Worker ────────────────────────────
// Aggiorna CACHE_VERSION ad ogni deploy per invalidare la cache vecchia
const CACHE_VERSION = 'nutri-v3';

// Solo assets statici che cambiano raramente (icone, font)
// NON cacheamo JS/CSS per evitare che versioni vecchie blocchino gli aggiornamenti
const STATIC_ASSETS = [
  '/nutri/assets/icon-192.png',
  '/nutri/assets/favicon-32.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_VERSION)
      .then(c => c.addAll(STATIC_ASSETS))
      .catch(() => {}) // non critico
  );
  // Forza attivazione immediata senza aspettare che le vecchie tab si chiudano
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  // Rimuovi TUTTE le vecchie cache (versioni precedenti)
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // JS, CSS, HTML: sempre dalla rete (no cache) — garantisce aggiornamenti immediati
  if (url.pathname.endsWith('.js') ||
      url.pathname.endsWith('.css') ||
      url.pathname.endsWith('.html') ||
      url.pathname === '/nutri/' ||
      url.hostname.includes('supabase.co') ||
      url.hostname.includes('fonts.googleapis.com')) {
    return; // lascia passare alla rete normalmente
  }

  // Solo per assets statici (icone PNG ecc.) usa cache-first
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});

// ── Push notifications ────────────────────────────────
self.addEventListener('push', e => {
  const data = e.data?.json() || {
    title: 'Nutrì 🌿',
    body: 'Ricordati di confermare i tuoi pasti di oggi!'
  };
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body:    data.body,
      icon:    '/nutri/assets/icon-192.png',
      badge:   '/nutri/assets/favicon-32.png',
      tag:     'nutri-reminder',
      renotify: true,
      data:    { url: '/nutri/' },
      actions: [{ action: 'open', title: 'Apri Nutrì' }]
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.openWindow(e.notification.data?.url || '/nutri/'));
});
