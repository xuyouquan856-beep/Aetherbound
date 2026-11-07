import { expect, test, _electron as electron } from "@playwright/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The regression a user reported after using the screen for real.
 *
 * They scanned a folder, imported the books, and then filed a series into a collection
 * **by hand, under a name of their own** — and the series tab kept offering to file it,
 * pointing at a collection named after the filename. Accepting would have created a
 * second collection nobody asked for.
 *
 * The fixture keeps their series name verbatim, because the original name contains
 * parentheses and full-width characters and is exactly the sort of thing a name-based
 * lookup gets wrong. The collection is deliberately called something else.
 */
const SERIES = "転生したらチートだけど美少女に性転換ですョ(ToT)";
const USER_NAME = "性转合集";

test("a series filed by hand under another name stops being suggested", async () => {
  test.setTimeout(240_000);

  const dataRoot = await mkdtemp(join(tmpdir(), "aetherbound-organized-e2e-"));
  const booksRoot = await mkdtemp(join(tmpdir(), "aetherbound-organized-books-"));
  await mkdir(join(booksRoot, "性转"), { recursive: true });
  for (let volume = 1; volume <= 3; volume += 1) {
    // A body that does not read like a title, so the volume marker stays where it belongs:
    // in the file name.
    await writeFile(
      join(booksRoot, "性转", `${SERIES} 第${volume}卷.txt`),
      `这是第 ${volume} 卷的正文内容。`,
    );
  }

  const application = await electron.launch({
    args: [resolve("out/main/index.js")],
    env: { ...process.env, READER_DATA_ROOT: dataRoot },
  });

  try {
    await application.evaluate(async ({ dialog }, folder) => {
      (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () => ({
        canceled: false,
        filePaths: [folder],
      });
    }, booksRoot);

    const page = await application.firstWindow();
    await page.waitForURL((url) => url.protocol === "reader-app:");
    await page.setViewportSize({ width: 1500, height: 1000 });

    await page.getByRole("button", { name: /扫描书库/ }).first().click({ force: true });
    await page.getByRole("button", { name: "选择文件夹" }).first().click();
    await page.getByRole("button", { name: "开始扫描" }).click();
    await expect(page.getByLabel("扫描结果概览")).toBeVisible({ timeout: 120_000 });

    // The series is detected and offered — otherwise the rest of the test proves nothing.
    await page.getByRole("button", { name: /^疑似系列/ }).click();
    await expect(page.getByText(new RegExp(`「${escapeRegExp(SERIES)}」`))).toBeVisible({ timeout: 20_000 });

    // Import the volumes, then file them by hand under a name of the user's choosing.
    await page.getByRole("button", { name: /^待导入/ }).click();
    await page.getByRole("button", { name: /导入全部 3 本/ }).click();
    await expect(page.getByText(/已导入 3 本/)).toBeVisible({ timeout: 60_000 });

    const filed = await page.evaluate(async (collectionName) => {
      const api = (window as unknown as {
        readerApi: {
          library: { list(): Promise<Array<{ id: string; format: string }>> };
          collections: {
            create(name: string): Promise<{ id: string; name: string }>;
            addBooks(id: string, bookIds: string[]): Promise<unknown>;
          };
        };
      }).readerApi;
      const books = await api.library.list();
      const collection = await api.collections.create(collectionName);
      await api.collections.addBooks(collection.id, books.map((book) => book.id));
      return { collection: collection.name, books: books.length };
    }, USER_NAME);
    expect(filed).toEqual({ collection: USER_NAME, books: 3 });

    // Come back to the scan screen. The suggestion must be gone even though the
    // collection is not named after the series.
    await page.getByRole("button", { name: "书房" }).first().click({ force: true });
    await page.waitForTimeout(500);
    await page.getByRole("button", { name: /扫描书库/ }).first().click({ force: true });
    await page.getByRole("button", { name: /^疑似系列/ }).click();

    await expect(page.getByText("没有发现疑似系列。")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(new RegExp(`「${escapeRegExp(SERIES)}」`))).toHaveCount(0);
    // And the summary counts zero of them rather than still treating one as pending.
    await expect(page.getByLabel("扫描结果概览")).toContainText("疑似系列0组");

    // Nothing was created behind the user's back: one collection, the one they named.
    const collections = await page.evaluate(async () => {
      const api = (window as unknown as {
        readerApi: { collections: { list(): Promise<Array<{ name: string }>> } };
      }).readerApi;
      return (await api.collections.list()).map((item) => item.name);
    });
    expect(collections).toEqual([USER_NAME]);
  } finally {
    await application.close();
    await rm(dataRoot, { recursive: true, force: true });
    await rm(booksRoot, { recursive: true, force: true });
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
