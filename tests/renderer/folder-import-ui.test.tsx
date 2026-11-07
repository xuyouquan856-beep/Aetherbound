// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/renderer/src/app/App.js";
import {
  DefaultReaderShortcutProfile,
  DefaultReadingAppearance,
  type BookSummary,
  type FolderCollectionImportProgress,
  type FolderCollectionImportResult,
  type ReaderApi,
} from "../../src/shared/contracts.js";
import { createScanApiStub } from "./scan-api-stub.js";

function book(id: string, title: string): BookSummary {
  return {
    id,
    title,
    author: null,
    format: "epub",
    coverUrl: null,
    availabilityStatus: "available",
    progress: 0,
    addedAt: "2026-07-29T00:00:00.000Z",
    lastReadAt: null,
    updatedAt: "2026-07-29T00:00:00.000Z",
  };
}

function createApi(
  importFolder: () => Promise<FolderCollectionImportResult>,
  onProgress = vi.fn((_listener: (value: FolderCollectionImportProgress) => void) => () => undefined),
): ReaderApi {
  return {
    app: { getInfo: vi.fn() },
    library: {
      list: vi.fn(async () => [book("book-1", "长夜")]),
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
      get: vi.fn(async (id) => ({
        id,
        name: "星海",
        books: [book("book-1", "长夜")],
        createdAt: "2026-07-29T00:00:00.000Z",
        updatedAt: "2026-07-29T00:00:00.000Z",
      })),
      create: vi.fn(),
      rename: vi.fn(),
      delete: vi.fn(),
      addBooks: vi.fn(),
      removeBooks: vi.fn(),
      reorder: vi.fn(),
      getMemberships: vi.fn(async () => []),
      listUnorganized: vi.fn(async () => []),
      importFolder: vi.fn(importFolder),
      onFolderImportProgress: onProgress,
    },
    reader: {},
    settings: {
      getAppearance: vi.fn(async () => DefaultReadingAppearance),
      updateAppearance: vi.fn(),
      getShortcuts: vi.fn(async () => DefaultReaderShortcutProfile),
      updateShortcuts: vi.fn(),
    },
    search: { fulltext: vi.fn(async () => []) },
    scan: createScanApiStub(),
  } as unknown as ReaderApi;
}

function openFolderImport() {
  fireEvent.click(screen.getByRole("button", { name: "导入" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "导入文件夹为珍藏" }));
}

afterEach(cleanup);

describe("folder collection import UI", () => {
  it("adds folder import to the menu and cancellation changes nothing", async () => {
    const api = createApi(async () => ({ status: "cancelled" }));
    render(<App api={api} />);

    await screen.findByRole("button", { name: "导入" });
    openFolderImport();
    await waitFor(() => expect(api.collections.importFolder).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("status", { name: "文件夹导入结果" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "书房" })).toHaveAttribute("aria-current", "page");
  });

  it("describes empty folders without creating a fake collection", async () => {
    render(<App api={createApi(async () => ({ status: "empty", folderName: "空书单" }))} />);
    await screen.findByRole("button", { name: "导入" });
    openFolderImport();

    expect(await screen.findByText("文件夹中没有可导入的 EPUB 或 TXT")).toBeInTheDocument();
  });

  it("summarizes automatic subfolder grouping and root-level books", async () => {
    const api = createApi(async () => ({ status: "cancelled" }));
    api.collections.importOrganizedFolder = vi.fn(async () => ({
      status: "organized" as const,
      folderName: "总书库",
      collections: [{ id: "scifi", name: "科幻", bookCount: 2, previewBooks: [], updatedAt: "2026-07-29" }],
      rootFiles: 1,
      items: [
        { status: "imported" as const, fileName: "a.txt", book: book("a", "A") },
        { status: "imported" as const, fileName: "b.txt", book: book("b", "B") },
        { status: "imported" as const, fileName: "c.txt", book: book("c", "C") },
      ],
      ignoredEntries: 0,
    }));
    render(<App api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "导入" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "按子文件夹整理导入" }));

    expect(await screen.findByRole("status", { name: "文件夹导入结果" })).toHaveTextContent("1 个珍藏");
    expect(screen.getByRole("status", { name: "文件夹导入结果" })).toHaveTextContent("根目录 1 本未自动归类");
  });

  it("summarizes only public item statuses, hides paths, and opens the returned collection", async () => {
    const result: FolderCollectionImportResult = {
      status: "completed",
      folderName: "星海",
      collection: {
        id: "collection-folder",
        name: "星海",
        bookCount: 2,
        previewBooks: [],
        updatedAt: "2026-07-29T00:00:00.000Z",
      },
      items: [
        { status: "imported", fileName: "卷一.epub", book: book("book-1", "卷一") },
        { status: "duplicate", fileName: "卷二.epub", book: book("book-2", "卷二") },
        {
          status: "failed",
          fileName: "损坏.epub",
          errorCode: "INVALID_PACKAGE",
          message: "E:\\private\\损坏.epub cannot be opened",
        },
        { status: "unsupported", fileName: "说明.pdf", errorCode: "FORMAT_NOT_SUPPORTED" },
      ],
      ignoredEntries: 2,
    };
    render(<App api={createApi(async () => result)} />);
    await screen.findByRole("button", { name: "导入" });
    openFolderImport();

    expect(await screen.findByRole("heading", { name: "星海" })).toBeInTheDocument();
    const summary = screen.getByRole("status", { name: "文件夹导入结果" });
    expect(summary).toHaveTextContent("新加入 1");
    expect(summary).toHaveTextContent("已有 1");
    expect(summary).toHaveTextContent("忽略 2");
    expect(summary).toHaveTextContent("失败 2");
    expect(summary.textContent).not.toMatch(/[A-Z]:\\/i);
  });

  it("shows validated progress, keeps navigation usable, and unsubscribes on unmount", async () => {
    let progressListener!: (value: FolderCollectionImportProgress) => void;
    const unsubscribe = vi.fn();
    const onProgress = vi.fn((listener: (value: FolderCollectionImportProgress) => void) => {
      progressListener = listener;
      return unsubscribe;
    });
    let finish!: (result: FolderCollectionImportResult) => void;
    const api = createApi(
      () => new Promise<FolderCollectionImportResult>((resolve) => {
        finish = resolve;
      }),
      onProgress,
    );
    const view = render(<App api={api} />);
    await screen.findByRole("button", { name: "导入" });
    openFolderImport();

    progressListener({ processed: 7, total: 12, fileName: "卷七.epub" });
    expect(await screen.findByText("正在导入 7 / 12")).toBeInTheDocument();
    expect(screen.getByText("卷七.epub")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导入" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "全部书籍" }));
    expect(screen.getByRole("button", { name: "全部书籍" })).toHaveAttribute("aria-current", "page");

    finish({ status: "cancelled" });
    await waitFor(() => expect(screen.getByRole("button", { name: "导入" })).not.toBeDisabled());
    view.unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
