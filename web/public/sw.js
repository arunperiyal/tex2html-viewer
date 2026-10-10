// Serves imported decks from the Origin Private File System:
// <scope>decks/<folder>/<path>  ->  OPFS decks/<folder>/<path>
// so a deck's relative paths (html/deck.js, figures/...) resolve as on a
// desktop. Everything else goes to the network as usual.

const TYPES = {
  html: "text/html; charset=utf-8", css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8",
  json: "application/json", svg: "image/svg+xml", png: "image/png",
  jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
  mp4: "video/mp4", webm: "video/webm", pdf: "application/pdf", txt: "text/plain; charset=utf-8",
};

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  const prefix = new URL("decks/", self.registration.scope).pathname;
  if (url.origin !== location.origin || !url.pathname.startsWith(prefix)) return;
  e.respondWith(serve(url.pathname.slice(prefix.length)));
});

async function serve(rel) {
  try {
    const parts = rel.split("/").map(decodeURIComponent);
    if (parts.some((p) => !p || p === "." || p === "..")) return notFound();
    let dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("decks");
    for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
    const file = await (await dir.getFileHandle(parts[parts.length - 1])).getFile();
    const ext = parts[parts.length - 1].split(".").pop().toLowerCase();
    return new Response(file, {
      headers: { "Content-Type": TYPES[ext] || "application/octet-stream",
                 "Cache-Control": "no-cache" },
    });
  } catch {
    return notFound();
  }
}

function notFound() {
  return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
}
