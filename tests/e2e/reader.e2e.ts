import { expect, test, _electron as electron, type ElectronApplication, type FrameLocator, type Page } from "@playwright/test";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { createEpubFixture } from "./fixtures/epub-fixture.js";
import {
  createCollectionFolderFixture,
  snapshotFixture,
} from "./fixtures/collection-folder-fixture.js";
import { LibraryService } from "../../src/backend/library/library-service.js";
import { openDatabase } from "../../src/backend/storage/database.js";

const corpusRoot = process.env.READER_TEST_CORPUS;
const tempRemovalOptions = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 } as const;

async function launchReader(dataRoot: string, importPath?: string) {
  const application = await electron.launch({
    args: [resolve("out/main/index.js")],
    env: {
      ...process.env,
      READER_DATA_ROOT: dataRoot,
      ...(importPath ? { READER_E2E: "1", READER_E2E_IMPORT_PATH: importPath } : {}),
    },
  });
  const page = await application.firstWindow();
  await page.waitForURL((url) => url.protocol === "reader-app:");
  await page.waitForLoadState("domcontentloaded");
  return { application, page };
}

async function quoteIsInViewport(page: Page, quote: string) {
  return page.getByTestId("reading-scroller").evaluate((node, expected) => {
    const paragraph = [...node.querySelectorAll<HTMLElement>("[data-txt-block]")].find((item) => item.textContent?.includes(expected));
    const textNode = paragraph?.firstChild;
    if (!paragraph || !textNode?.textContent) return false;
    const offset = textNode.textContent.indexOf(expected);
    if (offset < 0) return false;
    const range = document.createRange();
    range.setStart(textNode, offset);
    range.setEnd(textNode, offset + expected.length);
    const quoteRect = range.getBoundingClientRect();
    const viewportRect = node.getBoundingClientRect();
    return quoteRect.bottom > viewportRect.top && quoteRect.top < viewportRect.bottom;
  }, quote);
}

async function publicationElementIsInViewport(runner: FrameLocator, selector: string) {
  return runner.locator("html").evaluate((_, targetSelector) => {
    const view = document.querySelector("foliate-view") as HTMLElement & {
      renderer: { getContents(): Array<{ doc: Document }> };
    };
    const element = view.renderer.getContents()
      .map(({ doc }) => doc.querySelector<HTMLElement>(targetSelector))
      .find(Boolean);
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const viewport = element.ownerDocument.documentElement;
    return rect.bottom > 0 && rect.top < viewport.clientHeight
      && rect.right > 0 && rect.left < viewport.clientWidth;
  }, selector);
}

async function waitForStableCfi(runner: FrameLocator, previous: string | null) {
  let last: string | null = null;
  let repeated = 0;
  let settled: string | null = null;
  await expect.poll(async () => {
    const current = await runner.locator("html").getAttribute("data-cfi");
    repeated = current && current !== previous && current === last ? repeated + 1 : 0;
    last = current;
    if (repeated >= 2) settled = current;
    return settled;
  }, { timeout: 12_000, intervals: [100, 100, 150, 200] }).not.toBeNull();
  return settled;
}

