import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LibraryAdmissionService } from "../../src/backend/library/library-admission-service.js";
import { LibraryImportService } from "../../src/backend/library/library-import-service.js";
import { openDatabase, type OpenedDatabase } from "../../src/backend/storage/database.js";

const cleanup: string[] = [];
const openedDatabases: OpenedDatabase[] = [];

afterEach(async () => {
  openedDatabases.splice(0).forEach((opened) => opened.close());
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "reader-batch-import-"));
  cleanup.push(root);
  const opened = openDatabase(root);
  openedDatabases.push(opened);
  const admission = new LibraryAdmissionService(opened.db);
  return {
    root,
    admission,
    importer: new LibraryImportService({
      admission,
      preparations: { notifyQueued: vi.fn() },
      textIndexer: { enqueue: vi.fn() },
    }),
  };
}

describe("LibraryImportService", () => {
  it("accepts a selection larger than 2000 files and reports final progress", async () => {
    const imported = {
      id: "one-book", title: "同一本", author: null, format: "txt" as const,
      availabilityStatus: "available" as const, progress: 0,
      addedAt: "2026-07-29T00:00:00.000Z", lastReadAt: null,
      updatedAt: "2026-07-29T00:00:00.000Z", coverUrl: null,
    };
    const progress = vi.fn();
    const service = new LibraryImportService({
      admission: { admitTxt: vi.fn(async () => imported), admitEpub: vi.fn() } as never,
      preparations: { notifyQueued: vi.fn() },
      textIndexer: { enqueue: vi.fn() },
    });
    const files = Array.from({ length: 2201 }, (_, i) => ({
      path: `E:\\books\\book-${i}.txt`, format: "txt" as const,
    }));

    const items = await service.importMixedFiles(files, progress);

    expect(items).toHaveLength(2201);
    expect(progress).toHaveBeenLastCalledWith({
      processed: 2201, total: 2201, fileName: "book-2200.txt",
    });
  });
  it("imports mixed formats with one known-book set and reports path-free progress", async () => {
    const imported = [
      {
        id: "txt-book",
        title: "TXT",
        author: null,
        format: "txt" as const,
        availabilityStatus: "available" as const,
        progress: 0,
        addedAt: "2026-07-29T00:00:00.000Z",
        lastReadAt: null,
        updatedAt: "2026-07-29T00:00:00.000Z",
        coverUrl: null,
      },
      {
        id: "epub-book",
        title: "EPUB",
        author: null,
        format: "epub" as const,
        availabilityStatus: "available" as const,
        progress: 0,
        addedAt: "2026-07-29T00:00:00.000Z",
        lastReadAt: null,
        updatedAt: "2026-07-29T00:00:00.000Z",
        coverUrl: null,
      },
    ];
    const admission = {
      admitTxt: vi.fn(async () => imported[0]),
      admitEpub: vi.fn(async () => imported[1]),
    };
    const preparations = { notifyQueued: vi.fn() };
    const progress = vi.fn();
    const service = new LibraryImportService({
      admission: admission as never,
      preparations,
      textIndexer: { enqueue: vi.fn() },
    } as never);

    const items = await service.importMixedFiles([
      { path: "E:\\private\\第2卷.txt", format: "txt" },
      { path: "E:\\private\\第10卷.epub", format: "epub" },
    ], progress);

    expect(items.map(({ status }) => status)).toEqual(["imported", "imported"]);
    expect(items.map(({ fileName }) => fileName)).toEqual(["第2卷.txt", "第10卷.epub"]);
    expect(JSON.stringify(items)).not.toContain("E:\\private");
    expect(progress).toHaveBeenNthCalledWith(1, {
      processed: 1,
      total: 2,
      fileName: "第2卷.txt",
    });
    expect(progress).toHaveBeenNthCalledWith(2, {
      processed: 2,
      total: 2,
      fileName: "第10卷.epub",
    });
    expect(preparations.notifyQueued).toHaveBeenCalledTimes(1);
  });

  it("continues after a per-file failure and preserves input order", async () => {
    const { root, importer } = await setup();
    const first = join(root, "first.txt");
    const invalid = join(root, "invalid.txt");
    const second = join(root, "second.txt");
    await writeFile(first, "第一本\n\n# 第一章\n正文", "utf8");
    await writeFile(invalid, Buffer.from([0, 1, 0, 2, 0, 3, 0, 4]));
    await writeFile(second, "第二本\n\n# 第一章\n正文", "utf8");

    const result = await importer.importFiles([first, invalid, second], "txt");

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("Expected completed import");
    expect(result.items.map((item) => item.status)).toEqual([
      "imported",
      "failed",
      "imported",
    ]);
    expect(result.items.map((item) => item.fileName)).toEqual([
      "first.txt",
      "invalid.txt",
      "second.txt",
    ]);
  });

  it("reports identical content as duplicate without waiting for an indexer", async () => {
    const { root, importer } = await setup();
    const first = join(root, "one.txt");
    const duplicate = join(root, "same-content.txt");
    await writeFile(first, "同一本书\n\n正文", "utf8");
    await writeFile(duplicate, await readFile(first));

    const result = await importer.importFiles([first, duplicate], "txt");

    if (result.status !== "completed") throw new Error("Expected completed import");
    expect(result.items.map((item) => item.status)).toEqual(["imported", "duplicate"]);
  });

  it("reports an already catalogued file as existing on a later import", async () => {
    const { root, importer } = await setup();
    const file = join(root, "again.txt");
    await writeFile(file, "重复导入的书\n\n正文", "utf8");

    const first = await importer.importFiles([file], "txt");
    const second = await importer.importFiles([file], "txt");

    if (first.status !== "completed" || second.status !== "completed") {
      throw new Error("expected completed imports");
    }
    expect(first.items[0]?.status).toBe("imported");
    expect(second.items[0]?.status).toBe("duplicate");
  });

  it("reports an extension mismatch without opening the file", async () => {
    const { root, importer } = await setup();
    const epub = join(root, "wrong.epub");
    await writeFile(epub, "not an epub", "utf8");

    const result = await importer.importFiles([epub], "txt");

    if (result.status !== "completed") throw new Error("Expected completed import");
    expect(result.items).toEqual([{
      status: "unsupported",
      fileName: "wrong.epub",
      errorCode: "FORMAT_NOT_SUPPORTED",
    }]);
  });

  it("rejects batches larger than the desktop dialog safety cap", async () => {
    const { importer } = await setup();
    await expect(
      importer.importFiles(
        Array.from({ length: 501 }, (_, index) => `book-${index}.txt`),
        "txt",
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
});
