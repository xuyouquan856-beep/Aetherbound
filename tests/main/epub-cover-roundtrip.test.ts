import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LibraryService } from "../../src/backend/library/library-service.js";
import { openDatabase } from "../../src/backend/storage/database.js";
import { createPublicationResponse } from "../../src/main/protocols/publication-protocol.js";
import { createEpubFixture } from "../e2e/fixtures/epub-fixture.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("EPUB cover round trip", () => {
  it("imports, presents, and serves a cached raster cover", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "cover-fixture-"));
    const dataRoot = await mkdtemp(join(tmpdir(), "cover-data-"));
    cleanup.push(fixtureRoot, dataRoot);
    const epubPath = await createEpubFixture(fixtureRoot);
    const opened = openDatabase(dataRoot);

    try {
      const library = new LibraryService(opened.db, dataRoot);
      const imported = await library.importEpub(epubPath);
      const listed = (await library.listBooks()).find(
        (book) => book.id === imported.id,
      );
      expect(listed?.coverUrl).toMatch(/^reader-resource:\/\/publication\//);

      const response = await createPublicationResponse(
        new Request(listed!.coverUrl!),
        (bookId, revision, resource) =>
          library.getPreparedPublicationPath(bookId, revision, resource),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toMatch(/^image\/(png|jpeg|webp)$/);
      expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(8);
    } finally {
      opened.close();
    }
  });
});