test("imports real TXT, saves reading state and restores after restart", async () => {
  test.skip(!corpusRoot, "Set READER_TEST_CORPUS to run the read-only real-corpus test.");
  const txtName = (await readdir(corpusRoot!)).find((name) => name.toLowerCase().endsWith(".txt"));
  if (!txtName) throw new Error("No TXT fixture found.");
  const txtPath = join(corpusRoot!, txtName);
  const dataRoot = await mkdtemp(join(tmpdir(), "reader-e2e-data-"));
  let liveApplication: ElectronApplication | undefined;
  let savedQuote = "";

  try {
    const first = await launchReader(dataRoot, txtPath);
    liveApplication = first.application;
    await expect(first.page.getByText("本以为转生到了无双游戏，看来这里其实是硬核的致郁游戏").first()).toBeVisible();
    await first.page.screenshot({ path: "test-results/library-1280.png", fullPage: true });
    await first.page.getByRole("button", { name: /打开《本以为转生到了无双游戏/ }).click();

    await first.application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1600, 1000));
    await expect(first.page.getByTestId("reader-hints")).toContainText("第1话");
    await first.page.screenshot({ path: "test-results/reader-1600.png", fullPage: true });
    await first.page.keyboard.press("KeyC");
    await expect(first.page.getByRole("complementary", { name: "目录" })).toHaveAttribute("data-open", "true");
    await first.page.getByRole("button", { name: /第2话/ }).click();
    await expect(first.page.getByTestId("reader-hints")).toContainText("第2话");

    await first.page.keyboard.press("KeyV");
    const fontSize = first.page.getByRole("slider", { name: "字号" });
    await fontSize.fill("24");
    await expect(fontSize).toHaveValue("24");
    await first.page.getByRole("button", { name: "夜间主题" }).click();
    await expect(first.page.locator(".app")).toHaveAttribute("data-theme", "night");
    await first.page.screenshot({ path: "test-results/reader-night-1600.png", fullPage: true });
    await first.page.getByTestId("reading-scroller").evaluate((node) => {
      node.scrollTop = Math.max(1, Math.round((node.scrollHeight - node.clientHeight) * 0.45));
      node.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await first.page.waitForTimeout(900);
    await first.page.keyboard.press("Escape");
    await first.page.keyboard.press("Escape");
    await expect(first.page.getByRole("button", { name: /书架/ })).toBeVisible();
    await first.application.close();
    liveApplication = undefined;
    const progressDb = new Database(join(dataRoot, "reader.db"), { readonly: true });
    const progressRow = progressDb.prepare("SELECT locator_json FROM reading_progress").get() as { locator_json: string };
    savedQuote = (JSON.parse(progressRow.locator_json) as { text: { exact: string } }).text.exact;
    progressDb.close();
    expect(savedQuote.length).toBeGreaterThan(4);

    const second = await launchReader(dataRoot);
    liveApplication = second.application;
    await second.page.getByRole("button", { name: /打开《本以为转生到了无双游戏/ }).click();
    await expect(second.page.getByTestId("reader-hints")).toContainText("第2话");
    await second.page.keyboard.press("KeyV");
    await expect(second.page.getByRole("slider", { name: "字号" })).toHaveValue("24");
    await second.page.keyboard.press("Escape");
    await expect.poll(() => quoteIsInViewport(second.page, savedQuote)).toBe(true);
    await second.page.keyboard.press("Escape");
    await second.application.close();
    liveApplication = undefined;
  } finally {
    if (liveApplication) await liveApplication.close().catch(() => undefined);
    await rm(dataRoot, tempRemovalOptions);
  }
});

