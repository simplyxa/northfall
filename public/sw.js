// Northfall service worker: быстрая загрузка и работа при плохой связи
const V = 'nf-v1';
const CORE = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

const put = (req, res) => { if (res && res.ok) { const c = res.clone(); caches.open(V).then(x => x.put(req, c)); } return res; };

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  // Сервер игры, база и вход — всегда напрямую
  if (u.pathname.startsWith('/.netlify/') || /firestore|identitytoolkit|securetoken|xsolla/.test(u.hostname)) return;

  // Страница игры: сначала сеть (чтобы обновления приходили сразу), при плохой связи — из кэша
  if (req.mode === 'navigate' || (u.origin === location.origin && (u.pathname === '/' || u.pathname === '/index.html'))) {
    e.respondWith(new Promise(resolve => {
      let done = false;
      const fromCache = () => caches.match('/').then(r => { if (!done && r) { done = true; resolve(r); } });
      const t = setTimeout(fromCache, 3500);
      fetch(req).then(r => { clearTimeout(t); put('/', r.clone()); if (!done) { done = true; resolve(r); } })
        .catch(() => { clearTimeout(t); caches.match('/').then(r => { if (!done) { done = true; resolve(r || Response.error()); } }); });
    }));
    return;
  }

  // Библиотеки Firebase, шрифты, иконки — из кэша, обновляются в фоне
  if (u.hostname === 'www.gstatic.com' || u.hostname.endsWith('fonts.googleapis.com') || u.hostname.endsWith('fonts.gstatic.com') || u.origin === location.origin) {
    e.respondWith(caches.match(req).then(hit => {
      const net = fetch(req).then(r => put(req, r)).catch(() => hit);
      return hit || net;
    }));
  }
});
