import {
  canLinkFolders, ensureReadable, FolderError, linkFolder, linkFolderHandle, linkUrl,
  listLinks, unlink, type LinkedDeck,
} from "./links";
import { deckUrl, deleteDeck, importZip, listDecks, mb, type Deck } from "./storage";

type AnyDeck = Deck | LinkedDeck;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const fileInput = $<HTMLInputElement>("file");
const drop = $<HTMLLabelElement>("drop");
const linkButton = $<HTMLButtonElement>("link");
const list = $<HTMLUListElement>("decks");
const empty = $<HTMLParagraphElement>("empty");
const errorBox = $<HTMLDivElement>("error");
const errorText = $<HTMLSpanElement>("error-text");
const errorAction = $<HTMLButtonElement>("error-action");
const progress = $<HTMLElement>("progress");
const progressBar = $<HTMLProgressElement>("progress-bar");
const progressText = $<HTMLSpanElement>("progress-text");
const storageInfo = $<HTMLElement>("storage");
const library = $<HTMLElement>("library");
const viewer = $<HTMLDivElement>("viewer");
const frame = $<HTMLIFrameElement>("frame");
const bar = $<HTMLDivElement>("bar");
const toast = $<HTMLDivElement>("toast");

const touch = matchMedia("(pointer: coarse)").matches;
let importing: AbortController | null = null;

