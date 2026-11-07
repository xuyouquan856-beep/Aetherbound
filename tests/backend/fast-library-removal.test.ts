import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { migrate, migrations } from "../../src/backend/storage/database.js";

it("migrates existing FTS rows to a book lookup and deletes only the removed book's rows", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  try {
    migrate(db, migrations.filter((migration) => migration.version <= 15));
    for (const id of ["remove", "keep"]) {
      db.prepare("INSERT INTO books(id,title,format,created_at,updated_at) VALUES (?,?,'txt','now','now')")
        .run(id, id);
      db.prepare("INSERT INTO book_content_fts(book_id,unit_index,content) VALUES (?,0,?)")
        .run(id, `content for ${id}`);
    }

    expect(migrate(db, migrations.filter((migration) => migration.version <= 16))).toBe(16);
    expect(db.prepare("SELECT COUNT(*) AS count FROM book_content_fts_rows").get()).toEqual({ count: 2 });
    const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='book_content_fts_cleanup'")
      .get() as { sql: string };
    expect(trigger.sql).toContain("book_content_fts_rows");
    expect(trigger.sql).toContain("rowid");
    const lookupPlan = db.prepare(`EXPLAIN QUERY PLAN
      DELETE FROM book_content_fts WHERE rowid IN
        (SELECT fts_rowid FROM book_content_fts_rows WHERE book_id = ?)`)
      .all("remove") as Array<{ detail: string }>;
    expect(lookupPlan.some((step) => step.detail.includes("USING COVERING INDEX book_content_fts_rows_book_idx"))).toBe(true);
    expect(lookupPlan.some((step) => step.detail.includes("VIRTUAL TABLE INDEX 0:="))).toBe(true);

    db.prepare("DELETE FROM books WHERE id = ?").run("remove");
    expect(db.prepare("SELECT book_id FROM book_content_fts").all()).toEqual([{ book_id: "keep" }]);
    expect(db.prepare("SELECT book_id FROM book_content_fts_rows").all()).toEqual([{ book_id: "keep" }]);
  } finally {
    db.close();
  }
});
