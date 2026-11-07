// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/renderer/src/app/App.js";
import {
  DefaultReaderShortcutProfile,
  DefaultReadingAppearance,
  type BookSummary,
  type ReaderApi,
  type TxtBookDetails,
  type TxtBookSummary,
} from "../../src/shared/contracts.js";
import { createScanApiStub } from "./scan-api-stub.js";

const availableBook: TxtBookSummary = {
  coverUrl: null,
  id: "book-1",
  title: "长夜书",
  author: "林舟",
  format: "txt",
  availabilityStatus: "available",
  progress: 0.26,
  addedAt: "2026-07-29T00:00:00.000Z",
  lastReadAt: "2026-07-29T01:00:00.000Z",
  updatedAt: "2026-07-29T01:00:00.000Z",
};

const secondBook: TxtBookSummary = {
  ...availableBook,
  id: "book-2",
  title: "星海书",
  author: "顾遥",
  progress: 0,
};

function txtDetails(book: TxtBookSummary = availableBook): TxtBookDetails {
  return {
    book,
    sourceRevision: `revision-${book.id}`,
    chapters: [{
      id: "chapter-1",
      title: "第一章",
      index: 0,
      startOffset: 0,
      endOffset: 12,
    }],
    savedLocation: null,
    sessionId: `session-${book.id}`,
  };
}

function createApi(initialBooks: BookSummary[] = []) {
  let books = initialBooks;
  const api: ReaderApi = {
    app: { getInfo: vi.fn(async () => ({ name: "Aetherbound", version: "0.1.0", platform: "win32" })) },
    library: {
      list: vi.fn(async () => books),
      importTxt: vi.fn(async () => {
        books = [availableBook];
        return {
          status: "completed" as const,
          items: [{
            status: "imported" as const,
            fileName: "long-night.txt",
            book: availableBook,
          }],
        };
      }),
      importEpub: vi.fn(),
      importFiles: vi.fn(async () => ({ status: "cancelled" as const })),
      onImportProgress: vi.fn(() => () => undefined),
      remove: vi.fn(async (bookIds: string[]) => {
        const before = books.length;
        books = books.filter((book) => !bookIds.includes(book.id));
        return { removed: before - books.length };
      }),
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
      open: vi.fn(async () => ({
        book: availableBook,
        sourceRevision: "rev-1",
        chapters: [{ id: "chapter-1", title: "第一章", index: 0, startOffset: 0, endOffset: 8 }],
        savedLocation: null,
        sessionId: "session-1",
      })),
      getEpubBinary: vi.fn(async (bookId, sourceRevision) => ({
        bookId,
        sourceRevision,
        mediaType: "application/epub+zip" as const,
        bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
      })),
      canResume: vi.fn(async () => true),
      getChapter: vi.fn(async (bookId, chapterId) => ({
        bookId,
        sourceRevision: `revision-${bookId}`,
        chapter: {
          id: chapterId,
          title: "第一章",
          index: 0,
          startOffset: 0,
          endOffset: 12,
        },
        text: "第一章\n\n正文内容",
        totalCharacters: 12,
      })),
      saveProgress: vi.fn(async () => undefined),
      closeSession: vi.fn(async () => undefined),
    },
    settings: {
      getAppearance: vi.fn(async () => DefaultReadingAppearance),
      updateAppearance: vi.fn(async (value) => value),
      getShortcuts: vi.fn(async () => DefaultReaderShortcutProfile),
      updateShortcuts: vi.fn(async (value) => value),
    },
    search: {
      fulltext: vi.fn(async () => []),
    },
    scan: createScanApiStub(),
  };
  return api;
}

afterEach(cleanup);

