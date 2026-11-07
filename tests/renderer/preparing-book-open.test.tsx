// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DefaultReaderShortcutProfile,
  DefaultReadingAppearance,
  type EpubBookDetails,
  type EpubBookSummary,
  type PublicPreparationEvent,
  type ReaderApi,
} from "../../src/shared/contracts.js";
import { createScanApiStub } from "./scan-api-stub.js";

vi.mock("../../src/renderer/src/features/reader/ReaderView.js", async () => {
  const React = await import("react");
  return {
    ReaderView: ({ details, onReady }: {
      details: EpubBookDetails;
      onReady?(): void;
    }) => {
      React.useEffect(() => onReady?.(), [onReady]);
      return React.createElement(
        "div",
        { "data-testid": "mock-reader" },
        `Reader opened: ${details.book.title}`,
      );
    },
  };
});

vi.mock("../../src/renderer/src/renditions/EpubRunnerPrewarm.js", () => ({
  EpubRunnerPrewarm: () => null,
}));

import { App } from "../../src/renderer/src/app/App.js";

const queuedBook: EpubBookSummary = {
  id: "book-queued",
  title: "Aether Gate",
  author: null,
  format: "epub",
  availabilityStatus: "available",
  progress: 0,
  addedAt: "2026-07-29T00:00:00.000Z",
  lastReadAt: null,
  updatedAt: "2026-07-29T00:00:00.000Z",
  coverUrl: null,
  preparationStatus: "queued",
  preparationErrorCode: null,
};

const otherBook: EpubBookSummary = {
  ...queuedBook,
  id: "book-other",
  title: "Other Gate",
};

const details: EpubBookDetails = {
  book: { ...queuedBook, preparationStatus: "ready" },
  sourceRevision: "revision-queued",
  publication: {
    bookId: queuedBook.id,
    sourceRevision: "revision-queued",
    metadata: { title: queuedBook.title, author: null, language: null },
    toc: [],
    spine: [{ index: 0, href: "chapter.xhtml", linear: true }],
  },
  savedLocation: null,
  sessionId: "session-queued",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createApi(
  books: EpubBookSummary[],
  open: ReaderApi["reader"]["open"],
) {
  let preparationListener: ((event: PublicPreparationEvent) => void) | null = null;
  const api: ReaderApi = {
    app: { getInfo: vi.fn(async () => ({ name: "Aetherbound", version: "0.4.1", platform: "win32" })) },
    library: {
      list: vi.fn(async () => books),
      importTxt: vi.fn(),
      importEpub: vi.fn(),
      importFiles: vi.fn(async () => ({ status: "cancelled" as const })),
      onImportProgress: vi.fn(() => () => undefined),
      remove: vi.fn(async () => ({ removed: 0 })),
      retryPreparation: vi.fn(async () => undefined),
      onPreparationChanged: vi.fn((listener) => {
        preparationListener = listener;
        return () => undefined;
      }),
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
      open,
      getEpubBinary: vi.fn(async (bookId, sourceRevision) => ({
        bookId,
        sourceRevision,
        mediaType: "application/epub+zip" as const,
        bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
      })),
      canResume: vi.fn(async () => false),
      getChapter: vi.fn(),
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
  return {
    api,
    emit: (event: PublicPreparationEvent) => preparationListener?.(event),
  };
}

afterEach(cleanup);

describe("opening a book during background preparation", () => {
  it("keeps the tile enabled, shows a non-blocking gate, and performs one automatic open", async () => {
    const opening = deferred<EpubBookDetails>();
    const open = vi.fn(() => opening.promise);
    const fixture = createApi([queuedBook], open);
    render(<App api={fixture.api} />);

    expect(await screen.findByText("准备中")).toBeInTheDocument();
    const tile = screen.getByRole("button", { name: "打开《Aether Gate》" });
    expect(tile).toBeEnabled();
    fireEvent.click(tile);
    fireEvent.click(tile);

    expect(await screen.findByRole("heading", { name: "正在准备本书" }))
      .toBeInTheDocument();
    expect(open).toHaveBeenCalledTimes(1);
    const booksNav = screen.getByRole("button", { name: /全部书籍/ });
    fireEvent.click(booksNav);
    expect(booksNav).toHaveAttribute("aria-current", "page");

    opening.resolve(details);
    expect(await screen.findByTestId("mock-reader")).toHaveTextContent(
      "Reader opened: Aether Gate",
    );
  });

  it("updates only the matching tile from preparation events", async () => {
    const fixture = createApi(
      [queuedBook, otherBook],
      vi.fn(async () => details),
    );
    render(<App api={fixture.api} />);
    await screen.findAllByText("准备中");

    fixture.emit({
      bookId: queuedBook.id,
      sourceRevision: "revision-queued",
      state: "ready",
      errorCode: null,
    });

    await waitFor(() => expect(screen.getAllByText("准备中")).toHaveLength(1));
    expect(screen.getByRole("button", { name: "打开《Other Gate》" }))
      .toBeInTheDocument();
  });

  it("returns to the library after failure and exposes explicit retry", async () => {
    const open = vi.fn()
      .mockRejectedValueOnce(new Error("preparation failed"))
      .mockResolvedValueOnce(details);
    const fixture = createApi([queuedBook], open);
    render(<App api={fixture.api} />);
    fireEvent.click(await screen.findByRole("button", { name: /全部书籍/ }));
    fireEvent.click(await screen.findByRole("button", { name: "打开《Aether Gate》" }));
    await screen.findByRole("alert");
    fixture.emit({
      bookId: queuedBook.id,
      sourceRevision: "revision-queued",
      state: "error",
      errorCode: "INVALID_PACKAGE",
    });

    const retry = await screen.findByRole("button", {
      name: "重试准备《Aether Gate》",
    });
    expect(screen.getByText("准备失败 · 点击重试")).toBeInTheDocument();
    fireEvent.click(retry);

    await waitFor(() =>
      expect(fixture.api.library.retryPreparation).toHaveBeenCalledWith(
        queuedBook.id,
      ));
    expect(await screen.findByTestId("mock-reader")).toBeInTheDocument();
  });
});
