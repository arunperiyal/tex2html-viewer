import { deckUrl, deleteDeck, importZip, listDecks, mb, type Deck } from "./storage";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const fileInput = $<HTMLInputElement>("file");
const drop = $<HTMLLabelElement>("drop");
const list = $<HTMLUListElement>("decks");
const empty = $<HTMLParagraphElement>("empty");
const errorBox = $<HTMLParagraphElement>("error");
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

/** Inside the Android app: it provides full screen, landscape and keeping the
 * screen on natively (android/.../MainActivity.kt). */
interface AppBridge {
  viewerOpened(): void; viewerClosed(): void; toggleFullscreen(): void;
  listDecks(): string; deleteDeck(id: string): void; cancelImport(): void;   // decks kept by the app
  storage(): string;                                                          // {used, free} bytes
}
const app = (window as unknown as { TexViewer?: AppBridge }).TexViewer;
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

function showError(msg: string) {
  errorBox.textContent = msg;
  errorBox.hidden = !msg;
}

/** The decks the app keeps (natively, read from their zip). */
function appDecks(): Deck[] {
  if (!app) return [];
  const list = JSON.parse(app.listDecks()) as { id: string; name: string; title: string; bytes: number; importedAt: number }[];
  return list.map((d) => ({ folder: d.id, name: d.name, title: d.title, bytes: d.bytes,
                            importedAt: d.importedAt, app: true }));
}

async function render() {
  // in the app: its own decks, and any it imported into browser storage before
  const decks = [...appDecks(), ...await listDecks()].sort((a, b) => b.importedAt - a.importedAt);
  list.replaceChildren(...decks.map(deckItem));
  empty.hidden = decks.length > 0;
  renderStorage();
}

function deckItem(d: Deck): HTMLLIElement {
  const li = document.createElement("li");
  const open = document.createElement("button");
  open.className = "deck-open";
  open.innerHTML = `<span class="deck-title"></span><span class="deck-info"></span>`;
  open.querySelector(".deck-title")!.textContent = d.title;
  open.querySelector(".deck-info")!.textContent =
    `${d.name} · ${mb(d.bytes)} · ${new Date(d.importedAt).toLocaleDateString()}`;
  open.addEventListener("click", () => openDeck(d));
  const remove = document.createElement("button");
  remove.className = "link deck-delete";
  remove.textContent = "Delete";
  remove.title = "Delete this deck from the device";
  remove.addEventListener("click", async () => {
    if (!confirm(`Delete "${d.title}" from this device?`)) return;
    if (d.app) app?.deleteDeck(d.folder);
    else await deleteDeck(d.folder);
    render();
  });
  li.append(open, remove);
  return li;
}

