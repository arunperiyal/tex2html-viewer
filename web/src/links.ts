// Linked folders: a deck read in place from a folder on the device, without a
// copy. Desktop Chrome and Edge only (showDirectoryPicker); phone browsers
// cannot keep access to a folder, so they import zips.
//
// The folder handle is kept in IndexedDB ("tex2html-viewer", store "links");
// the service worker reads the deck's files through it (src/sw.js).

export interface LinkedDeck {
  kind: "linked";
  id: string;
  name: string;           // the folder's name
  title: string;          // the deck's <title>
  root: string;           // "" or the subfolder holding slides.html
  linkedAt: number;
  handle: FileSystemDirectoryHandle;
}

// not in TypeScript's DOM library yet (File System Access API)
type Permission = "granted" | "denied" | "prompt";
interface PermissionHandle {
  queryPermission(o: { mode: "read" }): Promise<Permission>;
  requestPermission(o: { mode: "read" }): Promise<Permission>;
}
declare global {
  interface Window {
    showDirectoryPicker?(o?: { id?: string; mode?: "read" }): Promise<FileSystemDirectoryHandle>;
  }
}

export class FolderError extends Error {}

export const canLinkFolders = typeof window !== "undefined" && "showDirectoryPicker" in window;

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("tex2html-viewer", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("links", { keyPath: "id" });
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

async function store<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = f(d.transaction("links", mode).objectStore("links"));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  });
}

export async function listLinks(): Promise<LinkedDeck[]> {
  return store<LinkedDeck[]>("readonly", (s) => s.getAll());
}

export async function unlink(id: string): Promise<void> {
  await store("readwrite", (s) => s.delete(id));
}

/** The deck in a folder: slides.html in it, or in one of its subfolders
 * (the folder a --pack zip unpacks to). Returns the root path and title. */
async function findDeck(dir: FileSystemDirectoryHandle): Promise<{ root: string; title: string }> {
  const title = async (d: FileSystemDirectoryHandle) => {
    const text = await (await (await d.getFileHandle("slides.html")).getFile()).text();
    const t = /<title>([^<]*)<\/title>/i.exec(text)?.[1]?.trim();
    const el = document.createElement("textarea");
    el.innerHTML = t || dir.name;
    return el.value;
  };
  try {
    return { root: "", title: await title(dir) };
  } catch { /* not here: look one level down */ }
  for await (const [name, h] of dir as unknown as AsyncIterable<[string, FileSystemHandle]>) {
    if (h.kind !== "directory") continue;
    try {
      return { root: name, title: await title(h as FileSystemDirectoryHandle) };
    } catch { /* next */ }
  }
  throw new FolderError("no slides.html in this folder -- pick the folder of an unpacked tex2html pack");
}

/** Link a folder handle (from the picker, or from a test). Replaces the link
 * with the given id when relinking. */
export async function linkFolderHandle(handle: FileSystemDirectoryHandle, id?: string): Promise<LinkedDeck> {
  const { root, title } = await findDeck(handle);
  const deck: LinkedDeck = {
    kind: "linked", id: id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: handle.name, title, root, linkedAt: Date.now(), handle,
  };
  await store("readwrite", (s) => s.put(deck));
  return deck;
}

/** Ask for a folder and link it. null if the user cancelled. */
export async function linkFolder(id?: string): Promise<LinkedDeck | null> {
  try {
    const handle = await window.showDirectoryPicker!({ id: "tex2html-decks", mode: "read" });
    return await linkFolderHandle(handle, id);
  } catch (e) {
    if ((e as Error).name === "AbortError") return null;
    throw e;
  }
}

/** Make sure the folder can be read: asks for permission if needed (call
 * from a click), and checks the deck is still there. */
export async function ensureReadable(d: LinkedDeck): Promise<void> {
  const h = d.handle as unknown as PermissionHandle;
  let p = await h.queryPermission({ mode: "read" });
  if (p !== "granted") p = await h.requestPermission({ mode: "read" });
  if (p !== "granted") throw new FolderError("permission to read the folder was not given");
  try {
    let dir = d.handle;
    if (d.root) dir = await dir.getDirectoryHandle(d.root);
    await dir.getFileHandle("slides.html");
  } catch {
    throw new FolderError("folder not found -- it was moved, renamed or deleted");
  }
}

export function linkUrl(d: LinkedDeck): string {
  return `${import.meta.env.BASE_URL}links/${encodeURIComponent(d.id)}/slides.html`;
}
