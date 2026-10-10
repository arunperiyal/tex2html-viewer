// The viewer's service worker. Built by vite.config.ts, which fills in the
// list of files to cache and the version.
//
//   <scope>decks/<folder>/<path>  imported decks, from the Origin Private File
//                                 System (decks/<folder>/<path>)
//   everything else in scope      the app itself: cached at install, so it
//                                 starts offline after the first visit
//
// Decks are served under the app's origin, so their relative paths
// (html/deck.js, figures/...) resolve as on a desktop.

const PRECACHE = __PRECACHE__;
const VERSION = __VERSION__;
const DEV = __DEV__;
const CACHE = `app-${VERSION}`;

const TYPES = {
  html: "text/html; charset=utf-8", css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8",
  json: "application/json", svg: "image/svg+xml", png: "image/png",
  jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
  mp4: "video/mp4", webm: "video/webm", pdf: "application/pdf", txt: "text/plain; charset=utf-8",
  webmanifest: "application/manifest+json",
};

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    if (!DEV) {
      const cache = await caches.open(CACHE);
      await cache.addAll(PRECACHE.map((f) => new URL(f, self.registration.scope).href));
    }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith("app-") && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  const scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  const rel = url.pathname.slice(scope.pathname.length);
  if (rel.startsWith("decks/")) e.respondWith(serveDeck(rel.slice(6)));
  else if (!DEV && e.request.method === "GET") e.respondWith(serveApp(e.request));
});

// ---------------------------------------------------------------- the app
async function serveApp(request) {
  const cache = await caches.open(CACHE);
  if (request.mode === "navigate") {            // the page: fresh if online
    try {
      return await fetch(request);
    } catch {
      return (await cache.match(new URL("./", self.registration.scope).href, { ignoreVary: true }))
        || offline();
    }
  }
  // hashed assets; ignoreVary: a module script is requested with an Origin
  // header that the cached request did not have (servers send Vary: Origin)
  return (await cache.match(request, { ignoreVary: true })) || fetch(request);
}

function offline() {
  return new Response("Offline, and the viewer is not cached yet.", { status: 503 });
}

// ---------------------------------------------------------------- decks
function pathParts(rel) {
  const parts = rel.split("/").map(decodeURIComponent);
  return parts.some((p) => !p || p === "." || p === "..") ? null : parts;
}

async function fileResponse(dir, parts) {
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
  const name = parts[parts.length - 1];
  const file = await (await dir.getFileHandle(name)).getFile();
  const ext = name.split(".").pop().toLowerCase();
  return new Response(file, {
    headers: { "Content-Type": TYPES[ext] || "application/octet-stream", "Cache-Control": "no-cache" },
  });
}

async function serveDeck(rel) {
  try {
    const parts = pathParts(rel);
    if (!parts) return notFound();
    const decks = await (await navigator.storage.getDirectory()).getDirectoryHandle("decks");
    return await fileResponse(decks, parts);
  } catch {
    return notFound();
  }
}

function notFound() {
  return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
}
