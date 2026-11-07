import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backfillCoverThumbnails } from "../../src/backend/library/cover-thumbnail-backfill.js";
import { COVER_THUMBNAIL_FILE } from "../../src/backend/library/epub-preparation-service.js";
import { openDatabase, type OpenedDatabase } from "../../src/backend/storage/database.js";

const TINY_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

let dataRoot = "";
let opened: OpenedDatabase | null = null;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "reader-cover-backfill-"));
  opened = openDatabase(dataRoot);
});

afterEach(async () => {
  opened?.close();
  opened = null;
  await rm(dataRoot, { recursive: true, force: true });
});

function seedBook(bookId: string, sourceRevision: string, format = "epub") {
  const now = "2026-01-01T00:00:00.000Z";
  opened!.db.prepare(
    "INSERT INTO books(id,title,format,created_at,updated_at) VALUES (?,?,?,?,?)",
  ).run(bookId, `Book ${bookId}`, format, now, now);
  opened!.db.prepare(`
    INSERT INTO book_sources(
      id, book_id, source_path, quick_fingerprint_version, quick_fingerprint,
      file_size, modified_at, source_revision, availability_status, verified_at
    ) VALUES (?,?,?,1,?,?,?,?,'available',?)
  `).run(
    `src-${bookId}`, bookId, `/${bookId}.epub`, `fp-${bookId}`,
    1024, now, sourceRevision, now,
  );
}

async function writeCover(bookId: string, sourceRevision: string, bytes: Uint8Array) {
  const directory = join(dataRoot, "publications", bookId, sourceRevision);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "cover"), bytes);
}

describe("backfillCoverThumbnails", () => {
  it("creates missing thumbnails from covers already in the prepared cache", async () => {
    seedBook("book-1", "rev-1");
    await writeCover("book-1", "rev-1", TINY_PNG);
    const produced = new Uint8Array([...TINY_PNG, 7, 7, 7]);

    const created = await backfillCoverThumbnails({
      db: opened!.db,
      dataRoot,
      createCoverThumbnail: async () => produced,
    });

    expect(created).toBe(1);
    expect(new Uint8Array(await readFile(
      join(dataRoot, "publications", "book-1", "rev-1", COVER_THUMBNAIL_FILE),
    ))).toEqual(produced);
  });

  it("skips books that already have a thumbnail instead of re-encoding", async () => {
    seedBook("book-1", "rev-1");
    await writeCover("book-1", "rev-1", TINY_PNG);
    await writeFile(
      join(dataRoot, "publications", "book-1", "rev-1", COVER_THUMBNAIL_FILE),
      TINY_PNG,
    );
    let calls = 0;

    const created = await backfillCoverThumbnails({
      db: opened!.db,
      dataRoot,
      createCoverThumbnail: async () => { calls += 1; return TINY_PNG; },
    });

    expect(created).toBe(0);
    expect(calls).toBe(0);
  });

  it("ignores books with no cover in the cache", async () => {
    seedBook("book-1", "rev-1");
    await mkdir(join(dataRoot, "publications", "book-1", "rev-1"), { recursive: true });

    const created = await backfillCoverThumbnails({
      db: opened!.db,
      dataRoot,
      createCoverThumbnail: async () => TINY_PNG,
    });

    expect(created).toBe(0);
  });

  it("never touches non-EPUB books", async () => {
    seedBook("txt-1", "rev-1", "txt");
    await writeCover("txt-1", "rev-1", TINY_PNG);

    const created = await backfillCoverThumbnails({
      db: opened!.db,
      dataRoot,
      createCoverThumbnail: async () => TINY_PNG,
    });

    expect(created).toBe(0);
  });

  it("skips a cover whose bytes are not a recognizable raster image", async () => {
    seedBook("book-1", "rev-1");
    await writeCover("book-1", "rev-1", new TextEncoder().encode("not an image"));

    const created = await backfillCoverThumbnails({
      db: opened!.db,
      dataRoot,
      createCoverThumbnail: async () => TINY_PNG,
    });

    expect(created).toBe(0);
    await expect(access(
      join(dataRoot, "publications", "book-1", "rev-1", COVER_THUMBNAIL_FILE),
    )).rejects.toThrow();
  });

  it("keeps going when one book fails to thumbnail", async () => {
    seedBook("book-1", "rev-1");
    seedBook("book-2", "rev-2");
    await writeCover("book-1", "rev-1", TINY_PNG);
    await writeCover("book-2", "rev-2", TINY_PNG);
    let calls = 0;

    const created = await backfillCoverThumbnails({
      db: opened!.db,
      dataRoot,
      createCoverThumbnail: async () => {
        calls += 1;
        if (calls === 1) throw new Error("first one explodes");
        return TINY_PNG;
      },
    });

    // book-1 attempted and failed, book-2 succeeded.
    expect(created).toBe(1);
    await expect(access(
      join(dataRoot, "publications", "book-2", "rev-2", COVER_THUMBNAIL_FILE),
    )).resolves.toBeUndefined();
  });
});
