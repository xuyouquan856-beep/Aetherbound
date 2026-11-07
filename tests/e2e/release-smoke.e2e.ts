import { expect, test, _electron as electron, type ElectronApplication } from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { createEpubFixture } from "./fixtures/epub-fixture.js";

test("packaged release imports into an isolated profile and survives a restart", async () => {
  test.setTimeout(120_000);
  const executablePath = resolve(process.env.READER_E2E_EXECUTABLE ?? "release/distribution/win-unpacked/Aetherbound.exe");
  test.skip(!existsSync(executablePath), "Build the current packaged app first.");

  const root = await mkdtemp(join(tmpdir(), "aetherbound-release-smoke-"));
  const dataRoot = join(root, "profile");
  const booksRoot = join(root, "books");
  await mkdir(booksRoot);
  const txtPath = join(booksRoot, "发行版测试书.txt");
  await writeFile(txtPath, "发行版测试书\n\n第一章\n这是一次隔离书库的安装包验证。", "utf8");
  const epubPath = await createEpubFixture(booksRoot);
  const originalTxt = await stat(txtPath);
  const originalEpub = await stat(epubPath);
  let application: ElectronApplication | undefined;

  const launch = () => electron.launch({
    executablePath,
    env: { ...process.env, READER_DATA_ROOT: dataRoot },
  });

  try {
    application = await launch();
    await application.evaluate(({ dialog }, paths) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths, bookmarks: [] });
    }, [txtPath, epubPath]);
    const page = await application.firstWindow();
    await page.waitForURL((url) => url.protocol === "reader-app:");
    await page.getByRole("button", { name: "导入" }).click();
    await page.getByRole("menuitem", { name: "导入书籍文件" }).click();
    await expect(page.getByRole("status", { name: "书籍文件导入结果" })).toContainText("新加入 2", { timeout: 60_000 });

    await application.close();
    application = undefined;
    const db = new Database(join(dataRoot, "reader.db"), { readonly: true, fileMustExist: true });
    try {
      expect((db.prepare("SELECT COUNT(*) AS count FROM books").get() as { count: number }).count).toBe(2);
    } finally {
      db.close();
    }

    application = await launch();
    const restarted = await application.firstWindow();
    await restarted.waitForURL((url) => url.protocol === "reader-app:");
    await restarted.getByRole("button", { name: "全部书籍" }).first().click();
    await expect(restarted.getByText("发行版测试书").first()).toBeVisible();
    await expect(restarted.getByText("EPUB 验收书").first()).toBeVisible();

    expect((await stat(txtPath)).size).toBe(originalTxt.size);
    expect((await stat(epubPath)).size).toBe(originalEpub.size);
  } finally {
    if (application) await application.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