test("imports EPUB through the isolated foliate runner and restores CFI progress", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "reader-epub-fixture-"));
  const dataRoot = await mkdtemp(join(tmpdir(), "reader-epub-e2e-data-"));
  const epubPath = await createEpubFixture(fixtureRoot);
  let liveApplication: ElectronApplication | undefined;
  try {
    const first = await launchReader(dataRoot, epubPath);
    liveApplication = first.application;
    await expect(first.page.getByRole("button", { name: /图书管理员/ })).toHaveCount(0);
    const cover = first.page.locator("img.book-cover__image");
    await expect(cover).toBeVisible();
    await expect(cover).toHaveAttribute("src", /^reader-resource:\/\/publication\//);
    expect(
      await cover.evaluate((node) => (node as HTMLImageElement).naturalWidth),
    ).toBeGreaterThan(0);
    const coldStartedAt = Date.now();
    await expect(first.page.getByText("EPUB 验收书").first()).toBeVisible();
    await first.page.getByRole("button", { name: "打开《EPUB 验收书》" }).click();
    const runner = first.page.frameLocator('iframe[title="EPUB 正文"]');
    await expect(runner.locator("html")).toHaveAttribute("data-ready", "true");
    await expect(first.page.locator(".reader-transition-stage"))
      .toHaveAttribute("data-reader-phase", "active");
    test.info().annotations.push({
      type: "reader-cold-open-baseline-ms",
      description: String(Date.now() - coldStartedAt),
    });
    expect(await runner.locator("html").evaluate(() => !(window as Window & { readerApi?: unknown }).readerApi)).toBe(true);
    const cfiBeforeNextPage = await runner.locator("html").getAttribute("data-cfi");
    await first.page.keyboard.press("KeyD");
    const cfiAfterNextPage = await waitForStableCfi(runner, cfiBeforeNextPage);
    await first.page.keyboard.press("KeyA");
    await waitForStableCfi(runner, cfiAfterNextPage);
    await expect(runner.locator("html")).toHaveAttribute("data-spine-index", "0");
    const firstDocumentEvidence = await runner.locator("html").evaluate(async () => {
      const view = document.querySelector("foliate-view") as HTMLElement & { renderer: { getContents(): Array<{ doc: Document }> } };
      const publication = view.renderer.getContents()[0]?.doc;
      const loadedFont = await publication?.fonts?.load("16px Phase0Embedded");
      await publication?.fonts?.ready;
      return {
        ruby: publication?.querySelector("ruby rt")?.textContent,
        script: Boolean(publication?.querySelector("script")),
        eventHandler: Boolean(publication?.querySelector("[onload]")),
        remoteImage: publication?.querySelector("img")?.getAttribute("src") ?? null,
        font: Boolean(loadedFont?.length) && (publication?.fonts?.check("16px Phase0Embedded") ?? false),
      };
    });
    expect(firstDocumentEvidence).toEqual({ ruby: "かん", script: false, eventHandler: false, remoteImage: null, font: true });

    const stageBeforePanel = await first.page.locator(".reader-stage").boundingBox();
    await first.page.keyboard.press("KeyC");
    await expect(first.page.getByRole("complementary", { name: "目录" })).toHaveAttribute("data-open", "true");
    await expect(first.page.locator(".reader-stage")).toHaveCSS("filter", "none");
    const stageWithPanel = await first.page.locator(".reader-stage").boundingBox();
    expect(stageWithPanel?.width).toBe(stageBeforePanel?.width);
    await first.page.getByRole("button", { name: /第一章/ }).click();
    await expect(runner.locator("html")).toHaveAttribute("data-spine-index", "0");
    await first.page.keyboard.press("KeyV");
    await expect(first.page.getByRole("complementary", { name: "阅读外观" })).toHaveAttribute("data-open", "true");

    await expect.poll(() => publicationElementIsInViewport(runner, "#anchor")).toBe(true);
    const layoutBefore = await runner.locator("html").getAttribute("data-layout-transaction");
    await first.page.getByRole("button", { name: "单栏阅读" }).click();
    await expect.poll(() => runner.locator("html").getAttribute("data-layout-transaction"))
      .not.toBe(layoutBefore);
    await expect(runner.locator("html")).toHaveAttribute("data-layout-state", "stable");
    await expect.poll(() => publicationElementIsInViewport(runner, "#anchor")).toBe(true);
    expect(await runner.locator("html").evaluate(() => {
      const view = document.querySelector("foliate-view") as HTMLElement & { renderer: HTMLElement };
      return {
        width: view.renderer.getAttribute("max-inline-size"),
        columns: view.renderer.getAttribute("max-column-count"),
      };
    })).toEqual({ width: "720px", columns: "1" });

    const pageWidth = first.page.getByRole("slider", { name: "页宽" });
    const widthTransaction = await runner.locator("html").getAttribute("data-layout-transaction");
    await pageWidth.fill("800");
    await expect.poll(() => runner.locator("html").getAttribute("data-layout-transaction"))
      .not.toBe(widthTransaction);
    await expect(runner.locator("html")).toHaveAttribute("data-layout-state", "stable");
    expect(await runner.locator("html").evaluate(() => {
      const view = document.querySelector("foliate-view") as HTMLElement & { renderer: HTMLElement };
      return view.renderer.getAttribute("max-inline-size");
    })).toBe("800px");
    await expect.poll(() => publicationElementIsInViewport(runner, "#anchor")).toBe(true);

    await runner.locator("html").evaluate(() => {
      const view = document.querySelector("foliate-view") as HTMLElement & { renderer: { getContents(): Array<{ doc: Document }> } };
      view.renderer.getContents()[0]?.doc.querySelector<HTMLElement>("#to-second")?.click();
    });
    await expect(runner.locator("html")).toHaveAttribute("data-spine-index", "1");
    await expect(first.page.getByTestId("reader-hints")).not.toContainText("计算中");
    await expect(first.page.getByRole("button", { name: "返回链接原处" })).toBeEnabled();
    await first.page.getByRole("button", { name: "返回链接原处" }).click();
    await expect(runner.locator("html")).toHaveAttribute("data-spine-index", "0");
    await expect(first.page.getByRole("button", { name: "再次前进" })).toBeEnabled();
    await first.page.getByRole("button", { name: "再次前进" }).click();
    await expect(runner.locator("html")).toHaveAttribute("data-spine-index", "1");

    const vertical = await runner.locator("html").evaluate(() => {
      const view = document.querySelector("foliate-view") as HTMLElement & { renderer: { getContents(): Array<{ doc: Document }> } };
      const publication = view.renderer.getContents()[0]?.doc;
      const element = publication?.querySelector(".vertical");
      return {
        computed: element ? element.ownerDocument.defaultView?.getComputedStyle(element).writingMode : "",
        className: element?.getAttribute("class") ?? null,
      };
    });
    expect(vertical.computed, JSON.stringify(vertical)).toBe("vertical-rl");
    expect(vertical.className).toBe("vertical");

    const typographyTransaction = await runner.locator("html").getAttribute("data-layout-transaction");
    await first.page.getByRole("slider", { name: "段间距" }).fill("0.8");
    await first.page.getByRole("slider", { name: "字距" }).fill("0.06");
    await first.page.getByRole("button", { name: "取消首行缩进" }).click();
    await expect.poll(() => runner.locator("html").getAttribute("data-layout-transaction"))
      .not.toBe(typographyTransaction);
    await expect(runner.locator("html")).toHaveAttribute("data-layout-state", "stable");
    const typography = await runner.locator("html").evaluate(() => {
      const view = document.querySelector("foliate-view") as HTMLElement & { renderer: { getContents(): Array<{ doc: Document }> } };
      const publication = view.renderer.getContents()[0]?.doc;
      const paragraph = publication?.querySelector("p:not(.vertical)");
      const computed = paragraph ? paragraph.ownerDocument.defaultView?.getComputedStyle(paragraph) : null;
      return {
        indent: computed?.textIndent ?? "",
        letterSpacing: computed?.letterSpacing ?? "",
        marginBlockEnd: computed?.marginBlockEnd ?? "",
      };
    });
    expect(typography.indent).toBe("0px");
    expect(typography.letterSpacing).not.toBe("normal");
    expect(typography.marginBlockEnd).not.toBe("0px");

    await first.page.getByRole("button", { name: "滚动阅读" }).click();
    await expect(runner.locator("html")).toHaveAttribute("data-flow", "scrolled");
    await first.page.getByRole("button", { name: "夜间主题" }).click();
    await expect(runner.locator("html")).toHaveAttribute("data-theme", "night");
    const brightness = first.page.getByRole("slider", { name: "亮度" });
    await brightness.fill("95");
    await expect(brightness).toHaveValue("95");
    await expect(first.page.getByTestId("reader-brightness")).toHaveAttribute("style", /--reader-dim: 0\.05/);
    const shortcutCapture = first.page.getByRole("button", { name: "修改下一页的第一个按键" });
    await shortcutCapture.click();
    await shortcutCapture.press("KeyK");
    await expect(first.page.getByRole("button", { name: "修改下一页的第一个按键" })).toHaveText("K");
    await expect(runner.locator("html")).toHaveAttribute("data-spine-index", "1");
    await first.page.waitForTimeout(900);
    await first.page.keyboard.press("Escape");
    await first.page.keyboard.press("Escape");
    await first.application.close();
    liveApplication = undefined;

    const db = new Database(join(dataRoot, "reader.db"), { readonly: true });
    const row = db.prepare("SELECT locator_json FROM reading_progress").get() as { locator_json: string };
    const saved = JSON.parse(row.locator_json) as { format: string; primary: { spineIndex: number; engineLocator: { value: string } }; text: { exact: string } };
    db.close();
    expect(saved.format).toBe("epub");
    expect(saved.primary.spineIndex).toBe(1);
    expect(saved.primary.engineLocator.value).toMatch(/^epubcfi\(/);

    const second = await launchReader(dataRoot);
    liveApplication = second.application;
    await second.page.evaluate(() => {
      const observations: Array<{ ready: string | null; opacity: string }> = [];
      Object.assign(window, { __epubVisibilityObservations: observations });
      new MutationObserver(() => {
        const frame = document.querySelector<HTMLIFrameElement>(
          'iframe[title="EPUB 正文"]',
        );
        if (frame) {
          observations.push({
            ready: frame.getAttribute("data-ready"),
            opacity: getComputedStyle(frame).opacity,
          });
        }
      }).observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["data-ready"],
      });
    });
    await second.page.getByRole("button", { name: "打开《EPUB 验收书》" }).click();
    const restoredFrame = second.page.locator('iframe[title="EPUB 正文"]');
    const restored = second.page.frameLocator('iframe[title="EPUB 正文"]');
    await expect(restored.locator("html")).toHaveAttribute("data-ready", "true");
    await expect(restored.locator("html")).toHaveAttribute("data-spine-index", "1");
    await expect(restoredFrame).toHaveCSS("opacity", "1");
    await second.page.keyboard.press("KeyV");
    await expect(second.page.getByRole("slider", { name: "亮度" })).toHaveValue("95");
    await expect(second.page.getByRole("slider", { name: "页宽" })).toHaveValue("800");
    await expect(second.page.getByRole("button", { name: "滚动阅读" })).toHaveAttribute("data-active", "true");
    await expect(second.page.getByRole("button", { name: "单栏阅读" })).toHaveAttribute("data-active", "true");
    await expect(second.page.getByRole("button", { name: "单栏阅读" })).toBeDisabled();
    await expect(second.page.getByRole("slider", { name: "段间距" })).toHaveValue("0.8");
    await expect(second.page.getByRole("slider", { name: "字距" })).toHaveValue("0.06");
    await expect(second.page.getByRole("button", { name: "取消首行缩进" })).toHaveAttribute("data-active", "true");
    await expect(second.page.getByRole("button", { name: "修改下一页的第一个按键" })).toHaveText("K");
    const observations = await second.page.evaluate(
      () => (window as typeof window & {
        __epubVisibilityObservations: Array<{ ready: string | null; opacity: string }>;
      }).__epubVisibilityObservations,
    );
    const hiddenRestoreStates = observations.filter((entry) => entry.ready === "false");
    expect(hiddenRestoreStates.length).toBeGreaterThan(0);
    expect(hiddenRestoreStates.every((entry) => entry.opacity === "0")).toBe(true);
    await second.page.keyboard.press("Escape");
    await second.page.keyboard.press("Escape");
    await second.application.close();
    liveApplication = undefined;
  } finally {
    if (liveApplication) await liveApplication.close().catch(() => undefined);
    await rm(fixtureRoot, tempRemovalOptions);
    await rm(dataRoot, tempRemovalOptions);
  }
});

