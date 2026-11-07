import { describe, expect, it, vi } from "vitest";
import { createReaderApi } from "../../src/preload/index.js";
import { channels } from "../../src/shared/ipc.js";

describe("EPUB binary preload capability", () => {
  it("invokes one named channel with opaque identity only", async () => {
    const invoke = vi.fn(async () => ({
      bookId: "book-1",
      sourceRevision: "rev-1",
      mediaType: "application/epub+zip",
      bytes: new Uint8Array([1, 2, 3]),
    }));
    const api = createReaderApi({
      invoke,
      on: vi.fn(),
      removeListener: vi.fn(),
    } as never);

    await expect(api.reader.getEpubBinary("book-1", "rev-1")).resolves
      .toMatchObject({ bytes: new Uint8Array([1, 2, 3]) });
    expect(invoke).toHaveBeenCalledWith(channels.readerEpubBinary, {
      bookId: "book-1",
      sourceRevision: "rev-1",
    });
  });
});
