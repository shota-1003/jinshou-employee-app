'use strict';

// アプリの見た目(HTML/CSS/JS)だけをキャッシュするapp-shell方式。申請データ自体は
// 常にオンラインでSupabaseへ直接送るため、APIレスポンスはキャッシュしない。
//
// 2026-08-25: ネットワーク優先(network-first)へ変更した。以前はcaches.matchを
// 常に優先するcache-firstだったため、SHELL_FILESの1つでも過去にインストール中に
// 404等で失敗すると(cache.addAllはアトミックで1件でも失敗すると全体が失敗する)、
// 端末がその時点の古い/壊れたキャッシュへ永久に固定されてしまう不具合があった
// (実機で「CSSが一切当たらずHTMLだけの崩れた画面になる」という報告があった)。
// ネットワークが使える限り常に最新のファイルを取得し、オフライン時だけキャッシュへ
// フォールバックする方式にすることで、この種の「古いキャッシュに固定される」問題を
// 自己修復できるようにした。
const CACHE_NAME = 'jinshou-employee-app-v43';
const SHELL_FILES = [
  './', './index.html', './style.css', './app.js', './icons.js', './manifest.json',
  './icons/app-icon-180-v2.png', './icons/icon-192-v2.png', './icons/icon-512-v2.png', './icons/icon-512-maskable-v2.png',
  './icons/favicon-32-v2.png', './icons/favicon-16-v2.png',
  './brand/logo-gold.png', './brand/logo-navy.png', './brand/logo-white.png',
];

self.addEventListener('install', (event) => {
  // 1つのファイルが取得できなくても他のファイルのキャッシュ登録は続ける
  // (cache.addAllのアトミック失敗で更新全体が止まらないようにする)。
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => Promise.all(
      SHELL_FILES.map((file) => cache.add(file).catch(() => null)),
    )),
  );
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
  if (event.request.method !== 'GET') return;

  // {cache: 'reload'}でブラウザのHTTPキャッシュ(GitHub Pagesのmax-age等)を無視して
  // 必ずネットワークへ再取得しにいく。これを指定しないと、SW自体はnetwork-firstでも
  // 内部のfetch()がブラウザのHTTPキャッシュから「新鮮」と判定された古い応答を返して
  // しまい、結局古い内容が表示され続けることがある(実機で確認)。
  event.respondWith(
    fetch(event.request, { cache: 'reload' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request)),
  );
});
