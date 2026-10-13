/* SAGAR-NETRA citizen app — offline shell.

   Strategy matters here. A naive cache-first worker will happily serve a stale
   index.html forever, so edits to the app never appear (this bit us once).

     HTML / navigation  -> network-first, fall back to cache when offline
     static assets      -> cache-first (icons, manifest)

   Bump CACHE whenever the shell list changes.
*/
const CACHE = "sagar-netra-v5";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon.svg",
  "./icon-maskable.svg"
];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", e => {
  if (e.data === "skipWaiting") self.skipWaiting();
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // never touch CDN calls
  // Never cache the API: responses are private, per-user and must be fresh
  // (report history, authorised images, session state).
  if (url.pathname.startsWith("/api/")) return;

  // HTML and the shared client script are network-first so fixes reach users.
  const isDoc = req.mode === "navigate" || url.pathname.startsWith("/shared/") ||
                (req.headers.get("accept") || "").includes("text/html");

  if (isDoc) {
    // network-first: always prefer fresh HTML, fall back to cache offline
    e.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then(hit => hit || caches.match("./index.html")))
    );
    return;
  }

  // static assets: cache-first, refresh in background
  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy));
      return res;
    }))
  );
});
