import { expect, test, _electron as electron } from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("removing a book deletes its original only when the user checks that option", async () => {
  const executablePath = resolve(process.env.READER_E2E_EXECUTABLE ?? "release/distribution/win-unpacked/Aetherbound.exe");
  test.skip(!existsSync(executablePath), "Build the current packaged app first.");
  const dataRoot = await mkdtemp(join(tmpdir(), "reader-remove-data-"));
  const filesRoot = await mkdtemp(join(tmpdir(), "reader-remove-files-"));
  const first = join(filesRoot, "第一本.txt");
  const second = join(filesRoot, "第二本.txt");
  const probe = join(filesRoot, "probe.txt");
  await writeFile(first, "第一本\n正文一", "utf8");
  await writeFile(second, "第二本\n正文二", "utf8");
  await writeFile(probe, "probe", "utf8");
  const application = await electron.launch({
    executablePath,
    env: { ...process.env, READER_DATA_ROOT: dataRoot },
  });
  try {
    await application.evaluate(({ dialog }, paths) => {
      Object.assign(dialog, { showOpenDialog: async () => ({ canceled: false, filePaths: paths, bookmarks: [] }) });
    }, [first, second]);
    await application.evaluate(({ shell }) => {
      shell.trashItem = async (path) => {
        const move = process.getBuiltinModule("node:fs")!.promises.rename;
        await move(path, `${path}.recycled`);
      };
    });
    await application.evaluate(({ shell }, path) => shell.trashItem(path), probe);
    expect((await stat(`${probe}.recycled`)).isFile()).toBe(true);
    const page = await application.firstWindow();
    await page.waitForURL((url) => url.protocol === "reader-app:");
    await page.getByRole("button", { name: "导入" }).click();
    await page.getByRole("menuitem", { name: "导入书籍文件" }).click();
    await expect(page.getByRole("status", { name: "书籍文件导入结果" }))
      .toContainText("新加入 2", { timeout: 60_000 });

    await page.getByRole("button", { name: "全部书籍" }).first().click();
    await page.getByRole("button", { name: "编辑书架" }).click();
    await page.getByRole("button", { name: "选择《第一本》" }).click();
    await page.getByRole("button", { name: "移出书架" }).click();
    await page.getByRole("checkbox", { name: /同时删除原始文件/ }).check();
    await page.getByRole("button", { name: "确认移出" }).click();
    await expect(page.getByRole("button", { name: "编辑书架" })).toBeVisible();
    await expect(page.getByRole("button", { name: "打开《第一本》" })).toHaveCount(0);
    await expect.poll(async () => stat(`${first}.recycled`).then(() => true, () => false)).toBe(true);
    await expect.poll(async () => stat(first).then(() => true, () => false)).toBe(false);

    await page.getByRole("button", { name: "编辑书架" }).click();
    await page.getByRole("button", { name: "选择《第二本》" }).click();
    await page.getByRole("button", { name: "移出书架" }).click();
    await expect(page.getByRole("checkbox", { name: /同时删除原始文件/ })).not.toBeChecked();
    await page.getByRole("button", { name: "确认移出" }).click();
    await expect(page.getByRole("button", { name: "打开《第二本》" })).toHaveCount(0);
    expect((await stat(second)).isFile()).toBe(true);
  } finally {
    await application.close().catch(() => undefined);
    await rm(dataRoot, { recursive: true, force: true });
    await rm(filesRoot, { recursive: true, force: true });
  }
});
