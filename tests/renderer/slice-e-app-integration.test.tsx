// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "../../src/renderer/src/app/App.js";
import {
  DefaultReaderShortcutProfile,
  DefaultReadingAppearance,
  type ReaderApi,
} from "../../src/shared/contracts.js";
import { createScanApiStub } from "./scan-api-stub.js";

afterEach(() => cleanup());

// ---- test helpers ----
function createApi(overrides: Partial<ReaderApi> = {}): ReaderApi {
  return {
    app: { getInfo: vi.fn(async () => ({ name: "Aetherbound", version: "1.0" })) },
    library: {
      list: vi.fn(async () => []),
      importTxt: vi.fn(async () => ({ id: "", format: "txt" as const, title: "", author: null, sourceFile: "", sourceRevision: "", addedAt: "" })),
      importEpub: vi.fn(async () => ({ id: "", format: "epub" as const, title: "", author: null, filePath: "", coverUrl: null, mimeType: "application/epub+zip", sourceRevision: "", addedAt: "" })),
      importFiles: vi.fn(async () => ({ status: "cancelled" as const })),
      onImportProgress: vi.fn(() => () => undefined),
      remove: vi.fn(async () => true),
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
      open: vi.fn(async () => ({ sessionId: "", bookId: "", title: "", author: null, format: "txt", spine: [], location: null, appearance: {} as any })),
      canResume: vi.fn(async () => true),
      getChapter: vi.fn(async () => ({ id: "", chapterId: "", bookId: "", chunkCount: 1, title: null, content: "" })),
      saveProgress: vi.fn(async () => undefined),
      closeSession: vi.fn(async () => undefined),
    },
    settings: {
      getAppearance: vi.fn(async () => DefaultReadingAppearance),
      updateAppearance: vi.fn(async (v) => v),
      getShortcuts: vi.fn(async () => DefaultReaderShortcutProfile),
      updateShortcuts: vi.fn(async (v) => v),
    },
    search: { fulltext: vi.fn(async () => []) },
    scan: createScanApiStub(),
    ...overrides,
  } as ReaderApi;
}

// ---- App integration tests ----
describe("Slice E App integration", () => {
  it("loads the persisted reader shortcuts during startup", async () => {
    const api = createApi();
    render(<App api={api} />);
    await waitFor(() => expect(api.settings.getShortcuts).toHaveBeenCalledOnce());
  });

  it("does not expose fulltext search in the library sidebar or command bar", async () => {
    const api = createApi();
    render(<App api={api} />);
    await waitFor(() => { expect(screen.queryByText(/加载中/)).toBeNull(); });
    expect(screen.queryByRole("button", { name: /正文检索/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /全部书籍/ }));
    expect(screen.queryByRole("button", { name: /进入全文搜索/ })).toBeNull();
  });

  it("does not show or query the disconnected in-app trash page", async () => {
    const api = createApi();
    const readTrash = vi.fn();
    Object.defineProperty(api, "trash", { get: readTrash });
    render(<App api={api} />);
    await waitFor(() => { expect(screen.queryByText(/加载中/)).toBeNull(); });
    expect(readTrash).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /回收站/ })).toBeNull();
  });
});
