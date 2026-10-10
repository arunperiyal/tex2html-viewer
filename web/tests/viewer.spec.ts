import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PACK = join(import.meta.dirname, "../../fixtures/template.zip");

/** A zip made with Python's zipfile: entries as {name: content}. */
function makeZip(entries: Record<string, string>): string {
  const out = join(mkdtempSync(join(tmpdir(), "t2hv-")), "test.zip");
  execFileSync("python3", ["-c",
    "import sys, json, zipfile\n" +
    "z = zipfile.ZipFile(sys.argv[1], 'w')\n" +
    "for k, v in json.loads(sys.argv[2]).items(): z.writestr(k, v)\n" +
    "z.close()", out, JSON.stringify(entries)]);
  return out;
}

async function importPack(page: Page, file: string) {
  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.locator("#file").setInputFiles(file);
}

test("a pack imports and shows as slides", async ({ page }) => {
  await importPack(page, PACK);
  await expect(page.locator("#viewer")).toBeVisible();
  const deck = page.frameLocator("#frame");
  await expect(deck.locator("section.slide")).toHaveCount(28);
  await expect(deck.locator("section.slide.active")).toHaveCount(1);
  await expect(deck.locator("mjx-container").first()).toBeAttached({ timeout: 20_000 });

  // every image the deck shows (figures, TikZ SVGs) actually loaded
  const frame = page.frames().find((f) => f.url().includes("/decks/"))!;
  await frame.waitForFunction(() =>
    [...document.querySelectorAll("img[src]")].every((i) => (i as HTMLImageElement).complete));
  const broken = await frame.evaluate(() =>
    [...document.querySelectorAll("img[src]")]
      .filter((i) => (i as HTMLImageElement).naturalWidth === 0)
      .map((i) => i.getAttribute("src")));
  expect(broken).toEqual([]);
  expect(await frame.locator("span.tikz img").count()).toBeGreaterThan(0);

  // keys reach deck.js: the next key moves on
  const before = await frame.evaluate(() =>
    [...document.querySelectorAll("section.slide")].findIndex((s) => s.classList.contains("active")));
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => frame.evaluate(() =>
    [...document.querySelectorAll("section.slide")].findIndex((s) => s.classList.contains("active"))))
    .toBeGreaterThan(before);
});

test("animation frames load from the deck", async ({ page }) => {
  await importPack(page, PACK);
  const frame = await (async () => {
    await expect(page.frameLocator("#frame").locator("section.slide")).toHaveCount(28);
    return page.frames().find((f) => f.url().includes("/decks/"))!;
  })();
  const src = await frame.evaluate(() => document.querySelector(".anim img[data-src]")?.getAttribute("data-src"));
  expect(src).toBeTruthy();
  const first = src!.replace(/\{n(:\d+)?\}/, "0");
  const status = await frame.evaluate(async (u) => (await fetch(u)).status, first);
  expect(status).toBe(200);
});

test("the deck stays in the library after a reload", async ({ page }) => {
  await importPack(page, PACK);
  await expect(page.locator("#viewer")).toBeVisible();
  await page.reload();
  await expect(page.locator("#decks li")).toHaveCount(1);
  await page.locator(".deck-open").first().click();
  await expect(page.frameLocator("#frame").locator("section.slide")).toHaveCount(28);
});

test("a zip without slides.html is refused", async ({ page }) => {
  await importPack(page, makeZip({ "notes/readme.txt": "hello" }));
  await expect(page.locator("#error")).toContainText("no slides.html");
  await expect(page.locator("#decks li")).toHaveCount(0);
});

test("a zip with unsafe paths is refused", async ({ page }) => {
  await importPack(page, makeZip({ "slides.html": "<title>x</title>", "../evil.txt": "x" }));
  await expect(page.locator("#error")).toContainText("unsafe entry");
  await expect(page.locator("#decks li")).toHaveCount(0);
});

// ---------------------------------------------------------------- M1

