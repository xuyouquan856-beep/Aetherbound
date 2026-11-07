import { expect, test, _electron as electron } from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Runs the PACKAGED executable (release/win-unpacked) rather than the dev build.
 * The reported failure was almost certainly build skew: the packaged app was from
 * Aug 1 and predated the fix entirely.
 */
const packagedExe = resolve(process.env.READER_E2E_EXECUTABLE ?? "release/distribution/win-unpacked/Aetherbound.exe");

test("packaged build keeps the shelf display mode", async () => {
  test.skip(!existsSync(packagedExe), "Build the current packaged app first.");
  test.setTimeout(180_000);
  const dataRoot = await mkdtemp(join(tmpdir(), "reader-packaged-shelf-"));
  const application = await electron.launch({ executablePath: packagedExe, args: [], env: { ...process.env, READER_DATA_ROOT: dataRoot } });
  try {
  const page = await application.firstWindow();
  await page.waitForURL((url) => url.protocol === "reader-app:");
  await page.waitForLoadState("domcontentloaded");
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.bringToFront();
  console.log("[pkg] executable:", packagedExe);
  console.log("[pkg] origin    :", await page.evaluate(() => location.origin));

  const nav = (label: string) => page.getByRole("button", { name: new RegExp(label) }).first();
  await nav("全部书籍").waitFor({ timeout: 60_000 });
  await page.evaluate(() => window.localStorage.clear());
  await page.waitForTimeout(400);

  const mode = async () => {
    const grid = page.locator(".all-books-view .book-grid");
    return `${await grid.getAttribute("data-display-mode")} (storage=${await page.evaluate(() => window.localStorage.getItem("aetherbound.shelf.displayMode"))})`;
  };

  await nav("全部书籍").click({ force: true });
  await page.locator(".all-books-view .book-grid").waitFor();
  await page.waitForTimeout(600);
  console.log("[pkg] initial       :", await mode());

  await page.getByRole("button", { name: "紧凑封面" }).click();
  await page.waitForTimeout(500);
  console.log("[pkg] after compact :", await mode());
  expect(await page.locator(".all-books-view .book-grid").getAttribute("data-display-mode")).toBe("compact");

  await nav("我的珍藏").click({ force: true });
  await page.waitForTimeout(900);
  await nav("全部书籍").click({ force: true });
  await page.locator(".all-books-view .book-grid").waitFor();
  await page.waitForTimeout(900);
  console.log("[pkg] after round-trip:", await mode());
  expect(await page.locator(".all-books-view .book-grid").getAttribute("data-display-mode")).toBe("compact");

  } finally {
    await application.close().catch(() => undefined);
    await rm(dataRoot, { recursive: true, force: true });
  }
});
