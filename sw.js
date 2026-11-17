const CACHE = 'meici-shell-v5';
const ASSETS = ['./', './index.html', './src/styles.css', './src/app.mjs', './src/domain.mjs', './src/storage.mjs', './src/insights.mjs', './manifest.webmanifest', './public/icon.svg', './public/icon-maskable.svg', './public/icon-192.png', './public/icon-512.png', './public/icon-maskable-512.png'];
// 更新离线包时跳过浏览器的旧 HTTP 缓存，避免新缓存名装入旧版代码。
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS.map(path => new Request(path, { cache: 'reload' }))))));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('meici-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
});