const deckFrame = (page: Page) => page.frames().find((f) => /\/(decks|links)\//.test(f.url()))!;
const activeSlide = (page: Page) => deckFrame(page)?.evaluate(() =>
  [...document.querySelectorAll("section.slide")].findIndex((s) => s.classList.contains("active")))
  .catch(() => -1);                                          // the deck is reloading

async function closeViewer(page: Page) {
  if (!/show/.test(await page.locator("#bar").getAttribute("class") ?? "")) {
    await page.keyboard.press("Escape");                    // shows the bar
  }
  await page.locator("#close").click();
  await expect(page.locator("#library")).toBeVisible();
}

test("the app opens offline after the first visit", async ({ page, context }) => {
  await importPack(page, PACK);
  await expect(page.frameLocator("#frame").locator("section.slide")).toHaveCount(28);
  await closeViewer(page);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator("h1")).toHaveText("tex2html viewer");
  await page.locator(".deck-open").first().click();
  await expect(page.frameLocator("#frame").locator("section.slide")).toHaveCount(28);
  await context.setOffline(false);
});

test("a deck reopens where it was left", async ({ page }) => {
  await importPack(page, PACK);
  await expect(page.frameLocator("#frame").locator("section.slide.active")).toHaveCount(1);
  await deckFrame(page).evaluate(() => { history.replaceState(null, "", "#9"); location.reload(); });
  await expect.poll(() => activeSlide(page)).toBe(8);
  await page.waitForTimeout(1200);                           // the position is saved every second
  await closeViewer(page);
  await page.locator(".deck-open").first().click();
  await expect(page.frameLocator("#frame").locator("section.slide.active")).toHaveCount(1);
  await expect.poll(() => activeSlide(page)).toBe(8);
});

test("Esc shows the bar; nothing is drawn over the slides otherwise", async ({ page }) => {
  await importPack(page, PACK);
  await expect(page.frameLocator("#frame").locator("section.slide.active")).toHaveCount(1);
  await page.waitForTimeout(3500);                           // the bar shown on opening hides
  await expect(page.locator("#bar")).not.toHaveClass(/show/);
  await page.keyboard.press("Escape");
  await expect(page.locator("#bar")).toHaveClass(/show/);
});

test("the back button closes the deck only on a second press", async ({ page }) => {
  await importPack(page, PACK);
  await expect(page.locator("#viewer")).toBeVisible();
  await page.evaluate(() => history.back());
  await expect(page.locator("#toast")).toContainText("Press back again");
  await expect(page.locator("#viewer")).toBeVisible();
  await page.evaluate(() => history.back());
  await expect(page.locator("#library")).toBeVisible();
});

/** Link the imported deck's own folder (in private storage) as if it had been
 * picked: the system folder picker cannot be driven by a test. */
async function linkImportedFolder(page: Page) {
  return page.evaluate(async () => {
    const decks = await (await navigator.storage.getDirectory()).getDirectoryHandle("decks");
    for await (const [, h] of decks as unknown as AsyncIterable<[string, FileSystemDirectoryHandle]>) {
      return (window as unknown as { __t2hv: { linkFolderHandle(h: FileSystemDirectoryHandle): Promise<string> } })
        .__t2hv.linkFolderHandle(h);
    }
  });
}

test("a linked folder is shown in place", async ({ page }) => {
  await importPack(page, PACK);
  await expect(page.locator("#viewer")).toBeVisible();
  await closeViewer(page);
  await linkImportedFolder(page);
  const linked = page.locator("#decks li", { hasText: "linked folder" });
  await expect(linked).toHaveCount(1);
  await expect(linked.locator(".deck-delete")).toHaveText("Unlink");
  await linked.locator(".deck-open").click();
  await expect(page.frameLocator("#frame").locator("section.slide")).toHaveCount(28);
  expect(deckFrame(page).url()).toContain("/links/");
});

test("a linked folder that is gone offers to link it again", async ({ page }) => {
  await importPack(page, PACK);
  await expect(page.locator("#viewer")).toBeVisible();
  await closeViewer(page);
  await linkImportedFolder(page);
  page.once("dialog", (d) => d.accept());
  await page.locator("#decks li", { hasNotText: "linked folder" }).locator(".deck-delete").click();
  await expect(page.locator("#decks li")).toHaveCount(1);
  await page.locator("#decks li .deck-open").click();
  await expect(page.locator("#error")).toContainText("folder not found");
  await expect(page.locator("#error-action")).toHaveText("Link again");
  await expect(page.locator("#viewer")).toBeHidden();
});
