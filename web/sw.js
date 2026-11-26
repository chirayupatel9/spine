// Service worker: makes Album Viewer installable, opens it instantly from this device's copy, and
// keeps it usable offline.
//   - style.css / app.js arrive as ?v=<deploy>, so a copy never goes stale: served from cache.
//   - The page itself: from the network, unless that takes longer than a moment; then this device's
//     copy, while the network one is saved for next time.
//   - Covers and fonts: from cache once seen.
const CACHE = "albumviewer-shell-v3";
const ART_CACHE = "albumviewer-art";
const FONT_CACHE = "albumviewer-fonts";
const DATA_CACHE = "albumviewer-data";   // the page keeps the last shelf here (see app.js)
const KEEP = [CACHE, ART_CACHE, FONT_CACHE, DATA_CACHE];
const SHELL = ["/", "/manifest.webmanifest", "/icon.svg", "/icon-192.png"];   // style.css/app.js: cached as ?v= on first use
const PAGE_WAIT_MS = 1200;

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => !KEEP.includes(k)).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const storable = res => res.ok && res.type === "basic" && !res.redirected;   // never a sign-in redirect

async function save(req, res) {
  const c = await caches.open(CACHE);
  const url = new URL(req.url);
  if (url.search) {   // keep only the current ?v= of each file
    for (const k of await c.keys()) {
      const ku = new URL(k.url);
      if (ku.pathname === url.pathname && ku.search !== url.search) c.delete(k);
    }
  }
  await c.put(req, res);
}

async function cacheFirst(req, cacheName) {
  const c = await caches.open(cacheName);
  const hit = await c.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === "opaque") c.put(req, res.clone());
  return res;
}

function pageFirst(req) {
  return new Promise(resolve => {
    let settled = false;
    const finish = res => { if (!settled && res) { settled = true; resolve(res); } };
    const net = fetch(req).then(res => {
      if (storable(res)) save(req, res.clone());
      return res;
    });
    const timer = setTimeout(async () => finish(await caches.match(req, { ignoreSearch: true })), PAGE_WAIT_MS);
    net.then(res => { clearTimeout(timer); finish(res); })
       .catch(async () => { clearTimeout(timer); finish((await caches.match(req, { ignoreSearch: true })) || Response.error()); });
  });
}

self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET") return;
  if (url.origin === "https://fonts.googleapis.com" || url.origin === "https://fonts.gstatic.com") {
    e.respondWith(cacheFirst(req, FONT_CACHE));
    return;
  }
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith("/art/")) { e.respondWith(cacheFirst(req, ART_CACHE)); return; }
  if ((url.pathname === "/style.css" || url.pathname === "/app.js") && url.searchParams.has("v")) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => { if (storable(res)) save(req, res.clone()); return res; })));
    return;
  }
  if (url.pathname === "/") { e.respondWith(pageFirst(req)); return; }
  if (SHELL.includes(url.pathname)) {   // other shell files: network first, cache when offline
    e.respondWith(fetch(req).then(res => { if (storable(res)) save(req, res.clone()); return res; })
      .catch(() => caches.match(req)));
  }
  // everything else (API, audio streams) goes straight to the network
});
