import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LibraryAdmissionService } from "../../src/backend/library/library-admission-service.js";
import { openDatabase } from "../../src/backend/storage/database.js";

let fixtureRoot = "";
let sourcePath = "";

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "reader-import-performance-"));
  sourcePath = join(fixtureRoot, "forty-megabyte.epub");
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "payload.bin",
    Buffer.alloc(40 * 1024 * 1024, 0x5a),
    { compression: "STORE" },
  );
  await writeFile(
    sourcePath,
    await zip.generateAsync({ type: "uint8array", compression: "STORE" }),
  );
}, 30_000);

afterAll(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

function percentile95(samples: number[]) {
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * 0.95) - 1];
}

describe("staged import wall-clock acceptance", () => {
  it("admits a fresh approximately 40 MiB EPUB within the strict foreground budget", async () => {
    const samples: number[] = [];
    const hash = vi.fn(async () => "unused");
    for (let index = 0; index < 5; index += 1) {
      const dataRoot = await mkdtemp(join(tmpdir(), `reader-fast-admission-${index}-`));
      const opened = openDatabase(dataRoot);
      try {
        const service = new LibraryAdmissionService(opened.db, {
          fullContentHash: hash,
        });
        const started = performance.now();
        const book = await service.admitEpub(sourcePath);
        samples.push(performance.now() - started);
        expect(book.preparationStatus).toBe("queued");
      } finally {
        opened.close();
        await rm(dataRoot, { recursive: true, force: true });
      }
    }

    expect(percentile95(samples), JSON.stringify(samples)).toBeLessThanOrEqual(250);
    expect(hash).not.toHaveBeenCalled();
    const sourceCode = await import("node:fs/promises").then(({ readFile }) =>
      readFile(
        join(process.cwd(), "src/backend/library/library-admission-service.ts"),
        "utf8",
      ),
    );
    expect(sourceCode).not.toContain("prepareEpub");
    expect(sourceCode).not.toContain("EpubBookFormatAdapter");
    expect(sourceCode).not.toContain("TextIndexer");
  }, 30_000);

  it("allows candidate-only hash work but never creates a second exact duplicate", async () => {
    const duplicatePath = join(fixtureRoot, "duplicate.epub");
    await writeFile(
      duplicatePath,
      await import("node:fs/promises").then(({ readFile }) => readFile(sourcePath)),
    );
    const dataRoot = await mkdtemp(join(tmpdir(), "reader-candidate-admission-"));
    const opened = openDatabase(dataRoot);
    try {
      const service = new LibraryAdmissionService(opened.db);
      const first = await service.admitEpub(sourcePath);
      const duplicate = await service.admitEpub(duplicatePath);

      expect(duplicate.id).toBe(first.id);
      expect(opened.db.prepare("SELECT COUNT(*) AS count FROM books").get())
        .toEqual({ count: 1 });
    } finally {
      opened.close();
      await rm(dataRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
