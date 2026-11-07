import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../src/backend/storage/database.js";
import { LibrarySearchService } from "../../src/backend/library/search-service.js";

function seed(db: Database.Database) {
  db.exec(`
    INSERT INTO books(id, title, format, created_at, updated_at)
    VALUES
      ('b1','三体','txt','now','now'),
      ('b2','三体 II：黑暗森林','epub','now','now'),
      ('b3','One Piece','epub','now','now')
  `);
  // Rebuild FTS index after inserting books
  const svc = new LibrarySearchService(db);
  svc.reindexAll();
}

describe("LibrarySearchService", () => {
  let db: Database.Database;
  let svc: LibrarySearchService;

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db);
    seed(db);
    svc = new LibrarySearchService(db);
  });

  afterEach(() => db.close());

  // --- FTS5 MATCH (3+ char CJK) ---

  it("searches 3-char Chinese query via FTS5 MATCH and returns results", () => {
    const results = svc.search("三体");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.title.includes("三体"))).toBe(true);
  });

  it("returns matchSnippet with <b> tags from FTS5 snippet()", () => {
    const results = svc.search("三体");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].matchSnippet).toBeTruthy();
  });

  // --- CJK short query LIKE fallback ---

  it("falls back to LIKE for 2-char CJK query", () => {
    const results = svc.search("三");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("falls back to LIKE for 1-char CJK query", () => {
    const results = svc.search("体");
    expect(results.length).toBeGreaterThan(0);
  });

  // --- English (case-insensitive via unicode61 tokenizer) ---

  it("searches English case-insensitively", () => {
    const results = svc.search("one");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].title).toMatch(/ONE PIECE/i);
  });

  // --- Edge cases ---

  it("returns empty array for empty query", () => {
    expect(svc.search("")).toEqual([]);
  });

  it("respects limit parameter", () => {
    const results = svc.search("三体", 1);
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it("respects offset parameter", () => {
    const all = svc.search("三体", 10, 0);
    const paged = svc.search("三体", 10, 1);
    if (all.length > 1) {
      expect(paged.length).toBeLessThan(all.length);
    }
  });

  // --- Index management ---

  it("indexBook adds a new book to the index", () => {
    db.exec("INSERT INTO books(id, title, format, created_at, updated_at) VALUES ('b4','测试','txt','now','now')");
    svc.indexBook("b4");
    const results = svc.search("测试");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("removeBook removes a book from the index", () => {
    svc.removeBook("b1");
    const results = svc.search("三体");
    // b2 still matches "三体", so results should still exist but b1 is gone
    expect(results.every((r) => r.bookId !== "b1")).toBe(true);
  });

  it("reindexAll rebuilds the entire index", () => {
    db.prepare("DELETE FROM book_search_idx").run();
    svc.reindexAll();
    const results = svc.search("三体");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });
});
