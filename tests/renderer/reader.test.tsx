// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { readFile } from "node:fs/promises";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReaderView } from "../../src/renderer/src/features/reader/ReaderView.js";
import {
  DefaultReaderShortcutProfile,
  DefaultReadingAppearance,
  type ChapterContent,
  type ReaderApi,
  type ReadingAppearance,
  type TxtReadingLocationV1,
  type TxtBookDetails,
} from "../../src/shared/contracts.js";
import { createScanApiStub } from "./scan-api-stub.js";

const chapters = [
  { id: "chapter-1", title: "第一章 雨夜", index: 0, startOffset: 0, endOffset: 30 },
  { id: "chapter-2", title: "第二章 清晨", index: 1, startOffset: 30, endOffset: 65 },
];

const chapterContent: Record<string, ChapterContent> = {
  "chapter-1": { bookId: "book-1", sourceRevision: "rev-1", chapter: chapters[0], text: "第一章 雨夜\n\n窗外落着雨。\n\n她翻开了第一页。", totalCharacters: 65 },
  "chapter-2": { bookId: "book-1", sourceRevision: "rev-1", chapter: chapters[1], text: "第二章 清晨\n\n天光越过窗沿。\n\n昨夜的书还放在桌上。", totalCharacters: 65 },
};

const restoredLocation: TxtReadingLocationV1 = {
  locatorVersion: 1,
  sourceRevision: "rev-1",
  format: "txt",
  primary: { kind: "txt", chapterId: "chapter-2", characterOffset: 15 },
  progression: { resource: 0.4, total: 0.7 },
  text: { exact: "越过窗沿", prefix: "第二章 清晨\n\n天光", suffix: "。\n\n昨夜的书还放在桌上。" },
};

function details(savedLocation: TxtReadingLocationV1 | null = null): TxtBookDetails {
  return {
    book: {
      id: "book-1",
      title: "长夜书",
      author: "林舟",
      format: "txt",
      availabilityStatus: "available",
      progress: 0.4,
      addedAt: "2026-07-29T00:00:00.000Z",
      lastReadAt: "2026-07-29T01:00:00.000Z",
      updatedAt: "2026-07-29T01:00:00.000Z",
      coverUrl: null,
    },
    sourceRevision: "rev-1",
    chapters,
    savedLocation,
    sessionId: "session-1",
  };
}

function createApi(): ReaderApi {
  return {
    app: { getInfo: vi.fn() },
    library: {
      list: vi.fn(),
      importTxt: vi.fn(),
      importEpub: vi.fn(),
      importFiles: vi.fn(async () => ({ status: "cancelled" as const })),
      onImportProgress: vi.fn(() => () => undefined),
      remove: vi.fn(),
      retryPreparation: vi.fn(async () => undefined),
      onPreparationChanged: vi.fn(() => () => undefined),
    },
    collections: {
      list: vi.fn(async () => []),
      get: vi.fn(),
      create: vi.fn(),
      rename: vi.fn(),
      delete: vi.fn(async () => undefined),
      addBooks: vi.fn(),
      removeBooks: vi.fn(),
      reorder: vi.fn(),
      getMemberships: vi.fn(async () => []),
      listUnorganized: vi.fn(async () => []),
      importFolder: vi.fn(async () => ({ status: "cancelled" as const })),
      importOrganizedFolder: vi.fn(async () => ({ status: "cancelled" as const })),
      importFiles: vi.fn(async () => ({ status: "cancelled" as const })),
      onFolderImportProgress: vi.fn(() => () => undefined),
    },
    reader: {
      open: vi.fn(),
      getEpubBinary: vi.fn(async (bookId, sourceRevision) => ({
        bookId,
        sourceRevision,
        mediaType: "application/epub+zip" as const,
        bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
      })),
      canResume: vi.fn(async () => true),
      getChapter: vi.fn(async (_bookId, chapterId) => chapterContent[chapterId]),
      saveProgress: vi.fn(async () => undefined),
      closeSession: vi.fn(async () => undefined),
    },
    settings: {
      getAppearance: vi.fn(async () => DefaultReadingAppearance),
      updateAppearance: vi.fn(async (value) => value),
      getShortcuts: vi.fn(async () => DefaultReaderShortcutProfile),
      updateShortcuts: vi.fn(async (value) => value),
    },
    search: { fulltext: vi.fn(async () => []) },
    scan: createScanApiStub(),
  };
}

