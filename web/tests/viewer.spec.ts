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

const deckFrame = (page: Page) => page.frames().find((f) => f.url().includes("/decks/"))!;
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

// ---------------------------------------------------------------- read from the zip

test("an imported deck is kept as its zip, not unpacked", async ({ page }) => {
  await importPack(page, PACK);
  await expect(page.frameLocator("#frame").locator("section.slide")).toHaveCount(28);
  const files = await page.evaluate(async () => {
    const decks = await (await navigator.storage.getDirectory()).getDirectoryHandle("decks");
    for await (const [, h] of decks as unknown as AsyncIterable<[string, FileSystemDirectoryHandle]>) {
      const names: string[] = [];
      for await (const [n] of h as unknown as AsyncIterable<[string, FileSystemHandle]>) names.push(n);
      return names.sort();
    }
  });
  expect(files).toEqual(["index.json", "meta.json", "pack.zip"]);
});

test("a deck unpacked by an earlier version still opens", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.evaluate(async () => {
    const decks = await (await navigator.storage.getDirectory()).getDirectoryHandle("decks", { create: true });
    const dir = await decks.getDirectoryHandle("old-1", { create: true });
    const put = async (name: string, text: string) => {
      const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await w.write(text);
      await w.close();
    };
    await put("slides.html", "<!doctype html><title>Old deck</title><section class='slide'>an old slide</section>");
    await put("meta.json", JSON.stringify({ folder: "old-1", name: "old", title: "Old deck", bytes: 100, importedAt: 1 }));
  });
  await page.reload();
  await page.locator(".deck-open", { hasText: "Old deck" }).click();
  await expect(page.frameLocator("#frame").locator("section.slide")).toHaveText("an old slide");
});

// ---------------------------------------------------------------- notes

test("speaker notes show on a toggle and follow the slides", async ({ page }) => {
  await importPack(page, PACK);
  await expect(page.frameLocator("#frame").locator("section.slide.active")).toHaveCount(1);
  const deck = page.frameLocator("#frame");
  const panel = deck.locator("#t2hv-notes");
  await expect(panel).toHaveCount(0);                            // off when a deck opens

  // a slide without notes
  await page.keyboard.press("n");
  await expect(panel).toContainText("No notes for this slide");
  await expect(page.locator("#toast")).toContainText("visible to anyone");

  // the slide with notes in the template: its text and its bullet
  const withNotes = await deckFrame(page).evaluate(() =>
    [...document.querySelectorAll("section.slide")].findIndex((s) => s.querySelector("aside.note")));
  expect(withNotes).toBeGreaterThan(0);
  await deckFrame(page).evaluate((n) => { history.replaceState(null, "", "#" + (n + 1)); location.reload(); }, withNotes);
  await expect.poll(() => activeSlide(page)).toBe(withNotes);
  await expect(panel).toContainText("What to say on this slide.");
  await expect(panel.locator("li", { hasText: "A talking point" })).toHaveCount(1);
  await expect(panel).toContainText(`SLIDE ${withNotes + 1}`);

  // a tap on the panel does not change the slide
  await panel.evaluate((p) => {
    const at = { bubbles: true, pointerType: "touch", clientX: 600, clientY: 600 };
    p.dispatchEvent(new PointerEvent("pointerdown", at));
    p.dispatchEvent(new PointerEvent("pointerup", at));
  });
  await page.waitForTimeout(300);
  expect(await activeSlide(page)).toBe(withNotes);

  // the next slide: the panel follows
  await page.keyboard.press("End");
  await expect(panel).not.toContainText("What to say on this slide.");

  await page.keyboard.press("n");
  await expect(panel).toHaveCount(0);
});

test("notes are off whenever a deck is opened", async ({ page }) => {
  await importPack(page, PACK);
  await expect(page.frameLocator("#frame").locator("section.slide.active")).toHaveCount(1);
  await page.keyboard.press("n");
  await expect(page.frameLocator("#frame").locator("#t2hv-notes")).toHaveCount(1);
  await closeViewer(page);
  await page.locator(".deck-open").first().click();
  await expect(page.frameLocator("#frame").locator("section.slide.active")).toHaveCount(1);
  await expect(page.frameLocator("#frame").locator("#t2hv-notes")).toHaveCount(0);
  await expect(page.locator("#notes")).toHaveAttribute("aria-pressed", "false");
});

test.describe("on a touch screen", () => {
  test.use({ hasTouch: true });

  test("a tap on the corner shows the bar and does not close the deck", async ({ page }) => {
    await importPack(page, PACK);
    await expect(page.frameLocator("#frame").locator("section.slide.active")).toHaveCount(1);
    await page.waitForTimeout(3500);                         // the bar shown on opening hides
    await expect(page.locator("#bar")).not.toHaveClass(/show/);
    await page.touchscreen.tap(20, 20);                      // where ✕ appears
    await expect(page.locator("#bar")).toHaveClass(/show/);
    await page.waitForTimeout(500);
    await expect(page.locator("#viewer")).toBeVisible();
    await page.locator("#notes").tap();                      // a second tap uses the bar
    await expect(page.frameLocator("#frame").locator("#t2hv-notes")).toHaveCount(1);
  });
});
