// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/renderer/src/app/App.js";
import { CollectionDetailPage } from "../../src/renderer/src/features/library/CollectionDetailPage.js";
import { CollectionStack } from "../../src/renderer/src/features/library/CollectionStack.js";
import { CollectionsPage } from "../../src/renderer/src/features/library/CollectionsPage.js";
import {
  DefaultReaderShortcutProfile,
  DefaultReadingAppearance,
  type BookSummary,
  type CollectionDetails,
  type CollectionSummary,
  type ReaderApi,
} from "../../src/shared/contracts.js";

function book(id: string, title: string): BookSummary {
  return {
    id,
    title,
    author: "林舟",
    format: "epub",
    coverUrl: null,
    availabilityStatus: "available",
    progress: 0,
    addedAt: "2026-07-29T00:00:00.000Z",
    lastReadAt: null,
    updatedAt: "2026-07-29T00:00:00.000Z",
  };
}

const threeBooks = [book("book-1", "卷一"), book("book-2", "卷二"), book("book-3", "卷三")];

function summary(overrides: Partial<CollectionSummary> = {}): CollectionSummary {
  return {
    id: "collection-1",
    name: "夜航",
    bookCount: 3,
    previewBooks: threeBooks,
    updatedAt: "2026-07-29T00:00:00.000Z",
    ...overrides,
  };
}

function details(overrides: Partial<CollectionDetails> = {}): CollectionDetails {
  return {
    id: "collection-1",
    name: "夜航",
    books: threeBooks,
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
    ...overrides,
  };
}

