import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBookTextExtractor } from "../../src/backend/indexing/book-text-extractor.js";
import { TextIndexer } from "../../src/backend/indexing/text-indexer.js";
import { LibraryAdmissionService } from "../../src/backend/library/library-admission-service.js";
import { LibraryImportService } from "../../src/backend/library/library-import-service.js";
import { migrate } from "../../src/backend/storage/database.js";

let db: Database.Database;
let root = "";
const cleanup: string[] = [];

beforeEach(async () => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  root = await mkdtemp(join(tmpdir(), "reader-txt-index-"));
  cleanup.push(root);
});

afterEach(async () => {
  db.close();
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function writeTxt(name: string, text: string) {
  const path = join(root, name);
  await writeFile(path, text, "utf8");
  return path;
}

/** Build the same wiring createServices() uses, without Electron. */
function buildIndexer() {
  return new TextIndexer(
    db,
    createBookTextExtractor(db, () => null),
  );
}

describe("TXT full-text indexing pipeline", () => {
  it("makes an imported TXT book searchable", async () => {
    // This is the regression guard for the original defect: enqueue was wired only
    // to EPUB preparation, so TXT books were never indexed and search returned
    // nothing for the app's primary format.
    const indexer = buildIndexer();
    const importer = new LibraryImportService({
      admission: new LibraryAdmissionService(db),
      preparations: { notifyQueued: vi.fn() },
      textIndexer: indexer,
    });
    const path = await writeTxt("novel.txt", "第一章 风起云涌\n\n少年走出山谷，第一次看见大海。\n");

    const result = await importer.importFiles([path], "txt");
    expect(result.status).toBe("completed");

    await indexer.waitForIdle();

    const hits = indexer.search("风起云涌");
    expect(hits).toHaveLength(1);
    expect(hits[0].matchSnippet).toContain("风起云涌");
    // Two-character CJK queries must work as well.
    expect(indexer.search("少年")).toHaveLength(1);
    expect(indexer.search("大海")).toHaveLength(1);
  });

  it("recovers TXT books that were imported before indexing existed", async () => {
    // Import without any indexer, exactly like the old code path.
    const admission = new LibraryAdmissionService(db);
    const path = await writeTxt("legacy.txt", "这是一本没有被索引过的旧书，里面的古老森林很茂密。");
    await admission.admitTxt(path);
    expect(db.prepare("SELECT count(*) c FROM book_index_state").get()).toEqual({ c: 0 });

    const indexer = buildIndexer();
    indexer.recoverPending();
    await indexer.waitForIdle();

    const hits = indexer.search("古老森林");
    expect(hits).toHaveLength(1);
  });

  it("does not re-index an already indexed TXT book on every startup", async () => {
    const admission = new LibraryAdmissionService(db);
    const path = await writeTxt("stable.txt", "内容稳定的一本书，提到雪山与湖泊。");
    await admission.admitTxt(path);

    const first = buildIndexer();
    const firstEnqueued = vi.spyOn(first, "enqueue");
    first.recoverPending();
    expect(firstEnqueued).toHaveBeenCalledTimes(1);
    await first.waitForIdle();
    expect(first.search("雪山")).toHaveLength(1);

    const bookId = (db.prepare("SELECT id FROM books LIMIT 1").get() as { id: string }).id;
    expect(first.getIndexState(bookId)?.state).toBe("ready");

    // A later startup must find nothing left to do.
    const second = buildIndexer();
    const secondEnqueued = vi.spyOn(second, "enqueue");
    second.recoverPending();
    expect(secondEnqueued).not.toHaveBeenCalled();
    await second.waitForIdle();
    expect(second.search("雪山")).toHaveLength(1);
  });

  it("re-indexes a TXT book whose source revision changed", async () => {
    const indexer = buildIndexer();
    const importer = new LibraryImportService({
      admission: new LibraryAdmissionService(db),
      preparations: { notifyQueued: vi.fn() },
      textIndexer: indexer,
    });
    const path = await writeTxt("rewritten.txt", "旧版本内容，只提到湖泊。");
    await importer.importFiles([path], "txt");
    await indexer.waitForIdle();
    expect(indexer.search("湖泊")).toHaveLength(1);

    // Rewrite the file and re-import the same path.
    await writeTxt("rewritten.txt", "新版本内容，改成了雪山与冰川。");
    await importer.importFiles([path], "txt");
    await indexer.waitForIdle();

    expect(indexer.search("冰川")).toHaveLength(1);
    expect(indexer.search("湖泊")).toHaveLength(0);
  });

  it("keeps serving EPUB search alongside TXT search", async () => {
    // Indexing is shared infrastructure, so a TXT book must not disturb EPUB rows.
    const indexer = new TextIndexer(db, async function* (bookId) {
      const text = bookId === "txt-book"
        ? "中文小说提到古老森林"
        : "An English EPUB mentioning an ancient forest";
      yield { unitIndex: 0, content: text, charCount: text.length };
    });
    const now = "2026-01-01T00:00:00.000Z";
    for (const [id, format] of [["txt-book", "txt"], ["epub-book", "epub"]] as const) {
      db.prepare("INSERT INTO books(id,title,format,created_at,updated_at) VALUES (?,?,?,?,?)")
        .run(id, id, format, now, now);
      db.prepare(`
        INSERT INTO book_sources(
          id, book_id, source_path, quick_fingerprint_version, quick_fingerprint,
          file_size, modified_at, source_revision, availability_status, verified_at
        ) VALUES (?,?,?,1,?,10,?,?,'available',?)
      `).run(`src-${id}`, id, `/${id}`, `fp-${id}`, now, `rev-${id}`, now);
    }

    await indexer.indexBook("txt-book");
    await indexer.indexBook("epub-book");

    expect(indexer.search("古老森林").map((hit) => hit.bookId)).toEqual(["txt-book"]);
    expect(indexer.search("ancient forest").map((hit) => hit.bookId)).toEqual(["epub-book"]);
    expect(indexer.search("forest").map((hit) => hit.bookId)).toEqual(["epub-book"]);
  });

  it("removes a deleted book from search results", async () => {
    const indexer = buildIndexer();
    const importer = new LibraryImportService({
      admission: new LibraryAdmissionService(db),
      preparations: { notifyQueued: vi.fn() },
      textIndexer: indexer,
    });
    const path = await writeTxt("deletable.txt", "这本书即将被移出书架，内容包含蓝鲸。");
    const imported = await importer.importFiles([path], "txt");
    await indexer.waitForIdle();
    expect(indexer.search("蓝鲸")).toHaveLength(1);

    const bookId = (imported.status === "completed" ? imported.items[0] : null) as
      | { book?: { id: string } }
      | null;
    const id = bookId?.book?.id;
    expect(id).toBeTruthy();

    db.prepare("DELETE FROM books WHERE id = ?").run(id);
    expect(indexer.search("蓝鲸")).toHaveLength(0);
  });
});
