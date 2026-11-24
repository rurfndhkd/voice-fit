// 오프라인에서도 앱 화면이 열리도록 정적 파일을 캐시한다. /api 요청은 캐시하지 않는다.
const CACHE = 'voicefit-v16-voice';
const ASSETS = [
  '/', '/index.html', '/styles.css', '/manifest.webmanifest', '/icon.svg',
  '/js/intent.js',
  '/js/app.js', '/js/ai.js', '/js/store.js', '/js/speech.js', '/js/parser-local.js', '/js/schema.js', '/js/themes.js',
  '/js/config.js', '/js/format.js', '/js/wake.js', '/js/counting.js', '/js/dialogs.js', '/js/phone.js', '/js/background.js', '/js/understand.js', '/js/mic.js', '/js/commands.js', '/js/summary.js', '/js/answer.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// 네트워크 우선, 실패하면 캐시 (개발 중 수정 사항이 바로 보이도록)
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('/index.html'))),
  );
});