async function renderStorage() {
  // in the app: its decks and the device's free space (the browser storage
  // the WebView reports knows nothing of them)
  let usage: number | undefined, quota: number | undefined;
  if (app) {
    const s = JSON.parse(app.storage()) as { used: number; free: number };
    [usage, quota] = [s.used, s.used + s.free];
  } else {
    ({ usage, quota } = await navigator.storage.estimate().catch(() => ({} as StorageEstimate)));
  }
  const kept = await navigator.storage.persisted?.().catch(() => false);
  const used = usage !== undefined ? `${mb(usage)} used` : "";
  const free = quota !== undefined && usage !== undefined ? `, ${mb(quota - usage)} free` : "";
  // in the app, decks are app data: the browser's eviction rules do not apply
  const note = app ? ""
    : kept ? " Kept permanently by the browser."
    : " The browser may clear it when the device is low on space; installing the viewer " +
      "(the browser's “Install app” or “Add to home screen”) keeps decks safer.";
  storageInfo.textContent = `Storage: ${used}${free}.${note}`;
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

// ================================================================ viewer

let current: Deck | null = null;
let wakeLock: WakeLockSentinel | null = null;
let positionTimer = 0;
let barTimer = 0;
let backArmed = false;
let ignorePop = false;
let notesOn = false;
let notesWarned = false;

const positionKey = (d: Deck) => `t2hv:pos:imported:${d.name}`;

function savePosition() {
  if (!current) return;
  try {
    const hash = frame.contentWindow?.location.hash;
    if (hash && hash.length > 1) localStorage.setItem(positionKey(current), hash);
  } catch { /* not loaded yet, or storage blocked */ }
}

function savedPosition(d: Deck): string {
  try {
    return localStorage.getItem(positionKey(d)) ?? "";
  } catch {
    return "";
  }
}

function openDeck(d: Deck) {
  showError("");
  current = d;
  setNotes(false);                          // never start a talk with notes showing
  // in the app no second window can open: tell deck.js to leave out S
  frame.src = deckUrl(d) + (app ? "?nopresenter" : "") + savedPosition(d);
  library.hidden = true;
  viewer.hidden = false;
  history.pushState({ viewer: true }, "");
  backArmed = false;
  if (app) app.viewerOpened();              // the app: immersive, landscape, awake
  else {
    if (touch) enterFullscreen();           // phones: full screen and landscape
    keepAwake();
  }
  clearInterval(positionTimer);
  positionTimer = window.setInterval(savePosition, 1000);
  showBar();
}

function closeDeck() {
  savePosition();
  clearInterval(positionTimer);
  current = null;
  app?.viewerClosed();
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
function armBack() {
  backArmed = true;
  showToast("Press back again to close the deck");
  setTimeout(() => { backArmed = false; }, 2500);
}

// browsers: Back goes through the history entry pushed when the deck opened
window.addEventListener("popstate", () => {
  if (ignorePop) { ignorePop = false; return; }
  if (!current) return;
  if (backArmed) {
    closeDeck();
    return;
  }
  history.pushState({ viewer: true }, "");
  armBack();
});

// the Android app calls this on Back while a deck is open (it does not use
// the page's history, whose entries Chromium may skip)
(window as unknown as { t2hvBack: () => void }).t2hvBack = () => {
  if (!current) return;
  if (backArmed) closeFromUi();
  else armBack();
};

async function enterFullscreen() {
  try {
    await viewer.requestFullscreen({ navigationUI: "hide" });
    await (screen.orientation as ScreenOrientation & { lock?(o: string): Promise<void> })
      .lock?.("landscape");
  } catch { /* not allowed here: the deck still fills the window */ }
}

function toggleFullscreen() {
  if (app) app.toggleFullscreen();
  else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
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

let barTappedAt = -Infinity;  // when a tap on the corner showed the bar
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
  else if (e.key === "n" || e.key === "N") setNotes(!notesOn);
  else return false;
  e.preventDefault();
  e.stopImmediatePropagation();
  return true;
}

frame.addEventListener("load", () => {
  if (!current) return;
  focusDeck();
  watchSlides();
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
// a real mouse near the top-left corner shows the bar (not the mouse events
// a touch also sends: they would show it and then click ✕ under the finger)
viewer.addEventListener("pointermove", (e) => {
  if (e.pointerType === "mouse" && e.clientX < 160 && e.clientY < 120) showBar();
});
$("corner").addEventListener("pointerdown", () => {
  if (!bar.classList.contains("show")) barTappedAt = performance.now();
  showBar();
});
/** A bar button: ignores the click that comes with the tap showing the bar. */
function barButton(id: string, action: () => void) {
  $(id).addEventListener("click", () => {
    if (performance.now() - barTappedAt < 400) return;
    action();
  });
}
barButton("close", closeFromUi);
barButton("fullscreen", toggleFullscreen);
barButton("notes", () => { setNotes(!notesOn); focusDeck(); });

// ---------------------------------------------------------------- notes
// The current slide's speaker notes (\note{...}: <aside class="note">) in a
// panel at the bottom of the deck, shown with the Notes button or N. It is
// drawn inside the deck's page, so maths in notes uses the deck's own styles.
// Anyone who sees this screen sees the notes too (mirroring, casting).

const NOTES_CSS = "position:fixed;left:0;right:0;bottom:0;z-index:2147483647;max-height:38vh;" +
  "overflow:auto;box-sizing:border-box;padding:10px 18px 14px;background:rgba(16,20,26,0.92);" +
  "color:#f2f4f7;font:400 clamp(14px,1.9vw,22px)/1.45 system-ui,sans-serif;" +
  "border-top:2px solid rgba(138,180,248,0.8)";

function setNotes(on: boolean) {
  notesOn = on;
  $("notes").setAttribute("aria-pressed", String(on));
  renderNotes();
  if (on && !notesWarned) {
    notesWarned = true;
    showToast("Notes are visible to anyone who sees this screen");
  }
}

function renderNotes() {
  const doc = frame.contentDocument;
  if (!doc?.body || !current) return;
  let panel = doc.getElementById("t2hv-notes");
  if (!notesOn) {
    panel?.remove();
    return;
  }
  if (!panel) {
    panel = doc.createElement("div");
    panel.id = "t2hv-notes";
    panel.setAttribute("style", NOTES_CSS);
    // touches on the panel scroll it: keep them from deck.js's tap / swipe
    for (const t of ["pointerdown", "pointerup", "pointercancel", "click"]) {
      panel.addEventListener(t, (e) => e.stopPropagation());
    }
    doc.body.appendChild(panel);
  }
  const slides = [...doc.querySelectorAll("section.slide")];
  const index = slides.findIndex((s) => s.classList.contains("active"));
  const notes = [...(slides[index]?.querySelectorAll("aside.note") ?? [])];
  const plain = notes.filter((n) => !n.hasAttribute("data-item"));
  const items = notes.filter((n) => n.hasAttribute("data-item"));
  const head = `<div style="font-size:0.72em;opacity:0.65;letter-spacing:0.04em;margin-bottom:4px">` +
    `NOTES · SLIDE ${index + 1} / ${slides.length}</div>`;
  panel.innerHTML = head + (notes.length
    ? plain.map((n) => `<div>${n.innerHTML}</div>`).join("") +
      (items.length ? `<ul style="margin:0.3em 0;padding-left:1.2em">${items.map((n) => `<li>${n.innerHTML}</li>`).join("")}</ul>` : "")
    : `<div style="opacity:0.6;font-style:italic">No notes for this slide.</div>`);
}

/** Follow slide changes (deck.js moves the "active" class). */
function watchSlides() {
  const doc = frame.contentDocument;
  if (!doc?.body) return;
  new MutationObserver(() => { if (notesOn) renderNotes(); })
    .observe(doc.querySelector(".deck") ?? doc.body,
             { subtree: true, attributes: true, attributeFilter: ["class"] });
  renderNotes();
}

// ================================================================ setup

fileInput.addEventListener("change", () => {
  const f = fileInput.files?.[0];
  if (f) importFile(f);
});
$("cancel").addEventListener("click", () => {
  importing?.abort();
  if (app && appImporting) app.cancelImport();
});
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  const f = e.dataTransfer?.files?.[0];
  if (f) importFile(f);
});
// the Android app imports zips itself (picker, "Open with", share menu) and
// tells the page how it goes
let appImporting = "";
(window as unknown as { t2hvApp: object }).t2hvApp = {
  importStarted(name: string) {
    showError("");
    appImporting = name;
    progress.hidden = false;
    progressBar.removeAttribute("value");                 // size not known yet
    progressText.textContent = `Importing ${name}…`;
  },
  importProgress(done: number, total: number) {
    progressBar.value = total > 0 ? done / total : 0;
    progressText.textContent = `Importing ${appImporting}: ${mb(done)}${total > 0 ? ` of ${mb(total)}` : ""}`;
  },
  async importDone(deck: { id: string; name: string; title: string; bytes: number; importedAt: number }) {
    appImporting = "";
    progress.hidden = true;
    await render();
    openDeck({ folder: deck.id, name: deck.name, title: deck.title, bytes: deck.bytes,
               importedAt: deck.importedAt, app: true });
  },
  importFailed(message: string) {
    const name = appImporting;
    appImporting = "";
    progress.hidden = true;
    showError(message === "cancelled" ? "Import cancelled." : `Could not import ${name}: ${message}`);
  },
};

ready.then(render).catch((e: Error) => showError(e.message));
