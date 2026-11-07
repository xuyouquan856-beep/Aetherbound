import { expect, test, _electron as electron } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createEpubFixture } from "./fixtures/epub-fixture.js";

test("EPUB image directory opens the cover and pointer page turns leave no centre focus frame", async () => {
  test.setTimeout(60_000);
  const fixtureRoot = await mkdtemp(join(tmpdir(), "reader-gallery-book-"));
  const dataRoot = await mkdtemp(join(tmpdir(), "reader-gallery-data-"));
  const epubPath = await createEpubFixture(fixtureRoot);
  const packaged = process.env.READER_GALLERY_PACKAGED === "1";
  const application = await electron.launch({
    ...(packaged
      ? { executablePath: resolve(process.env.READER_E2E_EXECUTABLE ?? "release/distribution/win-unpacked/Aetherbound.exe") }
      : { args: [resolve("out/main/index.js")] }),
    env: { ...process.env, READER_DATA_ROOT: dataRoot, READER_E2E: "1", READER_E2E_IMPORT_PATH: epubPath },
  });
  try {
    const page = await application.firstWindow();
    await page.waitForURL((url) => url.protocol === "reader-app:");
    if (packaged) {
      await application.evaluate(({ dialog }, sourcePath) => {
        Object.assign(dialog, {
          showOpenDialog: async () => ({ canceled: false, filePaths: [sourcePath], bookmarks: [] }),
        });
      }, epubPath);
      await page.getByRole("button", { name: "导入" }).click();
      await page.getByRole("menuitem", { name: "导入书籍文件" }).click();
    }
    await page.getByRole("button", { name: "打开《EPUB 验收书》" }).click();
    await expect(page.frameLocator('iframe[title="EPUB 正文"]').locator("html"))
      .toHaveAttribute("data-ready", "true");

    const centre = page.getByTestId("reader-center-hit");
    await centre.click();
    await expect(page.getByRole("complementary", { name: "目录" })).toHaveAttribute("data-open", "true");
    await centre.click();
    await expect(page.locator('aside[aria-label="目录"]')).toHaveAttribute("data-open", "false");
    await page.getByRole("button", { name: "下一页" }).click();
    expect(await centre.evaluate((element) => document.activeElement === element)).toBe(false);
    expect(await centre.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("none");

    await centre.click();
    await page.getByRole("button", { name: "图片" }).click();
    const gallery = page.getByRole("complementary", { name: "图片目录" });
    await expect(gallery).toHaveAttribute("data-open", "true");
    await gallery.getByRole("button", { name: "查看封面" }).click();
    const preview = page.getByRole("dialog", { name: "封面大图" });
    await expect(preview.getByRole("img", { name: "封面" })).toBeVisible();
    await expect.poll(() => preview.getByRole("img", { name: "封面" })
      .evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await page.getByRole("button", { name: "关闭图片预览" }).click();
    await expect(preview).toHaveCount(0);
  } finally {
    await application.close().catch(() => undefined);
    await rm(fixtureRoot, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
});