test("edits the bookshelf without deleting original book files", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "reader-edit-fixture-"));
  const dataRoot = await mkdtemp(join(tmpdir(), "reader-edit-data-"));
  const txtPath = join(fixtureRoot, "可移出的书.txt");
  await writeFile(txtPath, "可移出的书\n测试作者\n\n# 第一章\n正文", "utf8");
  const epubPath = await createEpubFixture(fixtureRoot);
  let application: ElectronApplication | undefined;
  try {
    const prepared = openDatabase(dataRoot);
    const library = new LibraryService(prepared.db, dataRoot);
    await library.importTxt(txtPath);
    await library.importEpub(epubPath);
    prepared.close();

    const launched = await launchReader(dataRoot);
    application = launched.application;
    await launched.page.getByRole("button", { name: /全部书籍/ }).click();
    await expect(launched.page.getByText("共 2 本本地藏书。")).toBeVisible();
    await launched.page.getByRole("button", { name: "编辑书架" }).click();
    await launched.page.getByRole("button", { name: "选择《可移出的书》" }).click();
    await expect(launched.page.getByText("已选择 1 本")).toBeVisible();
    await launched.page.screenshot({ path: "test-results/library-edit-mode.png", fullPage: true });
    await launched.page.getByRole("button", { name: "移出书架" }).click();
    await expect(launched.page.getByRole("dialog", { name: "确认移出书架" })).toBeVisible();
    await launched.page.getByRole("button", { name: "确认移出" }).click();

    await expect(launched.page.getByText("共 1 本本地藏书。")).toBeVisible();
    await expect(launched.page.getByRole("heading", { name: "可移出的书" })).toHaveCount(0);
    await expect(launched.page.getByText("EPUB 验收书").first()).toBeVisible();
    expect((await stat(txtPath)).isFile()).toBe(true);
    expect((await stat(epubPath)).isFile()).toBe(true);
    await application.close();
    application = undefined;
  } finally {
    if (application) await application.close().catch(() => undefined);
    await rm(fixtureRoot, tempRemovalOptions);
    await rm(dataRoot, tempRemovalOptions);
  }
});

