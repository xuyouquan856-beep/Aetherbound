import { expect, test, _electron as electron } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("reviews a series, removes a wrong match, and later removes a mistaken member", async () => {
  test.setTimeout(120_000);
  const dataRoot = await mkdtemp(join(tmpdir(), "reader-series-review-data-"));
  const filesRoot = await mkdtemp(join(tmpdir(), "reader-series-review-files-"));
  const paths = await Promise.all([
    "星河物语 第1卷", "星河物语 第2卷", "星河物语 第3卷",
  ].map(async (title) => {
    const path = join(filesRoot, `${title}.txt`);
    await writeFile(path, `${title}\n这是一本用于验证归类操作的书。`, "utf8");
    return path;
  }));
  const application = await electron.launch({
    ...(process.env.READER_SERIES_PACKAGED === "1"
      ? { executablePath: resolve(process.env.READER_E2E_EXECUTABLE ?? "release/distribution/win-unpacked/Aetherbound.exe") }
      : { args: [resolve("out/main/index.js")] }),
    env: { ...process.env, READER_DATA_ROOT: dataRoot },
  });
  try {
    await application.evaluate(({ dialog }, filePaths) => {
      Object.assign(dialog, {
        showOpenDialog: async () => ({ canceled: false, filePaths, bookmarks: [] }),
      });
    }, paths);
    const page = await application.firstWindow();
    await page.waitForURL((url) => url.protocol === "reader-app:");
    await page.getByRole("button", { name: "导入" }).click();
    await page.getByRole("menuitem", { name: "导入书籍文件" }).click();
    await expect(page.getByRole("status", { name: "书籍文件导入结果" }))
      .toContainText("新加入 3", { timeout: 60_000 });

    await page.getByRole("button", { name: "全部书籍" }).first().click();
    await page.getByRole("button", { name: "整理系列" }).click();
    await page.getByRole("button", { name: /检查系列《星河物语》/ }).click();
    await page.getByRole("button", { name: "移出建议《星河物语 第3卷》" }).click();
    await page.getByRole("button", { name: "确认加入珍藏" }).click();

    await page.getByRole("button", { name: /检查系列《星河物语》/ }).click();
    const existingBooks = page.getByRole("list", { name: "珍藏现有书籍" });
    await expect(existingBooks).toContainText("星河物语 第1卷");
    await expect(existingBooks).toContainText("星河物语 第2卷");
    await expect(page.locator(".series-review__selected .series-review__cover")).toHaveCount(1);
    await expect(existingBooks.locator(".series-review__cover")).toHaveCount(2);
    await page.getByRole("button", { name: "返回建议" }).click();

    await page.getByRole("button", { name: "我的珍藏" }).first().click();
    await page.getByRole("button", { name: /星河物语/ }).first().click();
    await expect(page.getByRole("heading", { name: "星河物语", exact: true })).toBeVisible();
    await expect(page.getByText("2 本书，按你设定的顺序排列")).toBeVisible();
    await page.getByRole("button", { name: "拖动排序《星河物语 第2卷》" })
      .dragTo(page.getByRole("button", { name: "拖动排序《星河物语 第1卷》" }).locator(".."));
    await expect(page.getByRole("list", { name: "珍藏书籍" }).locator("li").first()).toContainText("星河物语 第2卷");
    await page.getByRole("button", { name: "管理珍藏书籍" }).click();
    await page.getByRole("checkbox", { name: "选择《星河物语 第2卷》" }).check();
    await page.getByRole("button", { name: "从珍藏移出所选" }).click();
    await expect(page.getByText("1 本书，按你设定的顺序排列")).toBeVisible();
    await expect(page.getByRole("button", { name: "打开《星河物语 第2卷》" })).toHaveCount(0);

    await page.getByRole("button", { name: "全部书籍" }).first().click();
    await page.getByRole("button", { name: "打开《星河物语 第1卷》" }).hover();
    await page.mouse.down();
    await page.waitForTimeout(550);
    await page.mouse.up();
    await expect(page.getByText("已选择 1 本")).toBeVisible();
    await page.getByRole("button", { name: "移出书架" }).click();
    await expect(page.getByRole("checkbox", { name: /同时删除原始文件/ })).not.toBeChecked();
  } finally {
    await application.close().catch(() => undefined);
    await rm(dataRoot, { recursive: true, force: true });
    await rm(filesRoot, { recursive: true, force: true });
  }
});
