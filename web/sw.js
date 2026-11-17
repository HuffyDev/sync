// LASTSYNC service worker: keeps the app usable in this browser with no
// connection. Everything is fetched from the network first (so you always get
// the latest when online) and falls back to the last saved copy when offline.
// Big static files (map data, libraries, tiles, images) are served from cache.
const CACHE = 'lastsync-v6';
const SHELL = [
  '/', '/styles.css', '/app.js', '/shared.js', '/basemap.js', '/mapstyle.js', '/nmea.js', '/ai.js', '/offline.js',
  '/views-library.js', '/views-map.js', '/views-plan.js', '/views-group.js', '/views-packs.js', '/views-extra.js', '/views-source.js', '/views-relay.js',
  '/logo.png', '/logo-64.png', '/icon-192.png', '/manifest.webmanifest',
  '/vendor/leaflet/leaflet.js', '/vendor/leaflet/leaflet.css', '/vendor/topojson-client.min.js', '/vendor/qrcode.js',
  '/vendor/countries-110m.json', '/vendor/countries-50m.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('lastsync-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

const CACHE_FIRST = /^\/(vendor\/|tiles\/|files\/wiki\/|icon)/;
const NEVER = /^\/(api\/group\/events|api\/packs\/download|files\/library)/;

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || NEVER.test(url.pathname)) return;
  if (CACHE_FIRST.test(url.pathname)) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => { if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone())); return res; })));
    return;
  }
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok && res.status === 200) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(async () => (await caches.match(req)) || (req.mode === 'navigate' ? caches.match('/') : Response.json({ error: 'You are offline and this has not been saved on this device yet.', offline: true }, { status: 503 }))),
  );
});