test("packaged Windows directory starts and opens EPUB through custom protocols", async () => {
  const packagedPath = join(process.cwd(), "release/distribution/win-unpacked/Aetherbound.exe");
  const executablePath = process.env.READER_E2E_EXECUTABLE || (await stat(packagedPath).then((s) => s.isFile()).catch(() => false) ? packagedPath : undefined);
  test.skip(!executablePath, "Set READER_PACKAGED_EXE or build the Windows directory first.");
  const dataRoot = await mkdtemp(join(tmpdir(), "reader-packaged-data-"));
  const fixtureRoot = await mkdtemp(join(tmpdir(), "reader-packaged-fixture-"));
  const epubPath = await createEpubFixture(fixtureRoot);
  let application: ElectronApplication | undefined;
  try {
    const prepared = openDatabase(dataRoot);
    await new LibraryService(prepared.db, dataRoot).importEpub(epubPath);
    prepared.close();
    application = await electron.launch({ executablePath, env: { ...process.env, READER_DATA_ROOT: dataRoot } });
    const page = await application.firstWindow();
    await page.waitForURL((url) => url.protocol === "reader-app:");
    await expect(page.getByRole("button", { name: /图书管理员/ })).toHaveCount(0);
    await expect(page.getByText("EPUB 验收书").first()).toBeVisible();
    await page.getByRole("button", { name: "打开《EPUB 验收书》" }).click();
    await expect(page.frameLocator('iframe[title="EPUB 正文"]').locator("html")).toHaveAttribute("data-ready", "true");
    await application.close();
    application = undefined;
  } finally {
    if (application) await application.close().catch(() => undefined);
    await rm(dataRoot, tempRemovalOptions);
    await rm(fixtureRoot, tempRemovalOptions);
  }
});

