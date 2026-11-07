import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BookRepository } from "../../src/backend/storage/book-repository.js";
import { migrate } from "../../src/backend/storage/database.js";

describe("BookRepository summary times", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db);
    db.prepare(
      `INSERT INTO books(id, format, title, author, created_at, updated_at)
       VALUES ('b1', 'txt', '星海书', '顾遥', '2026-07-01T00:00:00.000Z', '2026-07-02T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO book_sources(
        id, book_id, source_path, quick_fingerprint_version, quick_fingerprint,
        full_content_hash_algorithm, full_content_hash, file_size, modified_at,
        source_revision, availability_status, verified_at
      ) VALUES (
        's1', 'b1', 'E:\\books\\star.txt', 1, 'quick', NULL, NULL, 100,
        '2026-07-01T00:00:00.000Z', 'revision-1', 'available',
        '2026-07-02T00:00:00.000Z'
      )`,
    ).run();
  });

  afterEach(() => db.close());

  it("returns creation time and null last-read time for an unread book", () => {
    const [book] = new BookRepository(db).list();

    expect(book.addedAt).toBe("2026-07-01T00:00:00.000Z");
    expect(book.updatedAt).toBe("2026-07-02T00:00:00.000Z");
    expect(book.lastReadAt).toBeNull();
  });

  it("returns reading_progress.updated_at as lastReadAt", () => {
    db.prepare(
      `INSERT INTO reading_progress(
        book_id, locator_version, locator_json, source_revision, updated_at
      ) VALUES (?, 1, ?, 'revision-1', '2026-07-03T12:00:00.000Z')`,
    ).run("b1", JSON.stringify({
      locatorVersion: 1,
      sourceRevision: "revision-1",
      format: "txt",
      primary: {
        kind: "txt",
        chapterId: "chapter-1",
        characterOffset: 20,
      },
      progression: { resource: 0.25, total: 0.25 },
      text: { exact: "正文", prefix: "", suffix: "" },
    }));

    const book = new BookRepository(db).getBook("b1");
    expect(book?.lastReadAt).toBe("2026-07-03T12:00:00.000Z");
    expect(book?.progress).toBe(0.25);
  });
});
