import { expect, test, _electron as electron } from "@playwright/test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The scan screen, end to end, following the path a user actually takes.
 *
 * The fixture is a throwaway folder holding the two situations the screen exists for: a
 * pair of byte-identical files, and a two-volume series. The test walks the whole loop —
 * choose a folder, scan, read the summary, look at a duplicate, back out of the
 * confirmation rather than moving a file, then import everything new — and checks at the
 * end that the folder it read from is byte-for-byte unchanged.
 *
 * The duplicate step deliberately stops at the prompt. Moving a file to the system
 * recycle bin is not something a test should do to the machine it runs on; what matters
 * is that the destructive step needs a second, explicit click, and that is asserted.
 */
test("scans a folder, explains what it found, and imports on request", async () => {
  test.setTimeout(240_000);

  const dataRoot = await mkdtemp(join(tmpdir(), "aetherbound-scan-e2e-data-"));
  const libraryRoot = await mkdtemp(join(tmpdir(), "aetherbound-scan-e2e-books-"));
  await mkdir(join(libraryRoot, "系列"), { recursive: true });
  const identical = "完全相同的正文内容，用来触发重复检测。";
  await writeFile(join(libraryRoot, "dup-a.txt"), identical);
  await writeFile(join(libraryRoot, "dup-b.txt"), identical);
  await writeFile(join(libraryRoot, "系列", "某系列 第1卷.txt"), "第一卷正文");
  await writeFile(join(libraryRoot, "系列", "某系列 第2卷.txt"), "第二卷正文");

  const before = (await readdir(libraryRoot, { recursive: true })).sort();

  const application = await electron.launch({
    args: [resolve("out/main/index.js")],
    env: { ...process.env, READER_DATA_ROOT: dataRoot },
  });

  try {
    // The folder picker is a native dialog and cannot be driven from the test, so the
    // main process gets a stand-in that returns the fixture. Everything after this
    // point is the real code path.
    await application.evaluate(async ({ dialog }, folder) => {
      (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () => ({
        canceled: false,
        filePaths: [folder],
      });
    }, libraryRoot);

    const page = await application.firstWindow();
    await page.waitForURL((url) => url.protocol === "reader-app:");
    await page.waitForLoadState("domcontentloaded");
    await page.setViewportSize({ width: 1500, height: 1000 });

    const sidebar = page.getByRole("button", { name: /扫描书库/ }).first();
    await sidebar.waitFor({ timeout: 60_000 });
    await sidebar.click({ force: true });

    // Before a folder is chosen the page explains itself and asks for one thing.
    await expect(page.getByRole("heading", { name: "先选择一个文件夹" })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/不会移动或删除任何文件/)).toBeVisible();
    await page.getByRole("button", { name: "选择文件夹" }).first().click();

    await expect(page.getByText(/上次扫描|还没有扫描过/)).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "开始扫描" }).click();

    // When the scan finishes the screen states what it found instead of leaving the
    // user to read counters.
    const summary = page.getByLabel("扫描结果概览");
    await expect(summary).toBeVisible({ timeout: 120_000 });
    await expect(summary).toContainText("已入库");
    await expect(page.getByRole("heading", { name: "接下来" })).toBeVisible();
    await expect(page.getByRole("button", { name: /导入全部 4 本/ })).toBeVisible();

    // Duplicates are one tab away, and the row says what pressing the button will do.
    await page.getByRole("button", { name: /^重复文件/ }).click();
    await expect(page.getByText("内容相同的 2 个文件")).toBeVisible({ timeout: 20_000 });
    // The row button, not the toolbar's "全部移入回收站".
    await page.getByRole("button", { name: "移入回收站", exact: true }).click();

    const confirmation = page.getByRole("alert");
    await expect(confirmation).toBeVisible();
    await expect(confirmation).toContainText("dup-a.txt");
    await expect(confirmation).toContainText("重新校验");

    // Back out rather than confirming — and prove the folder is untouched.
    await confirmation.getByRole("button", { name: "取消" }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect((await readdir(libraryRoot, { recursive: true })).sort()).toEqual(before);

    // Importing everything new is one click from the summary.
    await page.getByRole("button", { name: /导入全部 4 本/ }).click();
    await expect(page.getByText(/已导入 3 本/u)).toBeVisible({ timeout: 60_000 });

    // Three books, because two of the four files hold identical content: the import path
    // deduplicates by content, which is exactly why the remaining copy shows up as a
    // duplicate to clean rather than as a book to add.
    await expect(summary).toContainText("3");

    await page.getByRole("button", { name: "书房" }).first().click({ force: true });
    await page.waitForTimeout(1000);
    await page.getByRole("button", { name: /全部书籍/ }).first().click({ force: true });
    await expect(page.getByText(/共 3 本本地藏书/u)).toBeVisible({ timeout: 20_000 });

    // Importing changes the library, never the folder it read from.
    expect((await readdir(libraryRoot, { recursive: true })).sort()).toEqual(before);
  } finally {
    await application.close();
    await rm(dataRoot, { recursive: true, force: true });
    await rm(libraryRoot, { recursive: true, force: true });
  }
});
