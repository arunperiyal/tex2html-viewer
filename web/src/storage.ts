// Decks in the Origin Private File System:
//
//   decks/<folder>/meta.json      written last: a folder without it is an
//   decks/<folder>/slides.html    unfinished import and is removed
//   decks/<folder>/html/...
//
// <folder> is the deck's name plus a timestamp, so a re-import writes a new
// folder and the old one is removed only when the new one is complete. The
// service worker (public/sw.js) serves decks/<folder>/<path> from here.

import { entryStream, readEntries, safePath, ZipError, type ZipEntry } from "./zip";

export interface Deck {
  kind: "imported";
  folder: string;
  name: string;          // from the pack's folder (or the zip's name)
  title: string;         // the deck's <title>
  bytes: number;
  files: number;
  importedAt: number;
}

export interface Progress {
  done: number;          // bytes written
  total: number;
}

const META = "meta.json";

async function decksDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle("decks", { create: true });
}

export async function listDecks(): Promise<Deck[]> {
  const dir = await decksDir();
  const decks: Deck[] = [];
  for await (const [name, h] of dir as unknown as AsyncIterable<[string, FileSystemHandle]>) {
    if (h.kind !== "directory") continue;
    try {
      const f = await (await (h as FileSystemDirectoryHandle).getFileHandle(META)).getFile();
      decks.push({ ...JSON.parse(await f.text()), kind: "imported" });
    } catch {
      await dir.removeEntry(name, { recursive: true }).catch(() => {});   // unfinished import
    }
  }
  return decks.sort((a, b) => b.importedAt - a.importedAt);
}

export async function deleteDeck(folder: string): Promise<void> {
  await (await decksDir()).removeEntry(folder, { recursive: true });
}

/** URL of the deck's page, served by the service worker. */
export function deckUrl(d: Deck): string {
  return `${import.meta.env.BASE_URL}decks/${encodeURIComponent(d.folder)}/slides.html`;
}

/** The pack's deck: the folder holding slides.html (the shallowest one). */
function findRoot(entries: ZipEntry[]): string {
  const pages = entries
    .map((e) => e.path)
    .filter((p) => p === "slides.html" || p.endsWith("/slides.html"))
    .sort((a, b) => a.split("/").length - b.split("/").length);
  if (!pages.length) throw new ZipError("no slides.html in this zip -- is it a tex2html --pack zip?");
  return pages[0].slice(0, -"slides.html".length);       // "" or "talk/"
}

function slug(s: string): string {
  return s.replace(/\.zip$/i, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "deck";
}

async function writeFile(dir: FileSystemDirectoryHandle, path: string,
                         data: ReadableStream<Uint8Array>, onChunk: (n: number) => void) {
  const parts = path.split("/");
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
  const fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
  const w = await fh.createWritable();
  const counted = data.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctl) { onChunk(chunk.byteLength); ctl.enqueue(chunk); },
  }));
  await counted.pipeTo(w);                                // closes the file
}

/** Import a --pack zip. Replaces a deck of the same name once complete. */
export async function importZip(file: File, onProgress: (p: Progress) => void,
                                signal?: AbortSignal): Promise<Deck> {
  const entries = await readEntries(file);
  const root = findRoot(entries);
  const files: { entry: ZipEntry; path: string }[] = [];
  for (const e of entries) {
    if (e.isDir || !e.path.startsWith(root)) continue;
    const path = safePath(e.path.slice(root.length));
    if (!path || e.isSymlink) throw new ZipError(`unsafe entry in the zip: ${e.path}`);
    if (e.encrypted) throw new ZipError("encrypted zips are not supported");
    files.push({ entry: e, path });
  }
  const total = files.reduce((n, f) => n + f.entry.size, 0);

  const est = await navigator.storage.estimate();
  if (est.quota !== undefined && est.usage !== undefined && est.quota - est.usage < total * 1.05) {
    throw new ZipError(`not enough storage: the deck needs ${mb(total)}, ` +
                       `${mb(est.quota - est.usage)} is free`);
  }
  await navigator.storage.persist?.().catch(() => false);   // keep big decks from eviction

  const name = slug(root.replace(/\/$/, "") || file.name);
  const folder = `${name}-${Date.now()}`;
  const decks = await decksDir();
  const dir = await decks.getDirectoryHandle(folder, { create: true });
  let done = 0;
  try {
    for (const f of files) {
      if (signal?.aborted) throw new DOMException("import cancelled", "AbortError");
      await writeFile(dir, f.path, await entryStream(file, f.entry), (n) => {
        done += n;
        onProgress({ done, total });
      });
    }
    const page = await (await dir.getFileHandle("slides.html")).getFile();
    const title = /<title>([^<]*)<\/title>/i.exec(await page.text())?.[1]?.trim() || name;
    const deck: Deck = { kind: "imported", folder, name, title: decodeEntities(title), bytes: total,
                         files: files.length, importedAt: Date.now() };
    const w = await (await dir.getFileHandle(META, { create: true })).createWritable();
    await w.write(JSON.stringify(deck));
    await w.close();
    for (const old of await listDecks()) {                  // the replaced deck
      if (old.name === name && old.folder !== folder) await deleteDeck(old.folder);
    }
    return deck;
  } catch (err) {
    await decks.removeEntry(folder, { recursive: true }).catch(() => {});
    throw err;
  }
}

export function mb(n: number): string {
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(0.1, n / 1e6).toFixed(1)} MB`;
}

function decodeEntities(s: string): string {
  const t = document.createElement("textarea");
  t.innerHTML = s;
  return t.value;
}
