// Minimal service worker: makes Album Viewer installable and keeps the app shell available offline.
const CACHE = "albumviewer-shell-v2";
const ART_CACHE = "albumviewer-art";
const SHELL = ["/", "/style.css", "/app.js", "/manifest.webmanifest", "/icon.svg", "/icon-192.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {   // drop old shell caches, keep the covers
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== ART_CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/art/")) {           // covers: cache first
    e.respondWith(caches.open(ART_CACHE).then(async c => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) c.put(e.request, res.clone());
      return res;
    }));
    return;
  }
  if (SHELL.includes(url.pathname)) {               // shell: network first, cache fallback for offline
    e.respondWith(fetch(e.request).then(res => {
      if (res.ok && res.type === "basic" && !res.redirected) {   // never store a sign-in redirect
        const copy = res.clone();
        caches.open(CACHE).then(async c => {
          // style.css and app.js come as ?v=<deploy>: keep only the current one of each
          for (const k of await c.keys()) {
            const ku = new URL(k.url);
            if (ku.pathname === url.pathname && ku.search !== url.search) c.delete(k);
          }
          await c.put(e.request, copy);
        });
      }
      return res;
    }).catch(() => caches.match(e.request)));
  }
  // everything else (API, audio streams) goes straight to the network
});
