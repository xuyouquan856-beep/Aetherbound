// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createReaderApi } from "../../src/preload/index.js";
import {
  DefaultReaderShortcutProfile,
  DefaultReadingAppearance,
} from "../../src/shared/contracts.js";
import { channels } from "../../src/shared/ipc.js";

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
}));

describe("reader settings preload", () => {
  it("uses named shortcut channels without exposing generic IPC", async () => {
    const invoke = vi.fn(async () => DefaultReaderShortcutProfile);
    const api = createReaderApi({
      invoke,
      on: vi.fn(),
      removeListener: vi.fn(),
    });

    await api.settings.getShortcuts();
    await api.settings.updateShortcuts(DefaultReaderShortcutProfile);

    expect(invoke).toHaveBeenNthCalledWith(1, channels.settingsShortcutsGet);
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      channels.settingsShortcutsUpdate,
      DefaultReaderShortcutProfile,
    );
  });

  it("validates a retained reader through one controlled channel", async () => {
    const invoke = vi.fn(async () => true);
    const api = createReaderApi({
      invoke,
      on: vi.fn(),
      removeListener: vi.fn(),
    });

    await expect(api.reader.canResume("book-1", "revision-1")).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith(channels.readerCanResume, {
      bookId: "book-1",
      sourceRevision: "revision-1",
    });
  });

  it("passes the complete persisted reading appearance through named channels", async () => {
    const appearance = {
      ...DefaultReadingAppearance,
      epubFlow: "scrolled" as const,
      epubColumns: "single" as const,
      paragraphSpacing: 0.6,
      firstLineIndent: "none" as const,
      letterSpacing: 0.04,
    };
    const invoke = vi.fn(async () => appearance);
    const api = createReaderApi({
      invoke,
      on: vi.fn(),
      removeListener: vi.fn(),
    });

    await expect(api.settings.getAppearance()).resolves.toEqual(appearance);
    await expect(api.settings.updateAppearance(appearance)).resolves.toEqual(appearance);
    expect(invoke).toHaveBeenNthCalledWith(1, channels.settingsGet);
    expect(invoke).toHaveBeenNthCalledWith(2, channels.settingsUpdate, appearance);
  });
});
