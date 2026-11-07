import { describe, expect, it, vi } from "vitest";
import type { IpcRenderer } from "electron";
import { createReaderApi } from "../../src/preload/index.js";
import { channels } from "../../src/shared/ipc.js";

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: {
    invoke: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}));

describe("custom collections preload runtime", () => {
  it("exposes named path-free collection invocations", async () => {
    const invoke = vi.fn(async () => undefined);
    const ipc = {
      invoke,
      on: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as Pick<IpcRenderer, "invoke" | "on" | "removeListener">;
    const api = createReaderApi(ipc);

    await api.collections.create("待读");
    await api.collections.addBooks("collection-1", ["book-1"]);
    await api.collections.getMemberships(["book-1"]);
    await api.collections.importFolder();
    await api.collections.importFolder("collection-1");

    expect(invoke).toHaveBeenNthCalledWith(1, channels.collectionsCreate, { name: "待读" });
    expect(invoke).toHaveBeenNthCalledWith(2, channels.collectionsAddBooks, {
      id: "collection-1",
      bookIds: ["book-1"],
    });
    expect(invoke).toHaveBeenNthCalledWith(3, channels.collectionsGetMemberships, {
      bookIds: ["book-1"],
    });
    expect(invoke).toHaveBeenNthCalledWith(4, channels.collectionsImportFolder);
    expect(invoke).toHaveBeenNthCalledWith(5, channels.collectionsImportFolder, { id: "collection-1" });
  });

  it("validates progress events and removes the exact subscription", () => {
    const on = vi.fn();
    const removeListener = vi.fn();
    const ipc = {
      invoke: vi.fn(),
      on,
      removeListener,
    } as unknown as Pick<IpcRenderer, "invoke" | "on" | "removeListener">;
    const listener = vi.fn();
    const dispose = createReaderApi(ipc).collections.onFolderImportProgress(listener);
    const handler = on.mock.calls[0][1] as (event: unknown, payload: unknown) => void;

    handler({}, { processed: 1, total: 2, fileName: "第1卷.epub" });
    handler({}, { processed: 3, total: 2, fileName: "E:\\secret.epub" });
    dispose();

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({
      processed: 1,
      total: 2,
      fileName: "第1卷.epub",
    });
    expect(removeListener).toHaveBeenCalledWith(
      channels.collectionsImportFolderProgress,
      handler,
    );
  });
});
