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
