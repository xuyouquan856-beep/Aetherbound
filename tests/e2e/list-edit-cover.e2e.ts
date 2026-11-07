import { expect, test, _electron as electron } from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("list selection keeps its checkmark outside the book cover", async () => {
  const executablePath = resolve(process.env.READER_E2E_EXECUTABLE ?? "release/distribution/win-unpacked/Aetherbound.exe");
  test.skip(!existsSync(executablePath), "Build the current packaged app first.");
  const dataRoot = await mkdtemp(join(tmpdir(), "reader-list-edit-data-"));
  const filesRoot = await mkdtemp(join(tmpdir(), "reader-list-edit-files-"));
  const bookPath = join(filesRoot, "封面位置.txt");
  await writeFile(bookPath, "封面位置\n\n第一章\n这是一段测试正文。", "utf8");
  const application = await electron.launch({
    executablePath,
    env: { ...process.env, READER_DATA_ROOT: dataRoot },
  });
  try {
    await application.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path], bookmarks: [] });
    }, bookPath);
    const page = await application.firstWindow();
    await page.waitForURL((url) => url.protocol === "reader-app:");
    await page.getByRole("button", { name: "导入" }).click();
    await page.getByRole("menuitem", { name: "导入书籍文件" }).click();
    await expect(page.getByRole("status", { name: "书籍文件导入结果" })).toContainText("新加入 1");
    await page.getByRole("button", { name: "全部书籍" }).first().click();
    await page.getByRole("button", { name: "列表" }).click();
    await page.getByRole("button", { name: "编辑书架" }).click();

    const positions = await page.locator(".book-grid--list .book-tile__button").first().evaluate((button) => {
      const check = button.querySelector(".book-tile__check")!.getBoundingClientRect();
      const cover = button.querySelector(".book-cover")!.getBoundingClientRect();
      return { checkRight: check.right, coverLeft: cover.left };
    });
    expect(positions.checkRight).toBeLessThan(positions.coverLeft);
  } finally {
    await application.close().catch(() => undefined);
    await rm(dataRoot, { recursive: true, force: true });
    await rm(filesRoot, { recursive: true, force: true });
  }
});
