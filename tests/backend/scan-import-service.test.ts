import { describe, expect, it, vi } from "vitest";
import { ScanImportService } from "../../src/backend/library-scan/scan-import-service.js";
import type { ScanImportProgress } from "../../src/shared/contracts.js";
import type { ResolvedImportFile } from "../../src/backend/library-scan/scan-review-service.js";

/**
 * The import runner.
 *
 * Its job is to be bearable over a thousand files: report progress, stop when asked,
 * and count duplicates correctly even though the work happens in slices. That last one
 * is the subtle part — the underlying importer only notices that two files hold the
 * same book when it sees both, so counting per slice would report every copy in a
 * multi-file slice as a fresh import.
 */
function makeService(options: {
  files: ResolvedImportFile[];
  /** Book id the importer returns for a given file index, or "fail". */
  admitted?: (index: number) => string | "fail" | "unsupported";
  onSlice?: (index: number) => void;
}) {
  const files = options.files;
  const calls: string[][] = [];
  const progress: ScanImportProgress[] = [];
  const filed: string[][] = [];

  const importer = {
    importMixedFiles: vi.fn(async (slice: ReadonlyArray<{ path: string }>) => {
      calls.push(slice.map((file) => file.path));
      options.onSlice?.(calls.length - 1);
      return slice.map((file) => {
        const index = files.findIndex((candidate) => candidate.path === file.path);
        const admitted = options.admitted?.(index) ?? `book-${index}`;
        if (admitted === "fail") {
          return { status: "failed" as const, fileName: "x", errorCode: "INTERNAL_ERROR" as const, message: "boom" };
        }
        if (admitted === "unsupported") return { status: "unsupported" as const, fileName: "x", errorCode: "FORMAT_NOT_SUPPORTED" as const };
        return { status: "imported" as const, fileName: "x", book: { id: admitted } };
      });
    }),
  };

  const service = new ScanImportService({
    review: {
      requireActiveRoot: () => ({ id: "root-1", rootPath: "E:\\books", displayName: "books" }),
      resolveImportFiles: (_rootId, _rootPath, ids) =>
        ids === null ? files : files.filter((file) => ids.includes(file.inventoryId)),
      listUnimportedInventoryIds: () => files.map((file) => file.inventoryId),
      addBooksToCollection: vi.fn(async (collectionId: string, bookIds: readonly string[]) => {
        filed.push([collectionId, ...bookIds]);
        return bookIds.length;
      }),
    },
    importer,
    now: () => "2026-08-01T00:00:00.000Z",
  });
  service.subscribe((value) => progress.push(value));

  return { service, importer, calls, progress, filed };
}

function files(count: number): ResolvedImportFile[] {
  return Array.from({ length: count }, (_value, index) => ({
    inventoryId: `inv-${index}`,
    path: `E:\\books\\book-${index}.txt`,
    format: "txt" as const,
  }));
}