test("prepares a normally imported EPUB in the background without opening it", async () => {
  test.setTimeout(60_000);
  const fixtureRoot = await mkdtemp(join(tmpdir(), "reader-background-import-fixture-"));
  const dataRoot = await mkdtemp(join(tmpdir(), "reader-background-import-data-"));
  const epubPath = await createEpubFixture(fixtureRoot);
  let application: ElectronApplication | undefined;

  try {
    const launched = await launchReader(dataRoot);
    application = launched.application;
    await application.evaluate(({ dialog }, sourcePath) => {
      Object.assign(dialog, {
        showOpenDialog: async (options: Electron.OpenDialogOptions) => {
          const acceptsEpub = options.filters?.some((filter) =>
            filter.extensions.includes("epub"));
          return acceptsEpub
            ? { canceled: false, filePaths: [sourcePath], bookmarks: [] }
            : { canceled: true, filePaths: [], bookmarks: [] };
        },
      });
    }, epubPath);

    await launched.page.getByRole("button", { name: "导入" }).click();
    await launched.page.getByRole("menuitem", { name: "导入 EPUB" }).click();

    await expect(launched.page.getByRole("heading", { name: "EPUB 验收书" }))
      .toBeVisible();
    await expect(launched.page.locator("img.book-cover__image")).toBeVisible();
    await expect(launched.page.getByText("准备中")).toHaveCount(0);
    await application.close();
    application = undefined;
  } finally {
    if (application) await application.close().catch(() => undefined);
    await rm(dataRoot, tempRemovalOptions);
    await rm(fixtureRoot, tempRemovalOptions);
  }
});

