import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  TextIndexer,
  type TextUnit,
} from "../../src/backend/indexing/text-indexer.js";
import { migrate } from "../../src/backend/storage/database.js";

function createDb() {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

function seedBook(db: Database.Database, id: string, title: string, format = "txt") {
  const now = "2026-01-01T00:00:00.000Z";
  db.prepare("INSERT INTO books(id,title,format,created_at,updated_at) VALUES (?,?,?,?,?)")
    .run(id, title, format, now, now);
  db.prepare(`
    INSERT INTO book_sources(
      id, book_id, source_path, quick_fingerprint_version, quick_fingerprint,
      file_size, modified_at, source_revision, availability_status, verified_at
    ) VALUES (?,?,?,1,?,?,?,?,'available',?)
  `).run(`src-${id}`, id, `/${id}.txt`, `fp-${id}`, 10, now, `rev-${id}`, now);
}

/** Extractor that yields the given text as a single unit. */
function extractorFor(text: string) {
  return async function* (): AsyncIterable<TextUnit> {
    yield { unitIndex: 0, content: text, charCount: text.length };
  };
}

async function indexOne(db: Database.Database, text: string) {
  const indexer = new TextIndexer(db, extractorFor(text));
  await indexer.indexBook("b1");
  return indexer;
}

describe("full-text search tokenization", () => {
  it("finds a CJK substring inside an unspaced sentence", async () => {
    const db = createDb();
    seedBook(db, "b1", "第一章");
    // Chinese novels are written without spaces between words.
    const indexer = await indexOne(db, "第一章风起云涌少年出山");

    const hits = indexer.search("风起云涌");
    expect(hits).toHaveLength(1);
    expect(hits[0].bookId).toBe("b1");
    expect(hits[0].matchSnippet).toContain("风起云涌");
    db.close();
  });

  it("finds a CJK substring that is not aligned to any word boundary", async () => {
    const db = createDb();
    seedBook(db, "b1", "书");
    const indexer = await indexOne(db, "他转身走进那片古老森林深处");

    // A three-character phrase spanning what a word tokenizer would treat as one run.
    const hits = indexer.search("古老森");
    expect(hits).toHaveLength(1);
    db.close();
  });

  it("still matches Latin words and phrases", async () => {
    const db = createDb();
    seedBook(db, "b1", "English");
    const indexer = await indexOne(db, "He walked into the quiet room");

    expect(indexer.search("walked")).toHaveLength(1);
    expect(indexer.search("into the")).toHaveLength(1);
    // Trigram also enables prefix-style substring matching for Latin text.
    expect(indexer.search("walk")).toHaveLength(1);
    db.close();
  });

  it("supports two-character CJK queries through the substring fallback", async () => {
    const db = createDb();
    seedBook(db, "b1", "书");
    // Two-character words are extremely common and trigram cannot match them.
    const indexer = await indexOne(db, "第一章 风起云涌 少年出山");

    const hits = indexer.search("风起");
    expect(hits).toHaveLength(1);
    expect(hits[0].matchSnippet).toContain("风起");
    db.close();
  });

  it("treats LIKE wildcards in a short query as literal characters", async () => {
    const db = createDb();
    seedBook(db, "b1", "书");
    const indexer = await indexOne(db, "普通的正文内容没有特殊字符");

    // A bare "%" must not behave as "match everything".
    expect(indexer.search("%")).toEqual([]);
    expect(indexer.search("__")).toEqual([]);
    db.close();
  });

  it("returns a snippet centred on the match for the short-query path", async () => {
    const db = createDb();
    seedBook(db, "b1", "书");
    const prefix = "前".repeat(200);
    const suffix = "后".repeat(200);
    const indexer = await indexOne(db, `${prefix}风起${suffix}`);

    const hits = indexer.search("风起");
    expect(hits).toHaveLength(1);
    expect(hits[0].matchSnippet).toContain("风起");
    expect(hits[0].matchSnippet.length).toBeLessThan(100);
    db.close();
  });

  it("clamps out-of-range limit and offset instead of failing", async () => {
    const db = createDb();
    seedBook(db, "b1", "书");
    const indexer = await indexOne(db, "第一章风起云涌");

    // A negative LIMIT would mean "unlimited" in SQLite without clamping.
    expect(indexer.search("风起云涌", -1, 0).length).toBeLessThanOrEqual(100);
    expect(indexer.search("风起云涌", 20, -5)).toHaveLength(1);
    db.close();
  });

  it("finds text in every indexed book, not just the newest", async () => {
    const db = createDb();
    seedBook(db, "b1", "第一本");
    seedBook(db, "b2", "第二本");
    const indexer = new TextIndexer(db, async function* (bookId) {
      const text = bookId === "b1" ? "甲本书里提到古老森林" : "乙本书里也提到古老森林";
      yield { unitIndex: 0, content: text, charCount: text.length };
    });
    await indexer.indexBook("b1");
    await indexer.indexBook("b2");

    const hits = indexer.search("古老森林");
    expect(hits.map((hit) => hit.bookId).sort()).toEqual(["b1", "b2"]);
    db.close();
  });
});
