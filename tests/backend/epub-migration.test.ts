import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { LATEST_SCHEMA_VERSION, migrate, readSchemaVersion } from "../../src/backend/storage/database.js";
import { initialStatements } from "../../src/backend/storage/migrations/001-initial.js";

describe("EPUB storage migration", () => {
  it("upgrades a v1 database without losing TXT rows or foreign-key integrity", () => {
    const db = new Database(":memory:");
    migrate(db, [{ version: 1, statements: initialStatements }]);
    db.prepare("INSERT INTO books VALUES ('txt-1','txt','Existing',NULL,'now','now')").run();
    db.prepare(`INSERT INTO book_sources VALUES
      ('source-1','txt-1','E:\\existing.txt',1,'quick','sha256','hash',10,'now','rev-1','available','now')`).run();

    expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
    expect(readSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    expect(db.prepare("SELECT id,format,title FROM books WHERE id='txt-1'").get())
      .toEqual({ id: "txt-1", format: "txt", title: "Existing" });
    expect(() => db.prepare("INSERT INTO books VALUES ('epub-1','epub','EPUB',NULL,'now','now')").run()).not.toThrow();
    expect(() => db.prepare("INSERT INTO books VALUES ('pdf-1','pdf','PDF',NULL,'now','now')").run()).toThrow();
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });
});
