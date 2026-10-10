// The viewer's service worker. Built by vite.config.ts, which fills in the
// list of files to cache and the version.
//
//   <scope>decks/<folder>/<path>  imported decks, read from their zip in the
//                                 Origin Private File System (decks/<folder>/
//                                 pack.zip + index.json; older decks unpacked);
//                                 Range requests are answered (a video seeks
//                                 with them) for files stored uncompressed
//   <scope>native/<id>/<path>     decks kept by the Android app: left to it
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
  mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime",
  ogv: "video/ogg", pdf: "application/pdf", txt: "text/plain; charset=utf-8",
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
  if (rel.startsWith("native/")) return;           // the Android app serves these
  if (rel.startsWith("decks/")) e.respondWith(serveDeck(rel.slice(6), e.request.headers.get("Range")));
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

function contentType(path) {
  return TYPES[path.split(".").pop().toLowerCase()] || "application/octet-stream";
}

/** A blob as the response to a request with an optional Range header:
 * 206 with the asked part ("bytes=a-b", "bytes=a-", "bytes=-n"), 416 if it
 * is outside the blob, else the whole blob. */
function blobResponse(blob, type, range) {
  const headers = { "Content-Type": type, "Cache-Control": "no-cache", "Accept-Ranges": "bytes" };
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!m || (!m[1] && !m[2])) {
    return new Response(blob, { headers: { ...headers, "Content-Length": String(blob.size) } });
  }
  const size = blob.size;
  let start, end;
  if (m[1]) {
    start = +m[1];
    end = m[2] ? Math.min(+m[2], size - 1) : size - 1;
  } else {                                       // the last n bytes
    start = Math.max(0, size - +m[2]);
    end = size - 1;
  }
  if (start >= size || start > end) {
    return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
  }
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`,
               "Content-Length": String(end - start + 1) },
  });
}

async function fileResponse(dir, parts, range) {
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
  const name = parts[parts.length - 1];
  const file = await (await dir.getFileHandle(name)).getFile();
  return blobResponse(file, contentType(name), range);
}

// open packs: folder -> { file, entries, starts }, read once per worker
const packs = new Map();

async function openPack(dir, folder) {
  if (packs.has(folder)) return packs.get(folder);
  let pack = null;
  try {
    const index = JSON.parse(await (await (await dir.getFileHandle("index.json")).getFile()).text());
    const file = await (await dir.getFileHandle("pack.zip")).getFile();
    pack = { file, entries: index.entries, starts: new Map() };
  } catch { /* an older deck, unpacked */ }
  packs.set(folder, pack);
  return pack;
}

/** A file of a deck, read from its zip: the index gives the entry's local
 * header; the data follows it (stored as is, or deflated). */
async function servePacked(pack, path, range) {
  const e = pack.entries[path];
  if (!e) return notFound();
  const [header, method, compressedSize] = e;
  let start = pack.starts.get(path);
  if (start === undefined) {
    const h = new DataView(await pack.file.slice(header, header + 30).arrayBuffer());
    start = header + 30 + h.getUint16(26, true) + h.getUint16(28, true);
    pack.starts.set(path, start);
  }
  const data = pack.file.slice(start, start + compressedSize);
  if (method === 0) return blobResponse(data, contentType(path), range);   // videos: stored
  if (method !== 8) return notFound();
  return new Response(data.stream().pipeThrough(new DecompressionStream("deflate-raw")), {
    headers: { "Content-Type": contentType(path), "Cache-Control": "no-cache" },
  });
}

async function serveDeck(rel, range) {
  try {
    const parts = pathParts(rel);
    if (!parts || parts.length < 2) return notFound();
    const decks = await (await navigator.storage.getDirectory()).getDirectoryHandle("decks");
    const dir = await decks.getDirectoryHandle(parts[0]);
    const pack = await openPack(dir, parts[0]);
    if (pack) return await servePacked(pack, parts.slice(1).join("/"), range);
    return await fileResponse(decks, parts, range);
  } catch {
    return notFound();
  }
}

function notFound() {
  return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
}
