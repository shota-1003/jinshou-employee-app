'use strict';

// アプリの見た目(HTML/CSS/JS)だけをキャッシュするapp-shell方式。申請データ自体は
// 常にオンラインでSupabaseへ直接送るため、APIレスポンスはキャッシュしない。
const CACHE_NAME = 'jinshou-employee-app-v1';
const SHELL_FILES = ['./', './index.html', './style.css', './app.js', './manifest.json', './icons/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // Supabase API等の外部通信はキャッシュしない
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request)),
  );
});
