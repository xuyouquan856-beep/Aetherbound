import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LATEST_SCHEMA_VERSION, openDatabase, type OpenedDatabase } from "../../src/backend/storage/database.js";

describe("custom collections migration 12", () => {
  let opened: OpenedDatabase | undefined;
  let dataRoot: string | undefined;

  afterEach(async () => {
    opened?.close();
    if (dataRoot) await rm(dataRoot, { recursive: true, force: true });
  });

  it("creates the collection tables and indexes at the current schema version", async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "aetherbound-collections-migration-"));
    opened = openDatabase(dataRoot);

    expect(opened.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    const columns = (table: string) => (
      opened!.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    ).map(({ name }) => name);

    expect(columns("collections")).toEqual([
      "id",
      "name",
      "normalized_name",
      "created_at",
      "updated_at",
    ]);
    expect(columns("collection_books")).toEqual([
      "collection_id",
      "book_id",
      "position",
      "added_at",
    ]);
    expect(columns("collection_import_aliases")).toEqual(["folder_path", "collection_id"]);

    const indexes = opened.db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'collection_books' ORDER BY name",
    ).all() as Array<{ name: string }>;
    expect(indexes.map(({ name }) => name)).toEqual(expect.arrayContaining([
      "collection_books_book_idx",
      "collection_books_collection_position_idx",
    ]));
  });

  it("enforces normalized collection names, membership uniqueness, and cascades", async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "aetherbound-collections-constraints-"));
    opened = openDatabase(dataRoot);
    const db = opened.db;
    db.prepare(
      "INSERT INTO books(id, format, title, author, created_at, updated_at) VALUES ('b1', 'txt', '书一', NULL, 'now', 'now')",
    ).run();
    db.prepare(
      "INSERT INTO collections(id, name, normalized_name, created_at, updated_at) VALUES ('c1', '珍藏', '珍藏', 'now', 'now')",
    ).run();
    expect(() => db.prepare(
      "INSERT INTO collections(id, name, normalized_name, created_at, updated_at) VALUES ('c2', '重复', '珍藏', 'now', 'now')",
    ).run()).toThrow();

    db.prepare(
      "INSERT INTO collection_books(collection_id, book_id, position, added_at) VALUES ('c1', 'b1', 0, 'now')",
    ).run();
    db.prepare(
      "INSERT INTO collection_import_aliases(folder_path, collection_id) VALUES ('e:\\books\\珍藏', 'c1')",
    ).run();
    expect(() => db.prepare(
      "INSERT INTO collection_books(collection_id, book_id, position, added_at) VALUES ('c1', 'b1', 1, 'now')",
    ).run()).toThrow();

    db.prepare("DELETE FROM collections WHERE id = 'c1'").run();
    expect(db.prepare("SELECT COUNT(*) AS count FROM collection_books").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM collection_import_aliases").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM books").get()).toEqual({ count: 1 });
  });
});