function appApi(): ReaderApi {
  return {
    app: { getInfo: vi.fn() },
    library: {
      list: vi.fn(async () => [book("all-only", "全部书架独有"), ...threeBooks]),
      importTxt: vi.fn(),
      importEpub: vi.fn(),
      importFiles: vi.fn(async () => ({ status: "cancelled" as const })),
      onImportProgress: vi.fn(() => () => undefined),
      remove: vi.fn(),
      retryPreparation: vi.fn(async () => undefined),
      onPreparationChanged: vi.fn(() => () => undefined),
    },
    collections: {
      list: vi.fn(async () => [summary()]),
      get: vi.fn(async () => details()),
      create: vi.fn(async (name) => details({ name })),
      rename: vi.fn(async (_id, name) => details({ name })),
      delete: vi.fn(async () => undefined),
      addBooks: vi.fn(async () => details()),
      removeBooks: vi.fn(async () => details()),
      reorder: vi.fn(async () => details()),
      getMemberships: vi.fn(async () => []),
      listUnorganized: vi.fn(async () => [book("book-3", "卷三")]),
      importFolder: vi.fn(async () => ({ status: "cancelled" as const })),
      onFolderImportProgress: vi.fn(() => () => undefined),
    },
    reader: {},
    settings: {
      getAppearance: vi.fn(async () => DefaultReadingAppearance),
      updateAppearance: vi.fn(),
      getShortcuts: vi.fn(async () => DefaultReaderShortcutProfile),
      updateShortcuts: vi.fn(),
    },
    search: { fulltext: vi.fn(async () => []) },
  } as unknown as ReaderApi;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("custom collections UI", () => {
  it("reorders collection books by dragging a handle onto another row", async () => {
    const onReorder = vi.fn(async (_id: string, ids: string[]) =>
      details({ books: ids.map((id) => threeBooks.find((item) => item.id === id)!) }));
    render(<CollectionDetailPage collectionId="collection-1" libraryBooks={threeBooks} busy={false}
      onGet={vi.fn(async () => details())} onRename={vi.fn()} onDelete={vi.fn()}
      onAddBooks={vi.fn()} onRemoveBooks={vi.fn()} onReorder={onReorder}
      onOpen={vi.fn()} onBack={vi.fn()} onDeleted={vi.fn()}
      onChanged={vi.fn(async () => undefined)} />);

    const handle = await screen.findByRole("button", { name: "拖动排序《卷一》" });
    const transfer = { setData: vi.fn(), effectAllowed: "none" };
    fireEvent.dragStart(handle, { dataTransfer: transfer });
    const target = screen.getByRole("button", { name: "下移《卷三》" }).closest("li")!;
    fireEvent.dragOver(target, { dataTransfer: transfer });
    fireEvent.drop(target, { dataTransfer: transfer, clientY: 10 });
    await waitFor(() => expect(onReorder).toHaveBeenCalledWith("collection-1", ["book-2", "book-1", "book-3"]));
  });

  it("reuses the three decoded stack covers immediately inside collection details", async () => {
    Object.defineProperty(HTMLImageElement.prototype, "decode", {
      configurable: true,
      value: vi.fn(async () => undefined),
    });
    const covered = threeBooks.map((item, index) => ({
      ...item,
      coverUrl: `reader-resource://publication/${item.id}/shared-${index}/cover`,
    }));
    const stack = render(
      <CollectionStack
        collection={summary({ previewBooks: covered })}
        onSelect={vi.fn()}
      />,
    );
    for (const image of [...stack.container.querySelectorAll("img")]) {
      Object.defineProperties(image, {
        complete: { configurable: true, value: true },
        naturalWidth: { configurable: true, value: 320 },
      });
      fireEvent.load(image);
    }
    await waitFor(() => expect(
      [...stack.container.querySelectorAll("img")].every((image) =>
        image.getAttribute("data-loaded") === "true"),
    ).toBe(true));
    stack.unmount();

    render(
      <CollectionDetailPage
        collectionId="collection-1"
        libraryBooks={covered}
        busy={false}
        onGet={vi.fn(async () => details({ books: covered }))}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onAddBooks={vi.fn()}
        onRemoveBooks={vi.fn()}
        onReorder={vi.fn()}
        onOpen={vi.fn()}
        onBack={vi.fn()}
        onDeleted={vi.fn()}
        onChanged={vi.fn(async () => undefined)}
      />,
    );

    expect(await screen.findByRole("heading", { name: "卷一" })).toBeVisible();
    expect(screen.getAllByRole("img").slice(0, 3).every((image) =>
      image.getAttribute("data-loaded") === "true")).toBe(true);
  });

  it("reveals collection details after the bounded cover-prewarm timeout", async () => {
    vi.useFakeTimers();
    const created: PendingImage[] = [];
    class PendingImage {
      onload: null | (() => void) = null;
      onerror: null | (() => void) = null;
      naturalWidth = 0;
      complete = false;
      src = "";
      decode = vi.fn(() => new Promise<void>(() => undefined));
      constructor() { created.push(this); }
    }
    vi.stubGlobal("Image", PendingImage);
    const covered = Array.from(
      { length: 12 },
      (_, index) => ({
        ...book(`gate-${index}`, `卷${index + 1}`),
        coverUrl: `reader-resource://publication/gate-${index}/rev/cover`,
      }),
    );
    render(
      <CollectionDetailPage
        collectionId="collection-gate"
        libraryBooks={covered}
        busy={false}
        onGet={vi.fn(async () => details({ id: "collection-gate", books: covered }))}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onAddBooks={vi.fn()}
        onRemoveBooks={vi.fn()}
        onReorder={vi.fn()}
        onOpen={vi.fn()}
        onBack={vi.fn()}
        onDeleted={vi.fn()}
        onChanged={vi.fn(async () => undefined)}
      />,
    );

    await act(async () => undefined);
    expect(screen.getByLabelText("正在载入珍藏")).toBeInTheDocument();
    expect(created).toHaveLength(4);
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(screen.getByRole("heading", { name: "卷1" })).toBeVisible();
    expect(created).toHaveLength(4);
  });

  it("navigates from 我的珍藏 to real collection summaries and loads unorganized books separately", async () => {
    const api = appApi();
    render(<App api={api} />);

    fireEvent.click(await screen.findByRole("button", { name: "我的珍藏" }));
    expect(await screen.findByRole("button", { name: /打开珍藏《夜航》/ })).toBeInTheDocument();
    expect(api.collections.list).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "未整理" }));
    expect(await screen.findByRole("heading", { name: "卷三" })).toBeInTheDocument();
    expect(screen.queryByText("全部书架独有")).not.toBeInTheDocument();
    expect(api.collections.listUnorganized).toHaveBeenCalled();
  });

  it("refreshes collection stack covers when canonical library preparation completes", async () => {
    const queued = {
      ...book("book-cover", "星海封面卷"),
      preparationStatus: "queued" as const,
    };
    const prepared = {
      ...queued,
      preparationStatus: "ready" as const,
      coverUrl: "reader-resource://publication/book-cover/revision-cover/cover",
    };
    let emitPreparation!: Parameters<
      ReaderApi["library"]["onPreparationChanged"]
    >[0];
    const api = appApi();
    vi.mocked(api.library.list)
      .mockResolvedValueOnce([queued])
      .mockResolvedValue([prepared]);
    vi.mocked(api.collections.list).mockResolvedValue([
      summary({ bookCount: 1, previewBooks: [queued] }),
    ]);
    api.library.onPreparationChanged = vi.fn((listener) => {
      emitPreparation = listener;
      return () => undefined;
    });
    render(<App api={api} />);

    fireEvent.click(await screen.findByRole("button", { name: "我的珍藏" }));
    const collection = await screen.findByRole("button", {
      name: /打开珍藏《夜航》/,
    });
    expect(collection.querySelector("img")).toBeNull();

    act(() => emitPreparation({
      bookId: queued.id,
      sourceRevision: "revision-cover",
      state: "ready",
      errorCode: null,
    }));

    await waitFor(() => expect(collection.querySelector("img")).toHaveAttribute(
      "src",
      prepared.coverUrl,
    ));
  });

  it("renders three ordered covers in a collection stack", () => {
    render(<CollectionStack collection={summary()} onSelect={vi.fn()} />);
    expect(screen.getAllByTestId("collection-stack-cover")).toHaveLength(3);
    expect(screen.getByRole("button", { name: /打开珍藏《夜航》/ })).toBeInTheDocument();
  });

  it("offers creation and folder import in the empty state and selects an imported collection", async () => {
    const onSelect = vi.fn();
    const onImportFolder = vi.fn(async () => ({
      status: "completed" as const,
      folderName: "星海",
      collection: summary({ id: "folder-collection", name: "星海" }),
      items: [],
      ignoredEntries: 0,
    }));
    render(
      <CollectionsPage
        collections={[]}
        busy={false}
        onCreate={vi.fn(async (name) => details({ name }))}
        onImportFolder={onImportFolder}
        onSelect={onSelect}
      />,
    );

    expect(screen.getByRole("button", { name: "新建珍藏" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "导入文件夹为珍藏" }));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith("folder-collection"));
  });

  it("calls rename, add, remove, and complete reorder APIs from collection details", async () => {
    const onRename = vi.fn(async (_id: string, name: string) => details({ name }));
    const onAddBooks = vi.fn(async () => details());
    const onRemoveBooks = vi.fn(async () => details({ books: threeBooks.slice(1) }));
    const onReorder = vi.fn(async (_id: string, ids: string[]) =>
      details({ books: ids.map((id) => threeBooks.find((item) => item.id === id)!) }));
    render(
      <CollectionDetailPage
        collectionId="collection-1"
        libraryBooks={[...threeBooks, book("book-4", "卷外")]}
        busy={false}
        onGet={vi.fn(async () => details())}
        onRename={onRename}
        onDelete={vi.fn(async () => undefined)}
        onAddBooks={onAddBooks}
        onRemoveBooks={onRemoveBooks}
        onReorder={onReorder}
        onOpen={vi.fn()}
        onBack={vi.fn()}
        onDeleted={vi.fn()}
        onChanged={vi.fn(async () => undefined)}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "重命名" }));
    fireEvent.change(screen.getByLabelText("珍藏名称"), { target: { value: "新夜航" } });
    fireEvent.click(screen.getByRole("button", { name: "保存名称" }));
    await waitFor(() => expect(onRename).toHaveBeenCalledWith("collection-1", "新夜航"));

    fireEvent.click(screen.getByRole("button", { name: "添加书籍" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "卷外" }));
    fireEvent.click(screen.getByRole("button", { name: "加入所选书籍" }));
    await waitFor(() => expect(onAddBooks).toHaveBeenCalledWith("collection-1", ["book-4"]));

    fireEvent.click(screen.getByRole("button", { name: "下移《卷一》" }));
    await waitFor(() => expect(onReorder).toHaveBeenCalledWith(
      "collection-1",
      ["book-2", "book-1", "book-3"],
    ));

    fireEvent.click(screen.getByRole("button", { name: "从珍藏移除《卷一》" }));
    await waitFor(() => expect(onRemoveBooks).toHaveBeenCalledWith("collection-1", ["book-1"]));
  });

  it("searches the whole library for additions and removes mistaken members in a batch", async () => {
    const first = book("first", "夜航 第1卷");
    const second = book("second", "夜航 第2卷");
    const third = book("third", "夜航 第3卷");
    const unrelated = book("other", "另一系列 第一卷");
    const onAddBooks = vi.fn(async () => details({ books: [first, second] }));
    const onRemoveBooks = vi.fn(async () => details({ books: [] }));
    render(<CollectionDetailPage
      collectionId="collection-1"
      libraryBooks={[first, second, third, unrelated]}
      busy={false}
      onGet={vi.fn(async () => details({ books: [first, second] }))}
      onRename={vi.fn()}
      onDelete={vi.fn()}
      onAddBooks={onAddBooks}
      onRemoveBooks={onRemoveBooks}
      onReorder={vi.fn()}
      onOpen={vi.fn()}
      onBack={vi.fn()}
      onDeleted={vi.fn()}
      onChanged={vi.fn(async () => undefined)}
    />);

    fireEvent.click(await screen.findByRole("button", { name: "添加书籍" }));
    expect(screen.getByRole("checkbox", { name: "夜航 第3卷" })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "另一系列 第一卷" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索可添加书籍" }), { target: { value: "另一系列" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "另一系列 第一卷" }));
    fireEvent.click(screen.getByRole("button", { name: "加入所选书籍" }));
    await waitFor(() => expect(onAddBooks).toHaveBeenCalledWith("collection-1", ["other"]));

    fireEvent.click(screen.getByRole("button", { name: "管理珍藏书籍" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "选择《夜航 第1卷》" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "选择《夜航 第2卷》" }));
    fireEvent.click(screen.getByRole("button", { name: "从珍藏移出所选" }));
    await waitFor(() => expect(onRemoveBooks).toHaveBeenCalledWith("collection-1", ["first", "second"]));
  });

  it("appends a folder directly to the open collection and refreshes its books", async () => {
    const before = details({ books: threeBooks.slice(0, 1) });
    const after = details({ books: threeBooks.slice(0, 2) });
    const onGet = vi.fn(async () => before);
    onGet.mockResolvedValueOnce(before).mockResolvedValue(after);
    const onImportFolder = vi.fn(async () => ({
      status: "completed" as const,
      folderName: "新卷",
      collection: summary({ bookCount: 2 }),
      items: [],
      ignoredEntries: 0,
    }));
    render(<CollectionDetailPage
      collectionId="collection-1"
      libraryBooks={threeBooks}
      busy={false}
      onGet={onGet}
      onRename={vi.fn()}
      onDelete={vi.fn()}
      onAddBooks={vi.fn()}
      onRemoveBooks={vi.fn()}
      onReorder={vi.fn()}
      onImportFolder={onImportFolder}
      onOpen={vi.fn()}
      onBack={vi.fn()}
      onDeleted={vi.fn()}
      onChanged={vi.fn(async () => undefined)}
    />);

    fireEvent.click(await screen.findByRole("button", { name: "追加导入文件夹" }));

    await waitFor(() => expect(onImportFolder).toHaveBeenCalledWith("collection-1"));
    await waitFor(() => expect(onGet).toHaveBeenCalledTimes(2));
  });

  it("offers direct selected-file import inside a collection", async () => {
    const onImportFiles = vi.fn(async () => ({ status: "cancelled" as const }));
    render(<CollectionDetailPage
      collectionId="collection-1"
      libraryBooks={threeBooks}
      busy={false}
      onGet={vi.fn(async () => details())}
      onRename={vi.fn()}
      onDelete={vi.fn()}
      onAddBooks={vi.fn()}
      onRemoveBooks={vi.fn()}
      onReorder={vi.fn()}
      onImportFiles={onImportFiles}
      onOpen={vi.fn()}
      onBack={vi.fn()}
      onDeleted={vi.fn()}
      onChanged={vi.fn(async () => undefined)}
    />);

    fireEvent.click(await screen.findByRole("button", { name: "追加书籍文件" }));
    await waitFor(() => expect(onImportFiles).toHaveBeenCalledWith("collection-1"));
  });

  it("keeps a large collection responsive without a redundant search box", async () => {
    const books = Array.from({ length: 1200 }, (_, index) => book(`bulk-${index}`, `书籍 ${index}`));
    render(<CollectionDetailPage
      collectionId="collection-1"
      libraryBooks={books}
      busy={false}
      onGet={vi.fn(async () => details({ books }))}
      onRename={vi.fn()}
      onDelete={vi.fn()}
      onAddBooks={vi.fn()}
      onRemoveBooks={vi.fn()}
      onReorder={vi.fn()}
      onOpen={vi.fn()}
      onBack={vi.fn()}
      onDeleted={vi.fn()}
      onChanged={vi.fn(async () => undefined)}
    />);

    const list = await screen.findByRole("list", { name: "珍藏书籍" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(80);
    expect(screen.queryByRole("searchbox", { name: "在珍藏中搜索" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "继续加载珍藏书籍" }));
    expect(within(list).getAllByRole("listitem")).toHaveLength(160);
  });

  it("hydrates an open collection with a cover prepared after the detail snapshot loaded", async () => {
    const queued = {
      ...book("book-cover", "星海封面卷"),
      preparationStatus: "queued" as const,
    };
    const prepared = {
      ...queued,
      preparationStatus: "ready" as const,
      coverUrl: "reader-resource://publication/book-cover/revision-cover/cover",
    };
    const onGet = vi.fn(async () => details({ books: [queued] }));
    const sharedProps = {
      collectionId: "collection-1",
      busy: false,
      onGet,
      onRename: vi.fn(),
      onDelete: vi.fn(),
      onAddBooks: vi.fn(),
      onRemoveBooks: vi.fn(),
      onReorder: vi.fn(),
      onOpen: vi.fn(),
      onBack: vi.fn(),
      onDeleted: vi.fn(),
      onChanged: vi.fn(async () => undefined),
    };
    const { rerender } = render(
      <CollectionDetailPage {...sharedProps} libraryBooks={[queued]} />,
    );

    expect(await screen.findByRole("heading", { name: "星海封面卷" }))
      .toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "《星海封面卷》封面" }))
      .not.toBeInTheDocument();

    rerender(<CollectionDetailPage {...sharedProps} libraryBooks={[prepared]} />);

    expect(await screen.findByRole("img", { name: "《星海封面卷》封面" }))
      .toHaveAttribute("src", prepared.coverUrl);
    expect(onGet).toHaveBeenCalledTimes(1);
  });

  it("confirms collection deletion without implying books or source files are deleted", async () => {
    const onDelete = vi.fn(async () => undefined);
    render(
      <CollectionDetailPage
        collectionId="collection-1"
        libraryBooks={threeBooks}
        busy={false}
        onGet={vi.fn(async () => details())}
        onRename={vi.fn()}
        onDelete={onDelete}
        onAddBooks={vi.fn()}
        onRemoveBooks={vi.fn()}
        onReorder={vi.fn()}
        onOpen={vi.fn()}
        onBack={vi.fn()}
        onDeleted={vi.fn()}
        onChanged={vi.fn(async () => undefined)}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "删除珍藏" }));
    const dialog = screen.getByRole("dialog", { name: "确认删除珍藏" });
    expect(within(dialog).getByText("书籍与原文件不会删除")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith("collection-1"));
  });

  it("contains no production series placeholder route", async () => {
    const appSource = await readFile("src/renderer/src/app/App.tsx", "utf8");
    expect(appSource).not.toMatch(/SeriesBrowser|SeriesDetail|加载中\.\.\./);
  });
});
