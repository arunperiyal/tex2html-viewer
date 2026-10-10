// Decks in the browser's Origin Private File System, read straight from
// their zip:
//
//   decks/<folder>/pack.zip     the pack, copied as one file
//   decks/<folder>/index.json   where each file is in it: {root, entries:
//                               {path: [header offset, method, compressed
//                               size, size]}}
//   decks/<folder>/meta.json    written last: a folder without it is an
//                               unfinished import and is removed
//
// The service worker (src/sw.js) serves decks/<folder>/<path> from the zip,
// so nothing is unpacked: an import is one sequential copy. Decks imported
// before this (unpacked into the folder) are still served as they are.
//
// <folder> is the deck's name plus a timestamp, so a re-import writes a new
// folder and the old one is removed only when the new one is complete.
//
// In the Android app, decks are kept natively instead (android/.../DeckStore.kt)
// and come in through window.TexViewer; this module then only lists, opens and
// deletes the decks the app imported into browser storage before.

import { entryStream, readEntries, safePath, ZipError, type ZipEntry } from "./zip";

export interface Deck {
  folder: string;        // decks/<folder>, or the app's deck id
  name: string;          // from the pack's folder (or the zip's name)
  title: string;         // the deck's <title>
  bytes: number;
  importedAt: number;
  app?: boolean;         // kept by the Android app (served under native/)
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
      decks.push(JSON.parse(await f.text()));
    } catch {
      await dir.removeEntry(name, { recursive: true }).catch(() => {});   // unfinished import
    }
  }
  return decks.sort((a, b) => b.importedAt - a.importedAt);
}

export async function deleteDeck(folder: string): Promise<void> {
  await (await decksDir()).removeEntry(folder, { recursive: true });
}

/** URL of the deck's page: served by the service worker, or by the app. */
export function deckUrl(d: Deck): string {
  return `${import.meta.env.BASE_URL}${d.app ? "native" : "decks"}/${encodeURIComponent(d.folder)}/slides.html`;
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

async function writeText(dir: FileSystemDirectoryHandle, name: string, text: string) {
  const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await w.write(text);
  await w.close();
}

/** Import a --pack zip. Replaces a deck of the same name once complete. */
export async function importZip(file: File, onProgress: (p: Progress) => void,
                                signal?: AbortSignal): Promise<Deck> {
  const entries = await readEntries(file);
  const root = findRoot(entries);
  const index: Record<string, [number, number, number, number]> = {};
  for (const e of entries) {
    if (e.isDir || !e.path.startsWith(root)) continue;
    const path = safePath(e.path.slice(root.length));
    if (!path || e.isSymlink) throw new ZipError(`unsafe entry in the zip: ${e.path}`);
    if (e.encrypted) throw new ZipError("encrypted zips are not supported");
    index[path] = [e.headerOffset, e.method, e.compressedSize, e.size];
  }
  const page = entries.find((e) => e.path === `${root}slides.html`)!;
  const html = await new Response(await entryStream(file, page)).text();
  const name = slug(root.replace(/\/$/, "") || file.name);
  const title = decodeEntities(/<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() || name);

  const total = file.size;
  const est = await navigator.storage.estimate();
  if (est.quota !== undefined && est.usage !== undefined && est.quota - est.usage < total * 1.05) {
    throw new ZipError(`not enough storage: the deck needs ${mb(total)}, ` +
                       `${mb(est.quota - est.usage)} is free`);
  }
  await navigator.storage.persist?.().catch(() => false);   // keep big decks from eviction

  const folder = `${name}-${Date.now()}`;
  const decks = await decksDir();
  const dir = await decks.getDirectoryHandle(folder, { create: true });
  try {
    // the zip as it is, in one go
    const w = await (await dir.getFileHandle("pack.zip", { create: true })).createWritable();
    let done = 0;
    await file.stream().pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) {
        done += chunk.byteLength;
        onProgress({ done, total });
        ctl.enqueue(chunk);
      },
    })).pipeTo(w, { signal });
    await writeText(dir, "index.json", JSON.stringify({ root, entries: index }));
    const deck: Deck = { folder, name, title, bytes: total, importedAt: Date.now() };
    await writeText(dir, META, JSON.stringify(deck));
    for (const old of await listDecks()) {                  // the replaced deck
      if (old.name === name && old.folder !== folder) await deleteDeck(old.folder);
    }
    return deck;
  } catch (err) {
    await decks.removeEntry(folder, { recursive: true }).catch(() => {});
    if (signal?.aborted) throw new DOMException("import cancelled", "AbortError");
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
