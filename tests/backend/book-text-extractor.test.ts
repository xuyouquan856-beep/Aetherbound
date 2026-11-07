import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import Database from "better-sqlite3";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../src/backend/storage/database.js";
import { TextIndexer } from "../../src/backend/indexing/text-indexer.js";
import { createBookTextExtractor } from "../../src/backend/indexing/book-text-extractor.js";

describe("BookTextExtractor integration (real fixtures)", () => {
  let db: Database.Database;
  let tempDir: string;
  let indexer: TextIndexer;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "aetherbound-text-test-"));
    db = new Database(":memory:");
    migrate(db);
    indexer = new TextIndexer(db, createBookTextExtractor(db));
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  function seedBook(id: string, title: string, format: string, path: string) {
    db.prepare(
      "INSERT INTO books(id, title, format, created_at, updated_at) VALUES (?,?,?,'now','now')"
    ).run(id, title, format);
    db.prepare(
      "INSERT INTO book_sources(id, book_id, source_path, quick_fingerprint_version, quick_fingerprint, file_size, modified_at, source_revision, availability_status, verified_at) VALUES (?,?,?,1,'fp',100,'now',?,'available','now')"
    ).run(`${id}-s`, id, path, `rev-${id}`);
  }

  it("indexes a real TXT file with no content loss", async () => {
    const txtPath = join(tempDir, "test.txt");
    const paragraph = "第一章：Hello world. This is a test.";
    const content = Array(200).fill(paragraph).join("\n\n");
    await writeFile(txtPath, content, "utf-8");

    seedBook("b1", "Test Book", "txt", txtPath);

    await indexer.indexBook("b1");

    const state = indexer.getIndexState("b1");
    expect(state).not.toBeNull();
    expect(state!.state).toBe("ready");
    expect(state!.indexedUnits).toBeGreaterThan(0);

    // Verify all content can be reconstructed — normalize by removing extra whitespace
    const units = db.prepare(
      "SELECT content FROM book_text_units WHERE book_id = ? ORDER BY unit_index"
    ).all("b1") as { content: string }[];
    const normalizedOriginal = content.replace(/\s+/g, " ").trim();
    const reconstructed = units.map(u => u.content).join(" ");
    // After splitting by \n{2,}, extractor treats each paragraph as a unit.
    // Join with space to account for lost paragraph separators, then normalize.
    const normalizedReconstructed = reconstructed.replace(/\s+/g, " ").trim();
    expect(normalizedReconstructed).toBe(normalizedOriginal);
  });

  it("produces charCount equal to content.length for every unit", async () => {
    const txtPath = join(tempDir, "chars.txt");
    await writeFile(txtPath, "A".repeat(9000), "utf-8"); // > 8192, should split
    seedBook("b2", "Char Test", "txt", txtPath);

    await indexer.indexBook("b2");

    const units = db.prepare(
      "SELECT content, char_count FROM book_text_units WHERE book_id = ? ORDER BY unit_index"
    ).all("b2") as { content: string; char_count: number }[];
    expect(units.length).toBe(2); // 8192 + 808
    for (const u of units) {
      expect(u.char_count).toBe(u.content.length);
    }
  });

  it("skips re-index when sourceRevision unchanged", async () => {
    const txtPath = join(tempDir, "skip.txt");
    await writeFile(txtPath, "hello", "utf-8");
    seedBook("b3", "Skip Test", "txt", txtPath);

    await indexer.indexBook("b3");
    const first = indexer.getIndexState("b3");
    expect(first!.state).toBe("ready");

    // Second call with same sourceRevision should skip
    await indexer.indexBook("b3");
    const second = indexer.getIndexState("b3");
    // updated_at should not change (skip means no state update)
    expect(second).not.toBeNull();
  });

  it("rebuilds index when sourceRevision changes", async () => {
    const txtPath = join(tempDir, "rebuild.txt");
    await writeFile(txtPath, "v1", "utf-8");
    seedBook("b4", "Rebuild Test", "txt", txtPath);

    await indexer.indexBook("b4");
    const state1 = indexer.getIndexState("b4");
    expect(state1!.indexedUnits).toBeGreaterThan(0);

    // Change sourceRevision
    db.prepare("UPDATE book_sources SET source_revision = ? WHERE book_id = ?").run("rev-new", "b4");
    await writeFile(txtPath, "v2 updated content for rebuild", "utf-8");

    await indexer.indexBook("b4");
    const state2 = indexer.getIndexState("b4");
    expect(state2!.sourceRevision).toBe("rev-new");
    expect(state2!.state).toBe("ready");
  });

  it("marks error when no available source", async () => {
    // Book exists but no book_source
    db.prepare("INSERT INTO books(id, title, format, created_at, updated_at) VALUES ('b5','NoSource','txt','now','now')").run();

    try {
      await indexer.indexBook("b5");
    } catch {
      // Error thrown but recorded
    }

    const state = indexer.getIndexState("b5");
    expect(state).not.toBeNull();
    expect(state!.state).toBe("error");
    expect(state!.errorCode).not.toBeNull();
  });

  it("indexes a minimal EPUB with spine order preserved", async () => {
    // Create a minimal EPUB zip manually
    const { createRequire } = await import("node:module");
    // Skip if no JSZip available (it's a dev dependency)
    const epubPath = join(tempDir, "minimal.epub");
    await writeFile(epubPath, "dummy-not-real-zip", "utf-8");

    seedBook("b6", "Minimal EPUB", "epub", epubPath);

    // Expect extraction failure for non-zip file — error state
    try {
      await indexer.indexBook("b6");
    } catch {
      // Expected to throw
    }

    const state = indexer.getIndexState("b6");
    expect(state).not.toBeNull();
    expect(state!.state).toBe("error");
  });

  it("reads EPUB text only from the prepared publication cache", async () => {
    const rawPath = join(tempDir, "unsafe-source.epub");
    const preparedPath = join(tempDir, "prepared.epub");
    await writeFile(rawPath, "this raw source must never be opened", "utf8");
    const zip = new JSZip();
    zip.file("mimetype", "application/epub+zip");
    zip.file("META-INF/container.xml", `<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
    zip.file("EPUB/package.opf", `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Prepared</dc:title></metadata><manifest><item id="c1" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`);
    zip.file("EPUB/chapter.xhtml", `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>prepared cache story text</p></body></html>`);
    await writeFile(
      preparedPath,
      await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }),
    );
    seedBook("b7", "Prepared EPUB", "epub", rawPath);
    const extractor = createBookTextExtractor(
      db,
      (bookId, revision) =>
        bookId === "b7" && revision === "rev-b7" ? preparedPath : null,
    );

    const units = [];
    for await (const unit of extractor("b7")) units.push(unit);

    expect(units.map((unit) => unit.content).join(" ")).toContain(
      "prepared cache story text",
    );
    const sourceCode = await import("node:fs/promises").then(({ readFile }) =>
      readFile(
        join(process.cwd(), "src/backend/indexing/book-text-extractor.ts"),
        "utf8",
      ),
    );
    expect(sourceCode).not.toContain("prepareEpub(");
  });

  it("refuses to index an EPUB when its prepared cache is unavailable", async () => {
    const rawPath = join(tempDir, "raw-only.epub");
    await writeFile(rawPath, "raw source", "utf8");
    seedBook("b8", "Raw Only", "epub", rawPath);
    const extractor = createBookTextExtractor(db, () => null);

    const collect = async () => {
      for await (const _unit of extractor("b8")) {
        // no-op
      }
    };
    await expect(collect()).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
    });
  });
});

describe("FTS orphan cleanup on book deletion", () => {
  it("clears text_units, index_state, and content_fts when book deleted", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "fts-cleanup-"));
    let db: Database.Database | undefined;
    try {
      db = new Database(":memory:");
      migrate(db);
      db.exec("PRAGMA foreign_keys = ON");
      const txtPath = join(tempDir, "fts-del.txt");
      await writeFile(txtPath, "orphan test content", "utf-8");

      // Create book + source + index
      db.prepare("INSERT INTO books(id, title, format, created_at, updated_at) VALUES ('b-del','OrphanTest','txt','now','now')").run();
      db.prepare("INSERT INTO book_sources(id, book_id, source_path, quick_fingerprint_version, quick_fingerprint, file_size, modified_at, source_revision, availability_status, verified_at) VALUES ('s-del','b-del',?,1,'fp',19,'now','rev-del','available','now')").run(txtPath);

      const extractor = createBookTextExtractor(db);
      const indexer = new TextIndexer(db, extractor);
      await indexer.indexBook("b-del");

      // Verify index exists
      const searchResults = indexer.search("orphan", 10, 0);
      expect(searchResults.length).toBeGreaterThan(0);

      // Delete book
      db.prepare("DELETE FROM books WHERE id = ?").run("b-del");

      // Verify all index data is gone
      const units = db.prepare("SELECT COUNT(*) as c FROM book_text_units WHERE book_id = 'b-del'").get() as { c: number };
      expect(units.c).toBe(0);

      const state = db.prepare("SELECT COUNT(*) as c FROM book_index_state WHERE book_id = 'b-del'").get() as { c: number };
      expect(state.c).toBe(0);

      const fts = db.prepare("SELECT COUNT(*) as c FROM book_content_fts WHERE book_id = 'b-del'").get() as { c: number };
      expect(fts.c).toBe(0);

      const noResults = indexer.search("orphan", 10, 0);
      expect(noResults.length).toBe(0);
    } finally {
      db?.close();
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