describe("Aetherbound App Shell and Library Views", () => {
  it("renders fixed sidebar navigation with approved brand image and page aria-current", async () => {
    render(<App api={createApi([availableBook, secondBook])} />);

    const brandImg = await screen.findByRole("img", { name: "Aetherbound 图标" });
    expect(brandImg).toBeInTheDocument();

    const homeNav = screen.getByRole("button", { name: /书房/ });
    const booksNav = screen.getByRole("button", { name: /全部书籍/ });

    expect(homeNav).toHaveAttribute("aria-current", "page");
    expect(booksNav).not.toHaveAttribute("aria-current");
    expect(screen.queryByRole("button", { name: /图书管理员/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    const motionToggle = screen.getByRole("switch", { name: "流光动效" });
    fireEvent.click(motionToggle);
    expect(motionToggle).toHaveAttribute("aria-checked", "false");
    expect(window.localStorage.getItem("aetherbound.library.motion")).toBe("off");

    fireEvent.click(booksNav);
    expect(booksNav).toHaveAttribute("aria-current", "page");
    expect(homeNav).not.toHaveAttribute("aria-current");
  });

  it("filters books in search command bar", async () => {
    render(<App api={createApi([availableBook, secondBook])} />);

    // Navigate to All Books
    fireEvent.click(await screen.findByRole("button", { name: /全部书籍/ }));
    expect((await screen.findAllByText("长夜书")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("星海书").length).toBeGreaterThan(0);

    const searchInput = screen.getByPlaceholderText(/搜索/);
    fireEvent.change(searchInput, { target: { value: "星海" } });

    expect(screen.queryByText("长夜书")).not.toBeInTheDocument();
    expect(screen.getAllByText("星海书").length).toBeGreaterThan(0);

    fireEvent.change(searchInput, { target: { value: "林舟" } });
    expect(screen.getAllByText("长夜书").length).toBeGreaterThan(0);
    expect(screen.queryByText("星海书")).not.toBeInTheDocument();
  });

  it("keeps the all-books query when visiting collections and returning", async () => {
    render(<App api={createApi([availableBook, secondBook])} />);
    fireEvent.click(await screen.findByRole("button", { name: /全部书籍/ }));
    const searchInput = screen.getByRole("searchbox", { name: "搜索全部书籍" });
    fireEvent.change(searchInput, { target: { value: "星海" } });
    expect(screen.getByRole("button", { name: /全部书籍/ })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByText("长夜书")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /我的珍藏/ }));
    expect(screen.queryByRole("searchbox", { name: "搜索全部书籍" })).not.toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "搜索珍藏" })).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: /全部书籍/ }));
    expect(screen.getByRole("searchbox", { name: "搜索全部书籍" })).toHaveValue("星海");
    expect(screen.queryByText("长夜书")).not.toBeInTheDocument();
    expect(screen.getAllByText("星海书").length).toBeGreaterThan(0);
  });

  it("searches collection names separately and hides the top search outside the two shelves", async () => {
    const api = createApi([availableBook, secondBook]);
    api.collections.list = vi.fn(async () => [
      { id: "c1", name: "星海系列", bookCount: 1, previewBooks: [availableBook], updatedAt: "2026-07-29T00:00:00.000Z" },
      { id: "c2", name: "长夜系列", bookCount: 1, previewBooks: [secondBook], updatedAt: "2026-07-29T00:00:00.000Z" },
    ]);
    api.collections.get = vi.fn(async () => ({
      id: "c2", name: "长夜系列", books: [secondBook],
      createdAt: "2026-07-29T00:00:00.000Z", updatedAt: "2026-07-29T00:00:00.000Z",
    }));
    render(<App api={api} />);
    await screen.findByRole("button", { name: /我的珍藏/ });
    expect(screen.queryByRole("searchbox", { name: "搜索全部书籍" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /我的珍藏/ }));
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索珍藏" }), { target: { value: "长夜" } });
    expect(screen.getByRole("button", { name: /打开珍藏《长夜系列》/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /打开珍藏《星海系列》/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /全部书籍/ }));
    expect(screen.getByRole("searchbox", { name: "搜索全部书籍" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "打开《长夜书》" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开《星海书》" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /我的珍藏/ }));
    expect(screen.getByRole("searchbox", { name: "搜索珍藏" })).toHaveValue("长夜");
    fireEvent.click(screen.getByRole("button", { name: /打开珍藏《长夜系列》/ }));
    expect(screen.queryByRole("searchbox", { name: "搜索珍藏" })).not.toBeInTheDocument();
  });

  it("restores the collections list scroll position after opening a collection", async () => {
    const api = createApi([availableBook]);
    api.collections.list = vi.fn(async () => [{
      id: "collection-1",
      name: "夜航",
      bookCount: 1,
      previewBooks: [availableBook],
      updatedAt: "2026-07-29T00:00:00.000Z",
    }]);
    api.collections.get = vi.fn(async () => ({
      id: "collection-1",
      name: "夜航",
      books: [availableBook],
      createdAt: "2026-07-29T00:00:00.000Z",
      updatedAt: "2026-07-29T00:00:00.000Z",
    }));
    render(<App api={api} />);

    fireEvent.click(await screen.findByRole("button", { name: /我的珍藏/ }));
    const scroller = document.querySelector<HTMLElement>(".app-shell__page")!;
    scroller.scrollTop = 420;
    fireEvent.scroll(scroller);
    fireEvent.click(await screen.findByRole("button", { name: /打开珍藏《夜航》/ }));
    expect(await screen.findByRole("heading", { name: "夜航" })).toBeInTheDocument();
    scroller.scrollTop = 0; // The shorter detail page clamps a real browser's scroll position.
    fireEvent.click(screen.getByRole("button", { name: "返回" }));

    expect(scroller.scrollTop).toBe(420);
  });

  it("restores the shelf scroll position after reading when its hidden layer was clamped", async () => {
    render(<App api={createApi([availableBook, secondBook])} />);
    fireEvent.click(await screen.findByRole("button", { name: /全部书籍/ }));
    const scroller = document.querySelector<HTMLElement>(".app-shell__page")!;
    scroller.scrollTop = 350;
    fireEvent.scroll(scroller);
    fireEvent.click(screen.getByRole("button", { name: "打开《长夜书》" }));
    await waitFor(() => expect(document.querySelector("[data-reader-phase]"))
      .toHaveAttribute("data-reader-phase", "presenting"));
    fireEvent.transitionEnd(screen.getByTestId("reader-transition-reader"), { propertyName: "opacity" });
    await waitFor(() => expect(document.querySelector("[data-reader-phase]"))
      .toHaveAttribute("data-reader-phase", "active"));
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);

    fireEvent.keyDown(window, { code: "Escape" });
    await waitFor(() => expect(document.querySelector("[data-reader-phase]"))
      .toHaveAttribute("data-reader-phase", "suspended"));
    expect(scroller.scrollTop).toBe(350);
  });

  it("keeps loaded shelf batches and scroll depth across page switches", async () => {
    const manyBooks = Array.from({ length: 170 }, (_, index) => ({
      ...availableBook,
      id: `many-${index}`,
      title: `藏书 ${index}`,
    }));
    render(<App api={createApi(manyBooks)} />);
    fireEvent.click(await screen.findByRole("button", { name: /全部书籍/ }));
    fireEvent.click(screen.getByRole("button", { name: "继续加载" }));
    expect(screen.getAllByTestId("book-tile")).toHaveLength(160);
    const scroller = document.querySelector<HTMLElement>(".app-shell__page")!;
    scroller.scrollTop = 920;
    fireEvent.scroll(scroller);

    fireEvent.click(screen.getByRole("button", { name: /我的珍藏/ }));
    scroller.scrollTop = 0;
    fireEvent.click(screen.getByRole("button", { name: /全部书籍/ }));

    expect(screen.getAllByTestId("book-tile")).toHaveLength(160);
    expect(scroller.scrollTop).toBe(920);
  });

  it("exposes one mixed book-file import action", async () => {
    const api = createApi([]);
    const importFiles = vi.fn(async () => ({
      status: "completed" as const,
      items: [{ status: "imported" as const, fileName: "long-night.txt", book: availableBook }],
    }));
    api.library.importFiles = importFiles;
    render(<App api={api} />);

    const importTrigger = await screen.findByRole("button", { name: /导入/ });
    fireEvent.click(importTrigger);

    fireEvent.click(screen.getByRole("menuitem", { name: "导入书籍文件" }));
    await waitFor(() => expect(importFiles).toHaveBeenCalledOnce());
    expect(await screen.findByRole("status", { name: "书籍文件导入结果" })).toHaveTextContent("新加入 1");
  });

  it("renders continuation hero in Home view", async () => {
    render(<App api={createApi([availableBook, secondBook])} />);

    expect(await screen.findByRole("heading", { name: "继续阅读" })).toBeInTheDocument();
    expect(screen.getAllByText("长夜书").length).toBeGreaterThan(0);
    const prewarm = document.querySelector<HTMLIFrameElement>(
      'iframe[data-epub-runner-prewarm="true"]',
    );
    expect(prewarm).toBeInTheDocument();
    expect(prewarm?.src).toMatch(/^reader-rendition:\/\/epub\/epub-runner\.html\?/);
    expect(prewarm?.src).not.toMatch(/[A-Z]:\\|sourcePath|filePath/i);
  });

  it("keeps the library mounted, suspends one reader, and warm-resumes it", async () => {
    const api = createApi([availableBook]);
    let resolveOpen!: (details: TxtBookDetails) => void;
    vi.mocked(api.reader.open).mockImplementation(() =>
      new Promise<TxtBookDetails>((resolve) => {
        resolveOpen = resolve;
      }),
    );
    const { container } = render(<App api={api} />);
    const continueButton = await screen.findByRole("button", { name: /继续阅读/ });
    const originalLibraryShell = container.querySelector(".app-shell");

    fireEvent.click(continueButton);

    expect(screen.getByRole("heading", { name: /继续阅读/ })).toBeVisible();
    resolveOpen(txtDetails());
    const readerLayer = await screen.findByTestId("reader-transition-reader");
    expect(container.querySelector(".app-shell")).toBe(originalLibraryShell);
    await waitFor(() => expect(
      container.querySelector("[data-reader-phase]"),
    ).toHaveAttribute("data-reader-phase", "presenting"));
    fireEvent.transitionEnd(readerLayer, { propertyName: "opacity" });
    await waitFor(() => expect(
      container.querySelector("[data-reader-phase]"),
    ).toHaveAttribute("data-reader-phase", "active"));

    fireEvent.keyDown(window, { code: "Escape" });
    await waitFor(() => expect(
      container.querySelector("[data-reader-phase]"),
    ).toHaveAttribute("data-reader-phase", "suspended"));
    expect(screen.getByTestId("reader-transition-library"))
      .toHaveAttribute("aria-hidden", "false");

    fireEvent.click(screen.getByRole("button", { name: /继续阅读/ }));
    await waitFor(() => expect(api.reader.canResume).toHaveBeenCalledWith(
      availableBook.id,
      `revision-${availableBook.id}`,
    ));
    expect(api.reader.open).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(
      container.querySelector("[data-reader-phase]"),
    ).toHaveAttribute("data-reader-phase", "presenting"));
  });

  it("selects books in edit mode and removes them only after confirmation", async () => {
    const api = createApi([availableBook]);
    render(<App api={api} />);

    fireEvent.click(await screen.findByRole("button", { name: /全部书籍/ }));
    fireEvent.click(screen.getByRole("button", { name: "编辑书架" }));
    fireEvent.click(screen.getByRole("button", { name: "选择《长夜书》" }));
    fireEvent.click(screen.getByRole("button", { name: "移出书架" }));

    expect(screen.getByRole("dialog", { name: "确认移出书架" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认移出" }));

    await waitFor(() => expect(api.library.remove).toHaveBeenCalledWith(["book-1"]));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "长夜书" })).not.toBeInTheDocument());
    expect(api.collections.list).toHaveBeenCalledTimes(2);
    expect(api.collections.listUnorganized).toHaveBeenCalledTimes(2);
  });
});
