import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PreparedEpubBinaryService,
} from "../../src/backend/library/prepared-epub-binary-service.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })));
});

describe("PreparedEpubBinaryService", () => {
  it("returns bytes for an opaque current identity without returning its path", async () => {
    const root = await mkdtemp(join(tmpdir(), "epub-binary-"));
    cleanup.push(root);
    const path = join(root, "book.epub");
    await writeFile(path, new Uint8Array([1, 2, 3, 4]));
    const resolve = vi.fn(() => path);
    const service = new PreparedEpubBinaryService(resolve, 16);

    const result = await service.read({
      bookId: "book-1",
      sourceRevision: "rev-1",
    });

    expect(resolve).toHaveBeenCalledWith("book-1", "rev-1");
    expect(result).toEqual({
      bookId: "book-1",
      sourceRevision: "rev-1",
      mediaType: "application/epub+zip",
      bytes: new Uint8Array([1, 2, 3, 4]),
    });
    expect(JSON.stringify(result)).not.toContain(root);
  });

  it("rejects stale, non-file and oversized resources before reading", async () => {
    const root = await mkdtemp(join(tmpdir(), "epub-binary-limit-"));
    cleanup.push(root);
    const path = join(root, "book.epub");
    const handle = await open(path, "w");
    await handle.truncate(17);
    await handle.close();

    await expect(new PreparedEpubBinaryService(() => null, 16).read({
      bookId: "book-1",
      sourceRevision: "stale",
    })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });

    await expect(new PreparedEpubBinaryService(() => root, 16).read({
      bookId: "book-1",
      sourceRevision: "rev-1",
    })).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });

    await expect(new PreparedEpubBinaryService(() => path, 16).read({
      bookId: "book-1",
      sourceRevision: "rev-1",
    })).rejects.toMatchObject({ code: "ARCHIVE_LIMIT" });
  });
});
