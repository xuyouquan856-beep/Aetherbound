import { beforeEach, describe, expect, it, vi } from "vitest";
import { channels } from "../../src/shared/ipc.js";

const handlers = vi.hoisted(() => new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>());
const openExternal = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("electron", () => ({
  app: { isPackaged: true, getVersion: () => "0.4.1" },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openExternal },
  ipcMain: { handle: (channel: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => handlers.set(channel, handler) },
}));

import { registerIpc } from "../../src/main/ipc/register-ipc.js";
import { createScanServicesStub } from "./scan-services-stub.js";

function trustedEvent() {
  const frame = { url: "reader-app://bundle/index.html" };
  return { senderFrame: frame, sender: { mainFrame: frame } };
}

beforeEach(() => handlers.clear());

describe("reading records IPC", () => {
  it("opens quote source links only from the trusted app and only over HTTP(S)", async () => {
    registerIpc({ preparations: { subscribe: vi.fn() }, scan: createScanServicesStub() } as never);
    const invoke = handlers.get("app:openExternalUrl");
    expect(invoke).toBeDefined();
    await invoke!(trustedEvent(), "https://example.org/source");
    expect(openExternal).toHaveBeenCalledWith("https://example.org/source");
    await expect(invoke!(trustedEvent(), "file:///C:/anything")).rejects.toThrow();
    expect(openExternal).toHaveBeenCalledTimes(1);
  });
  it("validates requests before dispatching and rejects untrusted frames", async () => {
    const list = vi.fn(() => []);
    const save = vi.fn((_input: unknown) => ({ id: "00000000-0000-4000-8000-000000000000", kind: "quote", bookId: null,
      bookTitle: "Lost", author: null, text: "text", note: "", color: "cyan", location: null,
      endLocation: null, enabled: true, pinned: false, createdAt: "now", updatedAt: "now" }));
    const remove = vi.fn();
    registerIpc({ preparations: { subscribe: vi.fn() }, scan: createScanServicesStub(), records: { list, save, remove } } as never);
    await handlers.get(channels.readerRecordsList)!(trustedEvent(), { kind: "quote" });
    expect(list).toHaveBeenCalledWith({ kind: "quote" });
    await expect(handlers.get(channels.readerRecordsSave)!(trustedEvent(), { kind: "unknown" })).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
    await handlers.get(channels.readerRecordsSave)!(trustedEvent(), {
      kind: "quote", bookId: null, bookTitle: "Book", author: null, text: "text", note: "edited", color: "cyan", location: null, enabled: true, pinned: false,
    });
    expect(save.mock.calls[0][0]).not.toHaveProperty("excerpt");
    expect(save.mock.calls[0][0]).not.toHaveProperty("sourceUrl");
    const event = trustedEvent();
    await expect(handlers.get(channels.readerRecordsRemove)!({ ...event, senderFrame: { url: "https://evil.example" } },
      { id: "00000000-0000-4000-8000-000000000000" })).rejects.toThrow();
    expect(remove).not.toHaveBeenCalled();
  });
});