function Harness({
  api,
  book = details(),
  initialAppearance = DefaultReadingAppearance,
  onReady = vi.fn(),
}: {
  api: ReaderApi;
  book?: TxtBookDetails;
  initialAppearance?: ReadingAppearance;
  onReady?: () => void;
}) {
  const [appearance, setAppearance] = useState(initialAppearance);
  const [shortcuts, setShortcuts] = useState(DefaultReaderShortcutProfile);
  return <ReaderView
    api={api}
    details={book}
    appearance={appearance}
    shortcuts={shortcuts}
    onAppearanceChange={setAppearance}
    onShortcutsChange={setShortcuts}
    active
    onReady={onReady}
    onSuspend={vi.fn()}
    onBack={vi.fn()}
  />;
}

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("TXT reader", () => {
  it("opens tools from the text surface without an invisible centre button", async () => {
    render(<ReaderView api={createApi()} details={details()} appearance={DefaultReadingAppearance} shortcuts={DefaultReaderShortcutProfile} onAppearanceChange={vi.fn()} onShortcutsChange={vi.fn()} onBack={vi.fn()} />);
    await screen.findByRole("heading", { name: "第一章 雨夜" });
    expect(screen.queryByTestId("reader-center-hit")).not.toBeInTheDocument();
    const body = screen.getByRole("article", { name: "正文" });
    fireEvent.pointerDown(body, { clientX: 150, clientY: 150 });
    fireEvent.click(body, { clientX: 150, clientY: 150 });
    expect(screen.getByRole("navigation", { name: "阅读工具栏" })).toBeInTheDocument();
    expect(screen.getByLabelText("目录", { selector: "aside" })).toHaveAttribute("data-open", "false");
    fireEvent.click(screen.getByRole("button", { name: /^目录$/ }));
    expect(screen.getByLabelText("目录", { selector: "aside" })).toHaveAttribute("data-open", "true");
    expect(screen.getByLabelText("阅读外观", { selector: "aside" })).toHaveAttribute("data-open", "false");
    fireEvent.click(screen.getByRole("button", { name: "阅读外观设置" }));
    expect(screen.getByLabelText("目录", { selector: "aside" })).toHaveAttribute("data-open", "false");
    expect(screen.getByLabelText("阅读外观", { selector: "aside" })).toHaveAttribute("data-open", "true");
    fireEvent.click(screen.getByRole("button", { name: "收起阅读外观" }));
    expect(screen.getByRole("button", { name: "下一页" })).toBeEnabled();
  });

  it("does not open tools when text is selected", async () => {
    render(<Harness api={createApi()} />);
    await screen.findByRole("heading", { name: "第一章 雨夜" });
    const body = screen.getByRole("article", { name: "正文" });
    const range = document.createRange(); range.selectNodeContents(body.querySelectorAll("p")[1]);
    window.getSelection()?.addRange(range);
    fireEvent.pointerDown(body); fireEvent.click(body);
    expect(screen.queryByRole("navigation", { name: "阅读工具栏" })).not.toBeInTheDocument();
    window.getSelection()?.removeAllRanges();
  });

  it("clears pointer focus from a page-turn edge after closing the panels", async () => {
    render(<ReaderView
      api={createApi()}
      details={details()}
      appearance={DefaultReadingAppearance}
      shortcuts={DefaultReaderShortcutProfile}
      onAppearanceChange={vi.fn()}
      onShortcutsChange={vi.fn()}
      onBack={vi.fn()}
    />);
    await screen.findByRole("heading", { name: "第一章 雨夜" });

    fireEvent.click(screen.getByRole("button", { name: /^阅读工具$/ }));
    fireEvent.click(screen.getByRole("button", { name: /^阅读工具$/ }));
    const nextPage = screen.getByRole("button", { name: "下一页" });
    nextPage.focus();
    fireEvent.click(nextPage, { detail: 1 });
    expect(document.activeElement).not.toBe(nextPage);

    nextPage.focus();
    fireEvent.click(nextPage, { detail: 0 });
    expect(document.activeElement).toBe(nextPage);
  });

  it("keeps the keyboard shortcuts working one panel at a time", async () => {
    render(<ReaderView
      api={createApi()}
      details={details()}
      appearance={DefaultReadingAppearance}
      shortcuts={DefaultReaderShortcutProfile}
      onAppearanceChange={vi.fn()}
      onShortcutsChange={vi.fn()}
      onBack={vi.fn()}
    />);
    await screen.findByRole("heading", { name: "第一章 雨夜" });

    fireEvent.click(screen.getByRole("button", { name: /^阅读工具$/ }));
    fireEvent.keyDown(window, { code: "Escape" });
    expect(screen.getByLabelText("目录", { selector: "aside" })).toHaveAttribute("data-open", "false");

    // After Escape the shortcuts go back to reveal-one behaviour.
    fireEvent.keyDown(window, { code: "KeyC" });
    expect(screen.getByLabelText("目录", { selector: "aside" })).toHaveAttribute("data-open", "true");
    expect(screen.getByLabelText("阅读外观", { selector: "aside" })).toHaveAttribute("data-open", "false");
  });

  it("keeps the reading surface immersive and opens one overlay panel at a time", async () => {
    const api = createApi();
    const onBack = vi.fn();
    render(<ReaderView
      api={api}
      details={details()}
      appearance={DefaultReadingAppearance}
      shortcuts={DefaultReaderShortcutProfile}
      onAppearanceChange={vi.fn()}
      onShortcutsChange={vi.fn()}
      onBack={onBack}
    />);
    expect(await screen.findByRole("heading", { name: "第一章 雨夜" })).toBeInTheDocument();

    expect(screen.queryByRole("banner")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "上一章" })).not.toBeInTheDocument();
    expect(screen.getByTestId("reader-hints")).toHaveTextContent("第一章 雨夜");
    expect(screen.getByLabelText("目录", { selector: "aside" })).toHaveAttribute("data-open", "false");
    expect(screen.getByLabelText("阅读外观", { selector: "aside" })).toHaveAttribute("data-open", "false");

    fireEvent.keyDown(window, { code: "KeyC" });
    expect(screen.getByRole("complementary", { name: "目录" })).toHaveAttribute("data-open", "true");
    expect(screen.getByRole("button", { name: "下一页" })).toBeDisabled();
    fireEvent.keyDown(window, { code: "KeyV" });
    expect(screen.getByLabelText("目录", { selector: "aside" })).toHaveAttribute("data-open", "false");
    expect(screen.getByRole("complementary", { name: "阅读外观" })).toHaveAttribute("data-open", "true");
    expect(screen.getByRole("slider", { name: "亮度" })).toBeInTheDocument();

    fireEvent.keyDown(window, { code: "Escape" });
    expect(screen.getByLabelText("阅读外观", { selector: "aside" })).toHaveAttribute("data-open", "false");
    expect(screen.getByRole("button", { name: "下一页" })).toBeEnabled();
    expect(onBack).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { code: "Escape" });
    await waitFor(() => expect(onBack).toHaveBeenCalledOnce());
  });

  it("changes app reading brightness without intercepting F11", async () => {
    const api = createApi();
    const onAppearanceChange = vi.fn();
    render(<ReaderView
      api={api}
      details={details()}
      appearance={DefaultReadingAppearance}
      shortcuts={DefaultReaderShortcutProfile}
      onAppearanceChange={onAppearanceChange}
      onShortcutsChange={vi.fn()}
      onBack={vi.fn()}
    />);
    await screen.findByRole("heading", { name: "第一章 雨夜" });

    fireEvent.keyDown(window, { code: "KeyS" });
    await waitFor(() => expect(api.settings.updateAppearance).toHaveBeenCalledWith(
      expect.objectContaining({ brightness: 95 }),
    ));
    expect(screen.getByTestId("reader-brightness")).toHaveStyle({ "--reader-dim": "0.05" });

    const f11 = new KeyboardEvent("keydown", { code: "F11", cancelable: true });
    window.dispatchEvent(f11);
    expect(f11.defaultPrevented).toBe(false);
  });

  it("persists a changed shortcut and uses it immediately", async () => {
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(1000);
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(5000);
    const api = createApi();
    render(<Harness api={api} />);
    await screen.findByRole("heading", { name: "第一章 雨夜" });

    fireEvent.keyDown(window, { code: "KeyV" });
    const capture = screen.getByRole("button", { name: "修改下一页的第一个按键" });
    fireEvent.click(capture);
    fireEvent.keyDown(capture, { code: "KeyK" });
    await waitFor(() => expect(api.settings.updateShortcuts).toHaveBeenCalledWith(
      expect.objectContaining({
        bindings: expect.objectContaining({
          "reader.page.next": expect.arrayContaining([
            expect.objectContaining({ code: "KeyK" }),
          ]),
        }),
      }),
    ));

    fireEvent.keyDown(window, { code: "Escape" });
    const scroller = await screen.findByTestId("reading-scroller");
    scroller.scrollTop = 1000;
    fireEvent.keyDown(window, { code: "KeyK" });
    expect(scroller.scrollTop).toBe(1880);
  });

  it("uses absolute, non-blurred panels that do not resize the reading stage", async () => {
    const css = await readFile("src/renderer/src/styles/app.css", "utf8");
    expect(css).toMatch(/\.reader-panel--chapters\s*\{[^}]*position:\s*absolute/s);
    expect(css).toMatch(/\.reader-panel--appearance\s*\{[^}]*position:\s*absolute/s);
    expect(css).not.toMatch(/reader-panel[^{]*\{[^}]*(backdrop-filter|blur\()/s);
    expect(css).toMatch(/\.reader-stage\s*\{[^}]*position:\s*absolute[^}]*inset:\s*0/s);
  });

  it("opens the saved chapter and restores the quoted anchor", async () => {
    const api = createApi();
    render(<Harness api={api} book={details(restoredLocation)} />);

    expect(await screen.findByRole("heading", { name: "第二章 清晨" })).toBeInTheDocument();
    await waitFor(() => expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled());
    expect(api.reader.getChapter).toHaveBeenCalledWith("book-1", "chapter-2");
    expect(api.reader.getChapter).not.toHaveBeenCalledWith("book-1", "chapter-1");
    expect(api.reader.saveProgress).not.toHaveBeenCalled();
  });

  it("notifies the host after the restored TXT layout is stable", async () => {
    const api = createApi();
    const onReady = vi.fn();
    render(<Harness api={api} book={details(restoredLocation)} onReady={onReady} />);

    await screen.findByRole("heading", { name: /清晨/ });
    await waitFor(() => expect(onReady).toHaveBeenCalledOnce());
  });

  it("flushes progress and suspends without closing the retained session", async () => {
    const api = createApi();
    const onSuspend = vi.fn();
    const onBack = vi.fn();
    render(<ReaderView
      api={api}
      details={details()}
      appearance={DefaultReadingAppearance}
      shortcuts={DefaultReaderShortcutProfile}
      onAppearanceChange={vi.fn()}
      onShortcutsChange={vi.fn()}
      active
      onSuspend={onSuspend}
      onBack={onBack}
    />);
    await screen.findByRole("heading", { name: /雨夜/ });

    fireEvent.keyDown(window, { code: "Escape" });

    await waitFor(() => expect(onSuspend).toHaveBeenCalledOnce());
    expect(api.reader.saveProgress).toHaveBeenCalled();
    expect(api.reader.closeSession).not.toHaveBeenCalled();
    expect(onBack).not.toHaveBeenCalled();
  });

  it("moves by 88 percent of the viewport and crosses chapter boundaries", async () => {
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(1000);
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(5000);
    const api = createApi();
    render(<Harness api={api} />);
    expect(await screen.findByRole("heading", { name: "第一章 雨夜" })).toBeInTheDocument();
    const scroller = await screen.findByTestId("reading-scroller");
    scroller.scrollTop = 1000;

    fireEvent.keyDown(window, { code: "KeyD" });
    expect(scroller.scrollTop).toBe(1880);
    fireEvent.keyDown(window, { code: "KeyA" });
    expect(scroller.scrollTop).toBe(1000);

    scroller.scrollTop = 4000;
    fireEvent.keyDown(window, { code: "KeyD" });
    expect(await screen.findByRole("heading", { name: "第二章 清晨" })).toBeInTheDocument();

    const nextScroller = await screen.findByTestId("reading-scroller");
    expect(nextScroller.scrollTop).toBe(0);
    fireEvent.keyDown(window, { code: "KeyA" });
    expect(await screen.findByRole("heading", { name: "第一章 雨夜" })).toBeInTheDocument();
    expect((await screen.findByTestId("reading-scroller")).scrollTop).toBe(4000);
  });

  it("persists appearance separately and applies reading variables", async () => {
    const api = createApi();
    render(<Harness api={api} />);
    const article = await screen.findByRole("article", { name: "正文" });
    fireEvent.keyDown(window, { code: "KeyV" });

    fireEvent.change(screen.getByRole("slider", { name: "字号" }), { target: { value: "24" } });
    await waitFor(() => expect(api.settings.updateAppearance).toHaveBeenCalledWith(expect.objectContaining({ fontSize: 24 })));
    expect(article).toHaveStyle({ "--reader-font-size": "24px" });

    fireEvent.click(screen.getByRole("button", { name: "夜间主题" }));
    await waitFor(() => expect(api.settings.updateAppearance).toHaveBeenCalledWith(expect.objectContaining({ theme: "night" })));
    expect(screen.getByRole("button", { name: "夜间主题" })).toHaveAttribute("data-active", "true");

    fireEvent.change(screen.getByRole("slider", { name: "段间距" }), { target: { value: "0.8" } });
    await waitFor(() => expect(api.settings.updateAppearance).toHaveBeenCalledWith(
      expect.objectContaining({ paragraphSpacing: 0.8 }),
    ));
    expect(article).toHaveStyle({ "--reader-paragraph-spacing": "0.8em" });

    fireEvent.change(screen.getByRole("slider", { name: "字距" }), { target: { value: "0.06" } });
    await waitFor(() => expect(api.settings.updateAppearance).toHaveBeenCalledWith(
      expect.objectContaining({ letterSpacing: 0.06 }),
    ));
    expect(article).toHaveStyle({ "--reader-letter-spacing": "0.06em" });

    fireEvent.click(screen.getByRole("button", { name: "取消首行缩进" }));
    await waitFor(() => expect(api.settings.updateAppearance).toHaveBeenCalledWith(
      expect.objectContaining({ firstLineIndent: "none" }),
    ));
    expect(article).toHaveStyle({ "--reader-first-line-indent": "0" });
  });

  it("saves a throttled locator without display page numbers", async () => {
    const api = createApi();
    render(<Harness api={api} />);
    const scroller = await screen.findByTestId("reading-scroller");
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, value: 400, writable: true },
    });

    fireEvent.scroll(scroller);
    await waitFor(() => expect(api.reader.saveProgress).toHaveBeenCalled());
    const location = vi.mocked(api.reader.saveProgress).mock.calls.at(-1)?.[2];
    expect(location).toMatchObject({ locatorVersion: 1, sourceRevision: "rev-1", format: "txt" });
    expect(JSON.stringify(location)).not.toMatch(/page/i);
  });

  it("opens and focuses in-book search via bindable shortcut and allows rebinding it", async () => {
    const api = createApi();
    render(<Harness api={api} />);
    await screen.findByRole("heading", { name: "第一章 雨夜" });

    fireEvent.keyDown(window, { code: "KeyF", ctrlKey: true });
    const searchInput = await screen.findByPlaceholderText("搜索本书正文");
    expect(searchInput).toHaveFocus();

    fireEvent.keyDown(searchInput, { code: "Escape" });
    expect(screen.queryByPlaceholderText("搜索本书正文")).not.toBeInTheDocument();

    fireEvent.keyDown(window, { code: "KeyV" });
    const capture = screen.getByRole("button", { name: "修改书内搜索的第一个按键" });
    fireEvent.click(capture);
    fireEvent.keyDown(capture, { code: "Slash" });
    await waitFor(() => expect(api.settings.updateShortcuts).toHaveBeenCalledWith(
      expect.objectContaining({
        bindings: expect.objectContaining({
          "reader.panel.search.toggle": expect.arrayContaining([
            expect.objectContaining({ code: "Slash" }),
          ]),
        }),
      }),
    ));
    await waitFor(() => expect(
      screen.getByRole("button", { name: "修改书内搜索的第一个按键" }),
    ).toHaveTextContent("Slash"));

    fireEvent.keyDown(window, { code: "Slash" });
    expect(await screen.findByPlaceholderText("搜索本书正文")).toHaveFocus();
  });

  it("supports TXT paginated layout, chapter-end continuation button, and per-book appearance override", async () => {
    window.localStorage.clear();
    const api = createApi();
    render(<Harness api={api} />);
    await screen.findByRole("heading", { name: "第一章 雨夜" });

    expect(screen.getByRole("button", { name: "继续阅读：第二章 清晨" })).toBeInTheDocument();

    fireEvent.keyDown(window, { code: "KeyV" });
    fireEvent.click(screen.getByRole("button", { name: "仅应用于本书" }));
    expect(screen.getByRole("button", { name: "仅应用于本书" })).toHaveAttribute("data-active", "true");

    vi.mocked(api.settings.updateAppearance).mockClear();
    fireEvent.click(screen.getByRole("button", { name: "分页阅读" }));
    fireEvent.click(screen.getByRole("button", { name: "双栏阅读" }));

    const scroller = await screen.findByTestId("reading-scroller");
    await waitFor(() => expect(scroller).toHaveAttribute("data-flow", "paginated"));
    expect(scroller).toHaveAttribute("data-columns", "2");
    expect(api.settings.updateAppearance).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("aetherbound.reader.bookAppearance.book-1")).toContain("paginated");
    window.localStorage.clear();
  });
});
