import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../src/backend/storage/database.js";
import { TextIndexer } from "../../src/backend/indexing/text-indexer.js";

function seed(db: Database.Database) {
  db.exec("INSERT INTO books(id, title, format, created_at, updated_at) VALUES ('b1','Test Book','txt','now','now')");
  db.exec("INSERT INTO book_sources(id, book_id, source_path, quick_fingerprint_version, quick_fingerprint, file_size, modified_at, source_revision, availability_status, verified_at) VALUES ('s1','b1','/test.txt',1,'fp',100,'now','rev1','available','now')");
}

async function* mockExtractor(bookId: string) {
  if (bookId === "b2") {
    yield { unitIndex: 0, content: "book two content", charCount: 16 };
  } else {
    yield { unitIndex: 0, content: "hello world test content", charCount: 24 };
    yield { unitIndex: 1, content: "second unit here", charCount: 16 };
  }
}

async function* emptyExtractor(_bookId: string) {
  // yields nothing
}

async function* errorExtractor(_bookId: string) {
  throw new Error("extraction failed");
}

describe("TextIndexer", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db);
    seed(db);
  });

  afterEach(() => db.close());

  it("indexBook writes text_units and content_fts", async () => {
    const indexer = new TextIndexer(db, mockExtractor);
    await indexer.indexBook("b1");

    const units = db.prepare("SELECT * FROM book_text_units WHERE book_id = ?").all("b1");
    expect(units).toHaveLength(2);
    expect(db.prepare("SELECT COUNT(*) AS count FROM book_content_fts_rows WHERE book_id = ?").get("b1"))
      .toEqual({ count: 2 });

    const fts = indexer.search("hello");
    expect(fts.length).toBeGreaterThanOrEqual(1);
    expect(fts[0].bookId).toBe("b1");
  });

  it("removeBook clears all index data", async () => {
    const indexer = new TextIndexer(db, mockExtractor);
    await indexer.indexBook("b1");
    indexer.removeBook("b1");

    expect(db.prepare("SELECT * FROM book_text_units WHERE book_id = ?").all("b1")).toHaveLength(0);
    expect(db.prepare("SELECT COUNT(*) AS count FROM book_content_fts_rows WHERE book_id = ?").get("b1"))
      .toEqual({ count: 0 });
    expect(indexer.getIndexState("b1")).toBeNull();
  });

  it("getIndexState returns ready after successful index", async () => {
    const indexer = new TextIndexer(db, mockExtractor);
    await indexer.indexBook("b1");

    const state = indexer.getIndexState("b1")!;
    expect(state.state).toBe("ready");
    expect(state.indexedUnits).toBe(2);
  });

  it("getIndexState returns error after failed extraction", async () => {
    const indexer = new TextIndexer(db, errorExtractor);
    await expect(indexer.indexBook("b1")).rejects.toThrow();
    const state = indexer.getIndexState("b1")!;
    expect(state.state).toBe("error");
  });

  it("skips re-index when sourceRevision unchanged", async () => {
    const indexer = new TextIndexer(db, mockExtractor);
    await indexer.indexBook("b1");

    // Second call with same revision — should skip
    await indexer.indexBook("b1");
    // Verify only 2 units (not re-inserted)
    const units = db.prepare("SELECT * FROM book_text_units WHERE book_id = ?").all("b1");
    expect(units).toHaveLength(2);
  });

  it("reindexAll processes all books", async () => {
    db.exec("INSERT INTO books(id, title, format, created_at, updated_at) VALUES ('b2','Book 2','epub','now','now')");
    db.exec("INSERT INTO book_sources(id, book_id, source_path, quick_fingerprint_version, quick_fingerprint, file_size, modified_at, source_revision, availability_status, verified_at) VALUES ('s2','b2','/test.epub',1,'fp2',200,'now','rev2','available','now')");

    const indexer = new TextIndexer(db, mockExtractor);
    await indexer.reindexAll();

    expect(indexer.getIndexState("b1")?.state).toBe("ready");
    expect(indexer.getIndexState("b2")?.state).toBe("ready");
  });

  it("search returns a snippet for a matching query", async () => {
    const indexer = new TextIndexer(db, mockExtractor);
    await indexer.indexBook("b1");

    const results = indexer.search("hello world");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].matchSnippet).toBeTruthy();
  });

  it("search returns empty for empty query", () => {
    const indexer = new TextIndexer(db, mockExtractor);
    expect(indexer.search("")).toEqual([]);
  });

  it("does not fail when book has no source_revision", async () => {
    db.exec("INSERT INTO books(id, title, format, created_at, updated_at) VALUES ('b3','No Source','txt','now','now')");
    const indexer = new TextIndexer(db, mockExtractor);
    await indexer.indexBook("b3");
    expect(indexer.getIndexState("b3")?.state).toBe("ready");
  });
});