describe("ScanImportService", () => {
  it("reports progress as it goes instead of only at the end", async () => {
    const { service, progress } = makeService({ files: files(25) });

    const result = await service.start({ inventoryIds: null });

    expect(result.phase).toBe("completed");
    expect(result.imported).toBe(25);
    // One report per slice plus the final summary — the point is that the screen has
    // something to draw long before the run finishes.
    expect(progress.length).toBeGreaterThanOrEqual(3);
    expect(progress[0].phase).toBe("importing");
    expect(progress[0].total).toBe(25);
    const midway = progress.find((entry) => entry.phase === "importing" && entry.processed > 0);
    expect(midway?.processed).toBeLessThan(25);
    expect(progress.at(-1)?.phase).toBe("completed");
  });

  it("counts a repeated book as a duplicate even across slice boundaries", async () => {
    // Two files with identical content resolve to the same book. They land in different
    // slices when the slice size does not divide them evenly, which is exactly the case
    // a per-slice count gets wrong.
    const { service } = makeService({
      files: files(12),
      admitted: (index) => (index === 0 || index === 11 ? "book-same" : `book-${index}`),
    });

    const result = await service.start({ inventoryIds: null });

    expect(result.imported).toBe(11);
    expect(result.duplicates).toBe(1);
    expect(result.summary).toContain("内容重复");
  });

  it("keeps going when a slice fails outright", async () => {
    const { service, calls } = makeService({
      files: files(30),
      onSlice: (index) => {
        if (index === 0) throw new Error("disk went away");
      },
    });

    const result = await service.start({ inventoryIds: null });

    expect(result.phase).toBe("completed");
    expect(result.failed).toBeGreaterThanOrEqual(10);
    expect(result.imported).toBe(20);
    // The rest of the folder still got its chance.
    expect(calls.length).toBe(3);
  });

  it("stops between slices when asked, and keeps what is already in", async () => {
    let serviceRef: ScanImportService | null = null;
    const { service, progress } = makeService({
      files: files(50),
      onSlice: () => serviceRef?.cancel(),
    });
    serviceRef = service;

    const result = await service.start({ inventoryIds: null });

    expect(result.phase).toBe("cancelled");
    expect(result.processed).toBeLessThan(50);
    expect(result.summary).toContain("已停止导入");
    // Cancelling is not a rollback: the books admitted before the stop stay admitted,
    // and the summary says how many that was.
    expect(result.imported).toBeGreaterThan(0);
    expect(progress.at(-1)?.phase).toBe("cancelled");
  });

  it("refuses a second run while one is in flight", async () => {
    const { service } = makeService({ files: files(20) });
    const first = service.start({ inventoryIds: null });
    expect(() => service.start({ inventoryIds: null })).toThrow("已经有导入在进行中");
    await first;
    // And once it is done, the next one is allowed.
    await expect(service.start({ inventoryIds: null })).resolves.toMatchObject({ phase: "completed" });
  });

  it("files the imported books into the collection it was given", async () => {
    const { service, filed } = makeService({
      files: files(4),
      admitted: (index) => (index === 3 ? "book-0" : `book-${index}`),
    });

    const result = await service.start({
      inventoryIds: null,
      collection: { id: "col-1", name: "某系列" },
    });

    expect(result.phase).toBe("completed");
    expect(result.collectionName).toBe("某系列");
    // The duplicate is not added twice.
    expect(filed).toEqual([["col-1", "book-0", "book-1", "book-2"]]);
    expect(result.summary).toContain("归入珍藏「某系列」");
  });

  it("reports a filing failure without pretending the import failed", async () => {
    const files4 = files(2);
    const service = new ScanImportService({
      review: {
        requireActiveRoot: () => ({ id: "root-1", rootPath: "E:\\books", displayName: "books" }),
        resolveImportFiles: () => files4,
        listUnimportedInventoryIds: () => files4.map((file) => file.inventoryId),
        addBooksToCollection: async () => { throw new Error("collection gone"); },
      },
      importer: {
        importMixedFiles: async (slice) => slice.map(() => ({
          status: "imported" as const,
          book: { id: "book-1" },
        })),
      },
      now: () => "2026-08-01T00:00:00.000Z",
    });

    const result = await service.start({
      inventoryIds: null,
      collection: { id: "col-1", name: "某系列" },
    });

    expect(result.phase).toBe("failed");
    expect(result.imported).toBe(1);
    expect(result.summary).toContain("导入完成");
    expect(result.summary).toContain("归入珍藏");
  });

  it("does nothing, politely, when there is nothing to import", async () => {
    const { service, importer } = makeService({ files: [] });

    const result = await service.start({ inventoryIds: null });

    expect(result).toMatchObject({ phase: "completed", total: 0, imported: 0 });
    expect(result.summary).toBe("没有需要导入的文件。");
    expect(importer.importMixedFiles).not.toHaveBeenCalled();
  });

  it("remembers the last progress so a screen that mounts late can catch up", async () => {
    const { service } = makeService({ files: files(5) });

    expect(service.active()).toBeNull();
    const result = await service.start({ inventoryIds: null });
    expect(service.active()).toEqual(result);
  });
});