test("imports a folder collection before background preparation and preserves sources across restart", async () => {
  test.setTimeout(120_000);
  const fixture = await createCollectionFolderFixture();
  const dataRoot = await mkdtemp(join(tmpdir(), "reader-collection-e2e-data-"));
  let liveApplication: ElectronApplication | undefined;

  try {
    const first = await launchReader(dataRoot);
    liveApplication = first.application;
    await first.application.evaluate(({ dialog }, folderRoot) => {
      const original = dialog.showOpenDialog.bind(dialog);
      let available = true;
      Object.assign(dialog, {
        showOpenDialog: async (options: Electron.OpenDialogOptions) => {
          if (available && options.properties?.includes("openDirectory")) {
            available = false;
            return { canceled: false, filePaths: [folderRoot], bookmarks: [] };
          }
          return original(options);
        },
      });
    }, fixture.folderRoot);

    await first.page.getByRole("button", { name: "导入" }).click();
    await first.page.getByRole("menuitem", { name: "导入文件夹为珍藏" }).click();
    await expect(first.page.getByRole("heading", { name: "星海珍藏" })).toBeVisible();
    await expect(first.page.getByText(/4 本书/)).toBeVisible();
    await expect(first.page.getByText("嵌套禁入")).toHaveCount(0);

    await expect(first.page.getByRole("button", { name: "打开《01-星海封面卷》" }))
      .toContainText("准备中");
    await first.page.getByRole("button", { name: "打开《01-星海封面卷》" }).click();
    await expect(first.page.getByRole("heading", { name: "正在准备本书" })).toBeVisible();
    await expect(first.page.frameLocator('iframe[title="EPUB 正文"]').locator("html"))
      .toHaveAttribute("data-ready", "true");
    await expect(first.page.locator(".reader-transition-stage"))
      .toHaveAttribute("data-reader-phase", "active");
    await first.page.keyboard.press("Escape");
    await expect(first.page.getByRole("button", { name: "我的珍藏" })).toBeVisible();
    await expect(first.page.locator(".collection-book-list img.book-cover__image"))
      .toHaveCount(1);

    await first.page.getByRole("button", { name: "我的珍藏" }).click();
    const importedCollection = first.page.getByRole("button", {
      name: /打开珍藏《星海珍藏》/,
    });
    await expect(importedCollection.locator("img")).toHaveCount(1);
    await importedCollection.click();
    await expect(first.page.getByRole("button", { name: "重试准备《05-损坏》" }))
      .toContainText("准备失败 · 点击重试");
    await expect(first.page.locator(".collection-book-list img.book-cover__image")).toHaveCount(1);

    await first.page.getByRole("button", { name: "我的珍藏" }).click();
    await first.page.getByRole("button", { name: "新建珍藏" }).click();
    await first.page.getByLabel("珍藏名称").fill("待读");
    await first.page.getByRole("button", { name: "创建珍藏" }).click();
    await expect(first.page.getByRole("heading", { name: "待读" })).toBeVisible();

    await first.page.getByRole("button", { name: "全部书籍" }).click();
    await first.page.getByRole("button", { name: "编辑书架" }).click();
    await first.page.getByRole("button", { name: "选择《星海短篇》" }).click();
    await first.page.getByRole("button", { name: "加入珍藏" }).click();
    await first.page.getByRole("checkbox", { name: /待读/ }).click();
    await first.page.getByRole("button", { name: "加入所选珍藏" }).click();

    await first.page.getByRole("button", { name: "我的珍藏" }).click();
    await first.page.getByRole("button", { name: /打开珍藏《星海珍藏》/ }).click();
    await first.page.getByRole("button", { name: "下移《星海封面卷》" }).click();
    await expect(first.page.locator(".collection-book-list .book-tile__title").first())
      .toHaveText("星海无封面卷");

    await first.application.close();
    liveApplication = undefined;

    const membershipDb = new Database(join(dataRoot, "reader.db"), { readonly: true });
    const sharedMemberships = membershipDb.prepare(`
      SELECT COUNT(*) AS count
      FROM collection_books cb
      JOIN books b ON b.id = cb.book_id
      WHERE b.title = '星海短篇'
    `).get() as { count: number };
    membershipDb.close();
    expect(sharedMemberships.count).toBe(2);

    const second = await launchReader(dataRoot);
    liveApplication = second.application;
    await second.page.getByRole("button", { name: "我的珍藏" }).click();
    await second.page.getByRole("button", { name: /打开珍藏《星海珍藏》/ }).click();
    await expect(second.page.locator(".collection-book-list .book-tile__title").first())
      .toHaveText("星海无封面卷");
    await expect(second.page.locator(".collection-book-list img.book-cover__image")).toHaveCount(1);

    await second.page.getByRole("button", { name: "我的珍藏" }).click();
    await second.page.getByRole("button", { name: /打开珍藏《待读》/ }).click();
    await second.page.getByRole("button", { name: "删除珍藏" }).click();
    await expect(second.page.getByText("书籍与原文件不会删除")).toBeVisible();
    await second.page.getByRole("button", { name: "确认删除" }).click();

    await second.page.getByRole("button", { name: "全部书籍" }).click();
    await expect(second.page.getByRole("heading", { name: "星海封面卷" })).toBeVisible();
    await expect(second.page.getByRole("heading", { name: "星海无封面卷" })).toBeVisible();
    await expect(second.page.getByRole("heading", { name: "星海短篇" })).toBeVisible();
    await second.page.getByRole("button", { name: "打开《星海封面卷》" }).click();
    await expect(second.page.frameLocator('iframe[title="EPUB 正文"]').locator("html"))
      .toHaveAttribute("data-ready", "true");
    await second.page.keyboard.press("Escape");
    await second.page.keyboard.press("Escape");
    await second.application.close();
    liveApplication = undefined;

    expect(await snapshotFixture(fixture.folderRoot)).toEqual(fixture.before);
  } finally {
    if (liveApplication) await liveApplication.close().catch(() => undefined);
    await rm(fixture.tempRoot, tempRemovalOptions);
    await rm(dataRoot, tempRemovalOptions);
  }
});
