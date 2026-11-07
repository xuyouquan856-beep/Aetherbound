import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/backend/storage/database.js";
import { ReadingRecordsService } from "../../src/backend/records/reading-records-service.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function setup() {
  const root = mkdtempSync(join(tmpdir(), "reader-records-"));
  roots.push(root);
  const opened = openDatabase(root);
  opened.db.prepare("INSERT INTO books(id,format,title,author,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run("book-1", "txt", "Real title", "Real author", "now", "now");
  opened.db.prepare(`INSERT INTO book_sources(id,book_id,source_path,quick_fingerprint_version,quick_fingerprint,file_size,modified_at,source_revision,availability_status,verified_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run("source-1", "book-1", "x", 1, "x", 1, "now", "revision-1", "available", "now");
  return opened;
}

const location = {
  locatorVersion: 1 as const, sourceRevision: "revision-1", format: "txt" as const,
  primary: { kind: "txt" as const, chapterId: "chapter-1", characterOffset: 12 },
  progression: { resource: 0.1 }, text: { exact: "quote", prefix: "", suffix: "" },
};
const input = {
  kind: "quote" as const, bookId: "book-1", bookTitle: "Spoofed", author: "Spoofed",
  text: "quote", note: "memo", color: "yellow" as const,
  location, enabled: true, pinned: false,
};

describe("reading records", () => {
  it("saves, updates, and persists records with authoritative source metadata", () => {
    const opened = setup();
    const records = new ReadingRecordsService(opened.db);
    const first = records.save({ ...input, excerpt: "short", sourceUrl: "https://example.com/source" });
    expect(first).toMatchObject({ bookTitle: "Real title", author: "Real author", text: "quote",
      excerpt: "short", sourceUrl: "https://example.com/source" });
    expect(records.save({ ...input, id: first.id, note: "updated" })).toMatchObject({ id: first.id, note: "updated" });
    opened.close();
    const reopened = openDatabase(opened.dataRoot);
    expect(new ReadingRecordsService(reopened.db).list({ bookId: "book-1" })).toHaveLength(1);
    expect(new ReadingRecordsService(reopened.db).list({ kind: "quote" })[0]).toMatchObject({
      note: "updated", excerpt: "short", sourceUrl: "https://example.com/source",
    });
    reopened.close();
  });

  it("keeps quotes when their book is removed and supports explicit removal", () => {
    const opened = setup();
    const records = new ReadingRecordsService(opened.db);
    const quote = records.save(input);
    opened.db.prepare("DELETE FROM books WHERE id=?").run("book-1");
    expect(records.list({ kind: "quote" })[0]).toMatchObject({ id: quote.id, bookId: null, bookTitle: "Real title" });
    records.remove({ id: quote.id });
    expect(records.list({})).toEqual([]);
    opened.close();
  });

  it("rejects invalid source locations and keeps only one pinned quote", () => {
    const opened = setup();
    const records = new ReadingRecordsService(opened.db);
    expect(() => records.save({ ...input, location: { ...location, sourceRevision: "stale" } })).toThrow();
    expect(() => records.save({ ...input, sourceUrl: "javascript:alert(1)" })).toThrow();
    expect(() => records.save({ ...input, excerpt: "x".repeat(221) })).toThrow();
    const first = records.save({ ...input, pinned: true });
    const second = records.save({ ...input, text: "another", pinned: true });
    expect(records.list({ kind: "quote" }).filter((item) => item.pinned).map((item) => item.id)).toEqual([second.id]);
    expect(records.list({ kind: "quote" }).find((item) => item.id === first.id)?.pinned).toBe(false);
    opened.close();
  });

  it("deduplicates bookmarks by location and quotes by source text", () => {
    const opened = setup();
    const records = new ReadingRecordsService(opened.db);
    const bookmark = records.save({ ...input, kind: "bookmark", text: "Chapter" });
    expect(records.save({ ...input, kind: "bookmark", text: "New name",
      location: { ...location, progression: { resource: 0.11 } } }).id).toBe(bookmark.id);
    const quote = records.save(input);
    expect(records.save(input).id).toBe(quote.id);
    const sameTextElsewhere = records.save({ ...input, location: { ...location, primary: { ...location.primary, characterOffset: 18 } } });
    expect(sameTextElsewhere.id).not.toBe(quote.id);
    expect(records.list({})).toHaveLength(3);
    opened.close();
  });
});
