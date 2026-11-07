import { expect, test, _electron as electron } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createEpubFixture } from "./fixtures/epub-fixture.js";
import { LibraryService } from "../../src/backend/library/library-service.js";
import { openDatabase } from "../../src/backend/storage/database.js";

/**
 * The shelf view controls (display mode, sort, filter) used to be component state,
 * so leaving 全部书籍 and returning reset them. They are persisted now; this proves
 * a real navigation round-trip keeps them.
 */
test("shelf view preferences survive navigation", async () => {
  test.setTimeout(180_000);
  const dataRoot = await mkdtemp(join(tmpdir(), "reader-shelf-preferences-"));
  const epubPath = await createEpubFixture(dataRoot);
  const prepared = openDatabase(dataRoot);
  try {
    await new LibraryService(prepared.db, dataRoot).importEpub(epubPath);
  } finally {
    prepared.close();
  }
  const application = await electron.launch({
    args: [resolve("out/main/index.js")],
    env: { ...process.env, READER_DATA_ROOT: dataRoot },
  });
  try {
  const page = await application.firstWindow();
  await page.waitForURL((url) => url.protocol === "reader-app:");
  await page.waitForLoadState("domcontentloaded");
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.bringToFront();

  const shelf = page.getByRole("button", { name: /全部书籍/ }).first();
  await shelf.waitFor({ timeout: 60_000 });

  // The app always boots into 书房 (home), and home renders its own compact grid,
  // so every assertion below has to navigate to 全部书籍 first.
  const openShelf = async () => {
    await shelf.click({ force: true });
    await page.locator(".all-books-view .book-grid").waitFor({ timeout: 30_000 });
  };
  const shelfGrid = () => page.locator(".all-books-view .book-grid");
  const sortSelect = page.locator(".library-controls select").first();
  const filterSelect = page.locator(".library-controls select").nth(1);
  const openShelfFromHome = async () => {
    await page.waitForTimeout(800);
    await openShelf();
    await page.waitForTimeout(600);
  };

  // Start from a clean slate so the assertions are meaningful.
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  await page.waitForURL((url) => url.protocol === "reader-app:");
  await shelf.waitFor({ timeout: 60_000 });
  await openShelfFromHome();

  const pressed = (label: string) =>
    page.getByRole("button", { name: label }).getAttribute("aria-pressed");

  console.log("[debug] initial mode:", await shelfGrid().getAttribute("data-display-mode"));
  expect(await shelfGrid().getAttribute("data-display-mode")).toBe("comfortable");

  // Choose list mode, plus a non-default sort and filter.
  await page.getByRole("button", { name: "列表" }).click();
  await sortSelect.selectOption("title");
  await filterSelect.selectOption("epub");
  await page.waitForTimeout(600);
  expect(await shelfGrid().getAttribute("data-display-mode")).toBe("list");
  expect(await pressed("列表")).toBe("true");

  const stored = await page.evaluate(() => ({
    mode: window.localStorage.getItem("aetherbound.shelf.displayMode"),
    sort: window.localStorage.getItem("aetherbound.shelf.sort"),
    filter: window.localStorage.getItem("aetherbound.shelf.filter"),
  }));
  console.log("[prefs] stored:", JSON.stringify(stored));
  expect(stored).toEqual({ mode: "list", sort: "title", filter: "epub" });

  // Navigate away and back.
  await page.getByRole("button", { name: /我的珍藏/ }).first().click({ force: true });
  await page.waitForTimeout(900);
  await page.getByRole("button", { name: /书房/ }).first().click({ force: true });
  await page.waitForTimeout(900);
  await shelf.click({ force: true });
  await page.waitForTimeout(1500);

  expect(await shelfGrid().getAttribute("data-display-mode")).toBe("list");
  await expect(sortSelect).toHaveValue("title");
  await expect(filterSelect).toHaveValue("epub");
  console.log("[prefs] survived navigation ✅");

  // And across a full reload.
  await page.reload();
  await page.waitForURL((url) => url.protocol === "reader-app:");
  await shelf.waitFor({ timeout: 60_000 });
  await openShelfFromHome();
  expect(await shelfGrid().getAttribute("data-display-mode")).toBe("list");
  await expect(sortSelect).toHaveValue("title");
  console.log("[prefs] survived reload ✅");

  // A hand-edited / stale value must not break the shelf.
  await page.evaluate(() => {
    window.localStorage.setItem("aetherbound.shelf.displayMode", "nonsense");
    window.localStorage.setItem("aetherbound.shelf.sort", "not-a-sort");
  });
  await page.reload();
  await page.waitForURL((url) => url.protocol === "reader-app:");
  await shelf.waitFor({ timeout: 60_000 });
  await openShelfFromHome();
  expect(await shelfGrid().getAttribute("data-display-mode")).toBe("comfortable");
  await expect(sortSelect).toHaveValue("added-desc");
  console.log("[prefs] invalid values fall back safely ✅");

  } finally {
    await application.close().catch(() => undefined);
    await rm(dataRoot, { recursive: true, force: true });
  }
});
