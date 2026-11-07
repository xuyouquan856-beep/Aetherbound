import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  cjkFulltextStatements,
  CJK_FULLTEXT_MIGRATION_VERSION,
} from "../../src/backend/storage/migrations/014-cjk-fulltext.js";
import { migrate, migrations } from "../../src/backend/storage/database.js";

/** Every migration except the CJK one: the schema an installed v0.4.1 already has. */
function migrationsBeforeCjk() {
  return migrations.filter((migration) => migration.version < CJK_FULLTEXT_MIGRATION_VERSION);
}

function seedBookWithIndex(db: Database.Database, bookId: string) {
  const now = "2026-01-01T00:00:00.000Z";
  db.prepare("INSERT INTO books(id,title,format,created_at,updated_at) VALUES (?,?,'txt',?,?)")
    .run(bookId, "旧书", now, now);
  db.prepare(`
    INSERT INTO book_sources(
      id, book_id, source_path, quick_fingerprint_version, quick_fingerprint,
      file_size, modified_at, source_revision, availability_status, verified_at
    ) VALUES (?,?,?,1,?,10,?,?,'available',?)
  `).run(`src-${bookId}`, bookId, `/${bookId}.txt`, "fp", now, `rev-${bookId}`, now);
  db.prepare("INSERT INTO book_text_units(book_id,unit_index,content,char_count) VALUES (?,?,?,?)")
    .run(bookId, 0, "第一章风起云涌少年出山", 11);
  const inserted = db.prepare("INSERT INTO book_content_fts(book_id,unit_index,content) VALUES (?,?,?)")
    .run(bookId, 0, "第一章风起云涌少年出山");
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='book_content_fts_rows'").get()) {
    db.prepare("INSERT INTO book_content_fts_rows(fts_rowid,book_id) VALUES (?,?)")
      .run(inserted.lastInsertRowid, bookId);
  }
  db.prepare(`
    INSERT INTO book_index_state(
      book_id,source_revision,state,indexed_units,total_units,error_code,updated_at
    ) VALUES (?,?,'ready',1,1,NULL,?)
  `).run(bookId, `rev-${bookId}`, now);
}

describe("migration 014: CJK fulltext", () => {
  it("upgrades an existing database and makes prior content searchable again", async () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");

    // Install the pre-upgrade schema, then create state a real user would have.
    const planned = migrationsBeforeCjk();
    expect(migrate(db, planned)).toBe(13);
    seedBookWithIndex(db, "legacy-book");

    // Sanity: the old unicode61 index cannot match a CJK substring.
    const before = (db.prepare(
      "SELECT count(*) c FROM book_content_fts WHERE book_content_fts MATCH ?",
    ).get('"风起"') as { c: number }).c;
    expect(before).toBe(0);

    // Apply the upgrade.
    const finalVersion = migrate(db, migrations.filter((migration) =>
      migration.version <= CJK_FULLTEXT_MIGRATION_VERSION));
    expect(finalVersion).toBe(CJK_FULLTEXT_MIGRATION_VERSION);

    // The index table was rebuilt and re-flagged for re-indexing.
    expect(db.prepare(
      "SELECT state FROM book_index_state WHERE book_id = ?",
    ).get("legacy-book")).toEqual({ state: "pending" });

    // Re-derive the index the way the startup sweep does, then search.
    db.prepare("DELETE FROM book_content_fts").run();
    db.prepare("DELETE FROM book_text_units").run();
    db.prepare("INSERT INTO book_text_units(book_id,unit_index,content,char_count) VALUES (?,?,?,?)")
      .run("legacy-book", 0, "第一章风起云涌少年出山", 11);
    db.prepare("INSERT INTO book_content_fts(book_id,unit_index,content) VALUES (?,?,?)")
      .run("legacy-book", 0, "第一章风起云涌少年出山");
    db.prepare("UPDATE book_index_state SET state='ready' WHERE book_id = ?").run("legacy-book");

    const hits = (db.prepare(
      "SELECT count(*) c FROM book_content_fts WHERE book_content_fts MATCH ?",
    ).get('"风起云涌"') as { c: number }).c;
    expect(hits).toBe(1);
    db.close();
  });

  it("keeps the FTS cleanup trigger working after the table is rebuilt", async () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db);
    seedBookWithIndex(db, "deletable");

    db.prepare("DELETE FROM books WHERE id = ?").run("deletable");

    const remaining = (db.prepare(
      "SELECT count(*) c FROM book_content_fts WHERE book_id = ?",
    ).get("deletable") as { c: number }).c;
    expect(remaining).toBe(0);
    db.close();
  });

  it("is idempotent when the statements are re-run", async () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db);
    seedBookWithIndex(db, "book-1");

    // Re-running the migration body must not throw (DROP IF EXISTS / CREATE IF NOT EXISTS).
    for (const statement of cjkFulltextStatements) db.exec(statement);
    expect(db.prepare("SELECT count(*) c FROM book_index_state").get()).toEqual({ c: 1 });
    db.close();
  });

  it("adds the book_id index used by short-query fallback", () => {
    const db = new Database(":memory:");
    migrate(db);
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'book_text_units'",
    ).all() as Array<{ name: string }>;
    expect(indexes.map((row) => row.name)).toContain("book_text_units_book_idx");
    db.close();
  });
});