// the service worker serves the decks; nothing works without it
const ready = (async () => {
  if (!("serviceWorker" in navigator) || !navigator.storage?.getDirectory) {
    throw new Error("This browser cannot store decks (it needs service workers and file storage).");
  }
  try {
    await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`);
  } catch (e) {
    // offline, the update check of sw.js fails: the installed one still works
    if (!navigator.serviceWorker.controller) throw e;
  }
  await navigator.serviceWorker.ready;
})();

// ================================================================ library

function showError(msg: string, action?: { label: string; run: () => void }) {
  errorText.textContent = msg;
  errorBox.hidden = !msg;
  errorAction.hidden = !action;
  errorAction.textContent = action?.label ?? "";
  errorAction.onclick = action ? () => { showError(""); action.run(); } : null;
}

async function render() {
  const decks: AnyDeck[] = [...await listDecks(), ...await listLinks()];
  decks.sort((a, b) => added(b) - added(a));
  list.replaceChildren(...decks.map(deckItem));
  empty.hidden = decks.length > 0;
  renderStorage();
}

const added = (d: AnyDeck) => (d.kind === "imported" ? d.importedAt : d.linkedAt);

function deckItem(d: AnyDeck): HTMLLIElement {
  const li = document.createElement("li");
  const open = document.createElement("button");
  open.className = "deck-open";
  open.innerHTML = `<span class="deck-title"></span><span class="deck-info"></span>`;
  open.querySelector(".deck-title")!.textContent = d.title;
  const date = new Date(added(d)).toLocaleDateString();
  open.querySelector(".deck-info")!.textContent = d.kind === "imported"
    ? `${d.name} · ${mb(d.bytes)} · ${date}`
    : `${d.name} · linked folder · ${date}`;
  open.addEventListener("click", () => openDeck(d));
  const remove = document.createElement("button");
  remove.className = "link deck-delete";
  remove.textContent = d.kind === "imported" ? "Delete" : "Unlink";
  remove.title = d.kind === "imported" ? "Delete this deck from the device"
    : "Remove from the list (the folder is left untouched)";
  remove.addEventListener("click", async () => {
    if (d.kind === "imported") {
      if (!confirm(`Delete "${d.title}" from this device?`)) return;
      await deleteDeck(d.folder);
    } else {
      await unlink(d.id);
    }
    render();
  });
  li.append(open, remove);
  return li;
}

async function renderStorage() {
  const est = await navigator.storage.estimate().catch(() => null);
  const kept = await navigator.storage.persisted?.().catch(() => false);
  const used = est?.usage !== undefined ? `${mb(est.usage)} used` : "";
  const free = est?.quota !== undefined && est.usage !== undefined ? `, ${mb(est.quota - est.usage)} free` : "";
  storageInfo.textContent = `Storage: ${used}${free}. ` + (kept
    ? "Kept permanently by the browser."
    : "The browser may clear it when the device is low on space; installing the viewer " +
      "(the browser's “Install app” or “Add to home screen”) keeps decks safer.");
}

async function importFile(file: File) {
  showError("");
  if (importing) return;
  importing = new AbortController();
  progress.hidden = false;
  progressBar.value = 0;
  progressText.textContent = `Importing ${file.name}…`;
  try {
    await ready;
    const deck = await importZip(file, ({ done, total }) => {
      progressBar.value = total ? done / total : 1;
      progressText.textContent = `Importing ${file.name}: ${mb(done)} of ${mb(total)}`;
    }, importing.signal);
    await render();
    openDeck(deck);
  } catch (e) {
    const err = e as Error;
    showError(err.name === "AbortError" ? "Import cancelled." : `Could not import ${file.name}: ${err.message}`);
  } finally {
    importing = null;
    progress.hidden = true;
    fileInput.value = "";
  }
}

async function addFolder(relinkId?: string) {
  showError("");
  try {
    await ready;
    const deck = await linkFolder(relinkId);
    if (!deck) return;
    await render();
    openDeck(deck);
  } catch (e) {
    showError(`Could not open the folder: ${(e as Error).message}`);
  }
}

// ================================================================ viewer

let current: AnyDeck | null = null;
let wakeLock: WakeLockSentinel | null = null;
let positionTimer = 0;
let barTimer = 0;
let backArmed = false;
let ignorePop = false;

const positionKey = (d: AnyDeck) => `t2hv:pos:${d.kind}:${d.kind === "imported" ? d.name : d.id}`;

function savePosition() {
  if (!current) return;
  try {
    const hash = frame.contentWindow?.location.hash;
    if (hash && hash.length > 1) localStorage.setItem(positionKey(current), hash);
  } catch { /* not loaded yet, or storage blocked */ }
}

function savedPosition(d: AnyDeck): string {
  try {
    return localStorage.getItem(positionKey(d)) ?? "";
  } catch {
    return "";
  }
}

async function openDeck(d: AnyDeck) {
  showError("");
  if (d.kind === "linked") {
    try {
      await ensureReadable(d);              // may ask for permission: still in the click
    } catch (e) {
      const msg = (e as Error).message;
      showError(`"${d.title}": ${msg}`, e instanceof FolderError && msg.startsWith("folder not found")
        ? { label: "Link again", run: () => addFolder(d.id) } : undefined);
      return;
    }
  }
  current = d;
  const url = (d.kind === "imported" ? deckUrl(d) : linkUrl(d)) + savedPosition(d);
  frame.src = url;
  library.hidden = true;
  viewer.hidden = false;
  history.pushState({ viewer: true }, "");
  backArmed = false;
  if (touch) enterFullscreen();             // phones: full screen and landscape
  keepAwake();
  clearInterval(positionTimer);
  positionTimer = window.setInterval(savePosition, 1000);
  showBar();
}

function closeDeck() {
  savePosition();
  clearInterval(positionTimer);
  current = null;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  wakeLock?.release().catch(() => {});
  wakeLock = null;
  viewer.hidden = true;
  library.hidden = false;
  frame.src = "about:blank";
  render();
}

/** ✕: leave the deck at once, then drop the history entry pushed when it was
 * opened (if it is still the current one: a link followed inside the deck
 * may have added entries of its own). */
function closeFromUi() {
  closeDeck();
  if (history.state?.viewer) {
    ignorePop = true;
    history.back();
  }
}

// the back button: a first press only warns, so a stray press does not end a talk
window.addEventListener("popstate", () => {
  if (ignorePop) { ignorePop = false; return; }
  if (!current) return;
  if (backArmed) {
    closeDeck();
    return;
  }
  backArmed = true;
  history.pushState({ viewer: true }, "");
  showToast("Press back again to close the deck");
  setTimeout(() => { backArmed = false; }, 2500);
});

async function enterFullscreen() {
  try {
    await viewer.requestFullscreen({ navigationUI: "hide" });
    await (screen.orientation as ScreenOrientation & { lock?(o: string): Promise<void> })
      .lock?.("landscape");
  } catch { /* not allowed here: the deck still fills the window */ }
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else enterFullscreen();
  focusDeck();
}

async function keepAwake() {
  try {
    wakeLock = await navigator.wakeLock?.request("screen") ?? null;
  } catch { /* not supported or not allowed */ }
}

addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && current && !wakeLock) keepAwake();
  if (document.visibilityState === "hidden") savePosition();
});
addEventListener("pagehide", savePosition);

function showBar() {
  bar.classList.add("show");
  clearTimeout(barTimer);
  barTimer = window.setTimeout(() => {
    if (!bar.matches(":hover, :focus-within")) bar.classList.remove("show");
  }, 3000);
}
function toggleBar() {
  if (bar.classList.contains("show")) bar.classList.remove("show");
  else showBar();
}

let toastTimer = 0;
function showToast(msg: string) {
  toast.textContent = msg;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { toast.hidden = true; }, 2500);
}

function focusDeck() {
  frame.contentWindow?.focus();
}

/** The viewer's own keys, wherever the focus is: Esc shows the bar, F toggles
 * full screen (the viewer's, which also locks landscape on phones). */
function viewerKey(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  if (e.key === "Escape") toggleBar();
  else if (e.key === "f" || e.key === "F") toggleFullscreen();
  else return false;
  e.preventDefault();
  e.stopImmediatePropagation();
  return true;
}

frame.addEventListener("load", () => {
  if (!current) return;
  focusDeck();
  try {                                     // same origin: listen inside the deck
    frame.contentWindow?.addEventListener("keydown", viewerKey, { capture: true });
  } catch { /* nothing to listen to */ }
});

// keys pressed while the focus is on the viewer page (e.g. after a bar
// button): the viewer's own, or passed on to the deck
addEventListener("keydown", (e) => {
  if (!current || viewerKey(e)) return;
  const doc = frame.contentDocument;
  if (!doc || (e.target instanceof HTMLButtonElement && (e.key === "Enter" || e.key === " "))) return;
  e.preventDefault();
  focusDeck();
  doc.dispatchEvent(new KeyboardEvent("keydown", { key: e.key, code: e.code, bubbles: true }));
});

document.addEventListener("fullscreenchange", () => {
  if (current && !document.fullscreenElement) showBar();
});
viewer.addEventListener("mousemove", (e) => {
  if (e.clientX < 160 && e.clientY < 120) showBar();
});
$("corner").addEventListener("click", showBar);
$("close").addEventListener("click", closeFromUi);
$("fullscreen").addEventListener("click", toggleFullscreen);

// ================================================================ setup

fileInput.addEventListener("change", () => {
  const f = fileInput.files?.[0];
  if (f) importFile(f);
});
$("cancel").addEventListener("click", () => importing?.abort());
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  const f = e.dataTransfer?.files?.[0];
  if (f) importFile(f);
});
linkButton.hidden = !canLinkFolders;
linkButton.addEventListener("click", () => addFolder());

// for tests: link a folder handle without the system picker
(window as unknown as { __t2hv: object }).__t2hv = {
  linkFolderHandle: async (h: FileSystemDirectoryHandle) => { const d = await linkFolderHandle(h); await render(); return d.id; },
};

ready.then(render).catch((e: Error) => showError(e.message));
