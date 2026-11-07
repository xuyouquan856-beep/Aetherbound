import { expect, test, _electron as electron } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createEpubFixture } from "./fixtures/epub-fixture.js";

async function launchBook(path: string) {
  const dataRoot = await mkdtemp(join(tmpdir(), "reader-tools-data-"));
  const application = await electron.launch({ ...(process.env.READER_E2E_EXECUTABLE ? { executablePath: process.env.READER_E2E_EXECUTABLE, args: [] } : { args: [resolve("out/main/index.js")] }), env: {
    ...process.env, READER_DATA_ROOT: dataRoot, READER_E2E: "1", READER_E2E_IMPORT_PATH: path,
  } });
  const page = await application.firstWindow();
  await page.waitForURL((url) => url.protocol === "reader-app:");
  if (process.env.READER_E2E_EXECUTABLE) {
    // Packaged builds deliberately ignore the developer auto-import environment variable.
    // Exercise the real import IPC with an isolated file-picker result instead.
    await application.evaluate(({ dialog }, filePath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
    }, path);
    await page.evaluate(() => window.readerApi.library.importFiles());
    await page.reload();
  }
  return { application, page, dataRoot };
}

test("EPUB selection CFI, visible mark, search, and navigation work in the runner", async () => {
  test.setTimeout(90_000);
  const fixtureRoot = await mkdtemp(join(tmpdir(), "reader-tools-epub-"));
  const epubPath = await createEpubFixture(fixtureRoot);
  const { application, page, dataRoot } = await launchBook(epubPath);
  try {
    await page.getByRole("region", { name: "最近加入" }).getByRole("button", { name: "打开《EPUB 验收书》" }).click();
    const runner = page.frameLocator('iframe[title="EPUB 正文"]');
    await expect(runner.locator("html")).toHaveAttribute("data-ready", "true");
    await runner.locator("html").evaluate(() => {
      const view = document.querySelector("foliate-view") as HTMLElement & { renderer: { getContents(): Array<{ doc: Document }> } };
      const paragraph = view.renderer.getContents().map((entry) => entry.doc.querySelector("#anchor")).find(Boolean)!;
      const doc = paragraph.ownerDocument;
      const text = paragraph.firstChild!;
      const range = doc.createRange();
      range.setStart(text, 0);
      range.setEnd(text, 8);
      doc.defaultView!.getSelection()!.removeAllRanges();
      doc.defaultView!.getSelection()!.addRange(range);
      doc.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    });
    await expect(page.getByRole("toolbar", { name: "选文操作" })).toBeVisible();
    const selection = await page.evaluate(() => {
      const toolbar = document.querySelector(".reader-selection-tools");
      return toolbar?.textContent;
    });
    expect(selection).toBeTruthy();
    const wire = await page.evaluate(async () => {
      const frame = document.querySelector<HTMLIFrameElement>('iframe[title="EPUB 正文"]')!;
      const params = new URL(frame.src).searchParams;
      const identity = { version: 1, bookId: params.get("bookId"), sourceRevision: params.get("sourceRevision"), nonce: params.get("nonce") };
      const send = (command: Record<string, unknown>) => frame.contentWindow!.postMessage({ channel: "reader-epub-command", ...identity, ...command }, "reader-rendition://epub");
      const wait = (name: string) => new Promise<any>((resolve) => {
        const listener = (event: MessageEvent) => {
          if (event.origin === "reader-rendition://epub" && event.source === frame.contentWindow && event.data?.event === name) {
            window.removeEventListener("message", listener); resolve(event.data);
          }
        };
        window.addEventListener("message", listener);
      });
      const pending = wait("search-results");
      send({ command: "search", query: "稳定正文文本", requestId: 49 });
      const result = await pending;
      const first = result.results[0];
      send({ command: "setMarks", marks: [{ id: "mark-1", location: first.location, color: "yellow" }] });
      send({ command: "navigateLocation", location: first.location });
      return { count: result.results.length, cfi: first.location.primary.engineLocator.value };
    });
    expect(wire.count).toBeGreaterThan(0);
    expect(wire.cfi).toMatch(/^epubcfi\(/);
    await expect.poll(() => runner.locator("html").evaluate(() => {
      const view = document.querySelector("foliate-view") as HTMLElement & { renderer: { getContents(): Array<{ overlayer?: { element: Element } }> } };
      return view.renderer.getContents().some((entry) => !!entry.overlayer?.element.querySelector("rect"));
    })).toBe(true);
  } finally {
    await application.close().catch(() => undefined);
    await rm(fixtureRoot, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("TXT cross-paragraph selection has a toolbar and a plain click clears it", async () => {
  test.setTimeout(60_000);
  const fixtureRoot = await mkdtemp(join(tmpdir(), "reader-tools-txt-"));
  const txtPath = join(fixtureRoot, "interaction.txt");
  await writeFile(txtPath, "第一章\n\n第一段😀文字。\n\n第二段内容。\n\n第三段内容。", "utf8");
  const { application, page, dataRoot } = await launchBook(txtPath);
  try {
    await page.getByRole("button", { name: /打开《/ }).first().click();
    await expect(page.getByTestId("reading-scroller")).toBeVisible();
    await page.getByTestId("reading-scroller").evaluate((scroller) => {
      const paragraphs = scroller.querySelectorAll("[data-txt-block]");
      const range = document.createRange();
      range.setStart(paragraphs[1].firstChild!, 0);
      range.setEnd(paragraphs[2].firstChild!, 3);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      scroller.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    });
    await expect(page.getByRole("toolbar", { name: "选文操作" })).toBeVisible();
    await page.getByTestId("reading-scroller").locator("[data-txt-block]").last().click();
    await expect(page.getByRole("toolbar", { name: "选文操作" })).toHaveCount(0);
  } finally {
    await application.close().catch(() => undefined);
    await rm(fixtureRoot, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("reading records survive a restart and quotes remain after the book is removed", async () => {
  test.setTimeout(120_000);
  const fixtureRoot = await mkdtemp(join(tmpdir(), "reader-record-roundtrip-"));
  const txtPath = join(fixtureRoot, "roundtrip.txt");
  await writeFile(txtPath, "第一章\n\n这是需要收藏的原文。\n\n这是另一段笔记。\n\n第二章\n\n这里是第二章独有的星辰。", "utf8");
  let { application, page, dataRoot } = await launchBook(txtPath);
  try {
    await page.getByRole("button", { name: /打开《/ }).first().click();
    const selectText = async () => {
      await page.getByTestId("reading-scroller").evaluate(scroller => {
        const paragraph = scroller.querySelectorAll("[data-txt-block]")[1];
        const range = document.createRange(); range.selectNodeContents(paragraph);
        window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
        scroller.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      });
      await expect(page.getByRole("toolbar", { name: "选文操作" })).toBeVisible();
    };
    await expect(page.getByTestId("reading-scroller")).toBeVisible();
    await expect(page.locator(".reader-transition-stage")).toHaveAttribute("data-reader-phase", "active");
    await selectText();
    await page.getByRole("button", { name: "收藏语句", exact: true }).click();
    await expect.poll(() => page.evaluate(async () => (await window.readerApi.records!.list()).length)).toBe(1);
    await expect(page.getByRole("toolbar", { name: "选文操作" })).toHaveCount(0);
    await selectText();
    await page.getByRole("button", { name: "高亮", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (CSS as any).highlights.get("reader-cyan")?.size)).toBe(1);
    await selectText();
    await page.getByRole("button", { name: "笔记", exact: true }).click();
    await page.getByRole("dialog", { name: "阅读笔记" }).getByRole("textbox").fill("重启之后仍然保留的感想");
    await page.getByRole("dialog", { name: "阅读笔记" }).getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "阅读笔记" })).not.toBeVisible();
    await page.getByRole("button", { name: "阅读工具", exact: true }).click();
    await page.getByRole("button", { name: "书签", exact: true }).click();
    await page.getByRole("button", { name: "添加当前位置" }).click();
    await expect(page.locator(".reader-record")).toHaveCount(1);
    await page.getByRole("button", { name: "笔记与摘录", exact: true }).click();
    await page.screenshot({ path: test.info().outputPath("reader-records.png") });
    await page.getByRole("button", { name: "书内搜索", exact: true }).click();
    await page.getByLabel("搜索本书正文").fill("独有的星辰");
    await page.getByRole("button", { name: "查找", exact: true }).click();
    await expect(page.locator(".reader-search-result")).toHaveCount(1);
    await page.locator(".reader-search-result").click();
    await expect(page.getByRole("heading", { name: /第二章/ })).toBeAttached();
    await page.getByRole("button", { name: "返回刚才的位置" }).click();
    await expect(page.getByRole("heading", { name: /第一章/ })).toBeAttached();
    const original = await page.evaluate(() => window.readerApi.records!.list());
    expect(original.map(r => r.kind).sort()).toEqual(["bookmark", "highlight", "note", "quote"]);
    await application.close();
    application = await electron.launch({ ...(process.env.READER_E2E_EXECUTABLE ? { executablePath: process.env.READER_E2E_EXECUTABLE, args: [] } : { args: [resolve("out/main/index.js")] }), env: { ...process.env, READER_DATA_ROOT: dataRoot, READER_E2E: "1" } });
    page = await application.firstWindow();
    await page.waitForURL(url => url.protocol === "reader-app:");
    await page.getByRole("button", { name: /打开《/ }).first().click();
    await expect(page.getByTestId("reading-scroller")).toBeVisible();
    const restored = await page.evaluate(() => window.readerApi.records!.list());
    expect(restored.map(r => r.id).sort()).toEqual(original.map(r => r.id).sort());
    expect(restored.find(r => r.kind === "note")?.note).toBe("重启之后仍然保留的感想");
    await expect.poll(() => page.evaluate(() => (CSS as any).highlights.get("reader-cyan")?.size)).toBe(2);
    const bookId = original[0].bookId!;
    await page.getByRole("button", { name: "阅读工具", exact: true }).click();
    await page.getByRole("button", { name: "书库", exact: true }).click();
    await page.evaluate(id => window.readerApi.library.remove([id], false), bookId);
    const quotes = await page.evaluate(() => window.readerApi.records!.list({ kind: "quote" }));
    expect(quotes).toHaveLength(1);
    expect(quotes[0].bookId).toBeNull();
    expect(quotes[0].text).toContain("需要收藏的原文");
  } finally {
    await application.close().catch(() => undefined);
    await rm(fixtureRoot, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
});
