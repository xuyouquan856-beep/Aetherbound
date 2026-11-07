import { beforeEach, describe, expect, it, vi } from "vitest";
import { channels } from "../../src/shared/ipc.js";

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>(),
  showOpenDialog: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    isPackaged: true,
    getVersion: () => "0.4.1",
    getPath: () => "E:\\data",
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
  dialog: { showOpenDialog: electron.showOpenDialog },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      electron.handlers.set(channel, handler);
    }),
  },
}));

import { registerIpc } from "../../src/main/ipc/register-ipc.js";
import { createScanServicesStub } from "./scan-services-stub.js";

const details = {
  id: "collection-1",
  name: "待读",
  createdAt: "2026-07-29T00:00:00.000Z",
  updatedAt: "2026-07-29T00:00:00.000Z",
  books: [],
};

function trustedEvent() {
  const send = vi.fn();
  const mainFrame = { url: "reader-app://bundle/index.html" };
  return {
    event: {
      senderFrame: mainFrame,
      sender: { mainFrame, send },
    },
    send,
  };
}

function services() {
  return {
    collections: {
      list: vi.fn(async () => []),
      get: vi.fn(async () => details),
      create: vi.fn(async () => details),
      rename: vi.fn(async () => details),
      delete: vi.fn(),
      addBooks: vi.fn(async () => details),
      removeBooks: vi.fn(async () => details),
      reorder: vi.fn(async () => details),
      getMemberships: vi.fn(() => []),
      listUnorganized: vi.fn(async () => []),
    },
    folderCollectionImporter: {
      import: vi.fn(async (
        _path: string,
        onProgress: (value: { processed: number; total: number; fileName: string | null }) => void,
      ) => {
        onProgress({ processed: 1, total: 1, fileName: "第1卷.epub" });
        return { status: "empty" as const, folderName: "书籍" };
      }),
      importOrganized: vi.fn(async () => ({ status: "cancelled" as const })),
    },
    preparations: {
      subscribe: vi.fn(() => () => undefined),
      retry: vi.fn(async () => undefined),
      ensureReady: vi.fn(async () => undefined),
    },
    library: {},
    importer: {},
    progress: {},
    sessions: {},
    settings: {},
    textIndexer: {},
    trash: {},
    scan: createScanServicesStub(),
  };
}

describe("custom collection IPC", () => {
  beforeEach(() => {
    electron.handlers.clear();
    electron.showOpenDialog.mockReset();
  });

  it("registers strict collection handlers and rejects renderer paths", async () => {
    const wired = services();
    registerIpc(wired as never);
    const create = electron.handlers.get(channels.collectionsCreate)!;
    const { event } = trustedEvent();

    await expect(create(event, { name: "待读", path: "E:\\private" })).rejects.toThrow();
    expect(wired.collections.create).not.toHaveBeenCalled();

    await expect(create(event, { name: "待读" })).resolves.toEqual(details);
    expect(wired.collections.create).toHaveBeenCalledWith("待读");
  });

  it("uses openDirectory and emits only validated path-free progress", async () => {
    electron.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ["E:\\private\\书籍"],
    });
    const wired = services();
    registerIpc(wired as never);
    const importFolder = electron.handlers.get(channels.collectionsImportFolder)!;
    const { event, send } = trustedEvent();

    await expect(importFolder(event, undefined)).resolves.toEqual({
      status: "empty",
      folderName: "书籍",
    });
    expect(electron.showOpenDialog).toHaveBeenCalledWith({
      properties: ["openDirectory"],
    });
    expect(wired.folderCollectionImporter.import).toHaveBeenCalledWith(
      "E:\\private\\书籍",
      expect.any(Function),
      undefined,
    );
    expect(send).toHaveBeenCalledWith(channels.collectionsImportFolderProgress, {
      processed: 1,
      total: 1,
      fileName: "第1卷.epub",
    });
    expect(JSON.stringify(send.mock.calls)).not.toContain("E:\\private");
  });

  it("does not call the backend when folder selection is cancelled", async () => {
    electron.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    const wired = services();
    registerIpc(wired as never);
    const { event } = trustedEvent();

    await expect(
      electron.handlers.get(channels.collectionsImportFolder)!(event, undefined),
    ).resolves.toEqual({ status: "cancelled" });
    expect(wired.folderCollectionImporter.import).not.toHaveBeenCalled();
  });

  it("passes an existing collection destination to the folder importer", async () => {
    electron.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ["E:\\private\\续传"],
    });
    const wired = services();
    registerIpc(wired as never);
    const { event } = trustedEvent();

    await electron.handlers.get(channels.collectionsImportFolder)!(event, { id: "collection-1" });

    expect(wired.folderCollectionImporter.import).toHaveBeenCalledWith(
      "E:\\private\\续传",
      expect.any(Function),
      "collection-1",
    );
  });

  it("imports a mixed TXT and EPUB file selection through one picker", async () => {
    electron.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ["E:\\books\\one.txt", "E:\\books\\two.epub"],
    });
    const wired = services();
    const importMixedFiles = vi.fn(async (
      _files: unknown,
      progress: (value: { processed: number; total: number; fileName: string | null }) => void,
    ) => {
      progress({ processed: 2, total: 2, fileName: "two.epub" });
      return [];
    });
    wired.importer = { importMixedFiles };
    registerIpc(wired as never);
    const { event, send } = trustedEvent();

    await expect(electron.handlers.get(channels.libraryImportMixed)!(event, undefined))
      .resolves.toEqual({ status: "completed", items: [] });
    expect(importMixedFiles).toHaveBeenCalledWith([
      { path: "E:\\books\\one.txt", format: "txt" },
      { path: "E:\\books\\two.epub", format: "epub" },
    ], expect.any(Function));
    expect(send).toHaveBeenCalledWith(channels.libraryImportProgress, {
      processed: 2, total: 2, fileName: "two.epub",
    });
  });

  it("imports selected book files straight into an existing collection", async () => {
    electron.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ["E:\\books\\new.txt"],
    });
    const wired = services();
    wired.importer = { importMixedFiles: vi.fn(async () => [{
      status: "imported" as const,
      fileName: "new.txt",
      book: {
        id: "book-new", title: "新书", author: null, format: "txt" as const,
        availabilityStatus: "available" as const, progress: 0,
        addedAt: "2026-07-29T00:00:00.000Z", lastReadAt: null,
        updatedAt: "2026-07-29T00:00:00.000Z", coverUrl: null,
      },
    }]) };
    registerIpc(wired as never);
    const { event } = trustedEvent();

    await expect(electron.handlers.get(channels.collectionsImportFiles)!(event, { id: "collection-1" }))
      .resolves.toMatchObject({ status: "completed" });
    expect(wired.collections.addBooks).toHaveBeenCalledWith("collection-1", ["book-new"]);
  });

  it("offers a folder picker for automatic first-level collection grouping", async () => {
    electron.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ["E:\\books\\all"] });
    const wired = services();
    const importOrganized = vi.fn(async () => ({
      status: "organized" as const,
      folderName: "all",
      collections: [],
      rootFiles: 0,
      items: [],
      ignoredEntries: 0,
    }));
    wired.folderCollectionImporter.importOrganized = importOrganized as never;
    registerIpc(wired as never);
    const { event } = trustedEvent();

    await expect(electron.handlers.get(channels.collectionsImportOrganizedFolder)!(event, undefined))
      .resolves.toMatchObject({ status: "organized" });
    expect(importOrganized).toHaveBeenCalledWith("E:\\books\\all", expect.any(Function));
  });
});
