import { describe, expect, it, vi } from "vitest";
import type { IpcRenderer } from "electron";
import { createReaderApi } from "../../src/preload/index.js";
import { channels } from "../../src/shared/ipc.js";

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
}));

describe("reading records preload", () => {
  it("forwards list, save, and remove over dedicated IPC channels", async () => {
    const invoke = vi.fn(async () => undefined);
    const api = createReaderApi({ invoke, on: vi.fn(), removeListener: vi.fn() } as unknown as Pick<IpcRenderer, "invoke" | "on" | "removeListener">);
    const input = { kind: "quote" as const, bookId: null, bookTitle: "Lost", author: null,
      text: "text", note: "", color: "cyan" as const, location: null, enabled: true, pinned: false };
    await api.records!.list({ kind: "quote" });
    await api.records!.save(input);
    await api.records!.remove({ id: "00000000-0000-4000-8000-000000000000" });
    expect(invoke.mock.calls).toEqual([
      [channels.readerRecordsList, { kind: "quote" }],
      [channels.readerRecordsSave, input],
      [channels.readerRecordsRemove, { id: "00000000-0000-4000-8000-000000000000" }],
    ]);
  });
});
