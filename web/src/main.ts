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
const library = $<HTMLElement>("library");
const viewer = $<HTMLDivElement>("viewer");
const frame = $<HTMLIFrameElement>("frame");

let importing: AbortController | null = null;

// the service worker serves the decks; nothing works without it
const ready = (async () => {
  if (!("serviceWorker" in navigator) || !navigator.storage?.getDirectory) {
    throw new Error("This browser cannot store decks (it needs service workers and file storage).");
  }
  await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`);
  await navigator.serviceWorker.ready;
})();

function showError(msg: string) {
  errorBox.textContent = msg;
  errorBox.hidden = !msg;
}

async function render() {
  const decks = await listDecks();
  list.replaceChildren(...decks.map(deckItem));
  empty.hidden = decks.length > 0;
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
  const del = document.createElement("button");
  del.className = "link deck-delete";
  del.textContent = "Delete";
  del.addEventListener("click", async () => {
    if (!confirm(`Delete "${d.title}" from this device?`)) return;
    await deleteDeck(d.folder);
    render();
  });
  li.append(open, del);
  return li;
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

function openDeck(d: Deck) {
  frame.src = deckUrl(d);
  library.hidden = true;
  viewer.hidden = false;
  frame.addEventListener("load", () => frame.contentWindow?.focus(), { once: true });
}

function closeDeck() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  viewer.hidden = true;
  library.hidden = false;
  frame.src = "about:blank";
}

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
$("close").addEventListener("click", closeDeck);
$("fullscreen").addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else viewer.requestFullscreen().catch(() => {});
  frame.contentWindow?.focus();
});

ready.then(render).catch((e: Error) => showError(e.message));
