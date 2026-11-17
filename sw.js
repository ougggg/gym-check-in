const CACHE = 'meici-shell-v4';
const ASSETS = ['./', './index.html', './src/styles.css', './src/app.mjs', './src/domain.mjs', './src/storage.mjs', './src/insights.mjs', './manifest.webmanifest', './public/icon.svg', './public/icon-maskable.svg', './public/icon-192.png', './public/icon-512.png', './public/icon-maskable-512.png'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS))));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('meici-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
});
