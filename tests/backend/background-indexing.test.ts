import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BookPreparationCoordinator } from "../../src/backend/library/book-preparation-coordinator.js";
import { BookPreparationJobRepository } from "../../src/backend/library/book-preparation-job-repository.js";
import { migrate } from "../../src/backend/storage/database.js";
import { TextIndexer, type TextUnit } from "../../src/backend/indexing/text-indexer.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
});

afterEach(() => db.close());

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

function seed(bookId: string, revision: string, prepared = true) {
  db.prepare(
    "INSERT INTO books(id,title,format,created_at,updated_at) VALUES (?,?,'epub','now','now')",
  ).run(bookId, bookId);
  db.prepare(`
    INSERT INTO book_sources(
      id,book_id,source_path,quick_fingerprint_version,quick_fingerprint,
      file_size,modified_at,source_revision,availability_status,verified_at
    ) VALUES (?,?,?,1,?,100,'now',?,'available','now')
  `).run(`source-${bookId}`, bookId, `/${bookId}.epub`, `fp-${bookId}`, revision);
  if (prepared) {
    db.prepare(`
      INSERT INTO book_preparation_jobs(
        book_id,source_revision,state,priority,attempt_count,error_code,
        created_at,updated_at,started_at,completed_at
      ) VALUES (?,?,'ready','background',1,NULL,'now','now','now','now')
    `).run(bookId, revision);
  }
}

describe("background full-text indexing", () => {
  it("enqueue returns immediately and limits extraction concurrency to two", async () => {
    for (const id of ["book-a", "book-b", "book-c"]) seed(id, `revision-${id}`);
    const gates = new Map([
      ["book-a", deferred()],
      ["book-b", deferred()],
      ["book-c", deferred()],
    ]);
    let active = 0;
    let maxActive = 0;
    const extractor = vi.fn(async function* (bookId: string): AsyncIterable<TextUnit> {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await gates.get(bookId)!.promise;
      yield { unitIndex: 0, content: bookId, charCount: bookId.length };
      active -= 1;
    });
    const indexer = new TextIndexer(db, extractor, 2);

    indexer.enqueue("book-a");
    indexer.enqueue("book-b");
    indexer.enqueue("book-c");
    expect(extractor).not.toHaveBeenCalled();
    await new Promise((resolve) => setImmediate(resolve));
    expect(extractor).toHaveBeenCalledTimes(2);
    gates.get("book-a")!.resolve();
    gates.get("book-b")!.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    gates.get("book-c")!.resolve();
    await indexer.waitForIdle();

    expect(maxActive).toBe(2);
    expect(indexer.getIndexState("book-c")?.state).toBe("ready");
  });

  it("recovers only ready preparations with absent, interrupted, or stale index state", async () => {
    seed("book-absent", "revision-absent");
    seed("book-interrupted", "revision-interrupted");
    seed("book-stale", "revision-current");
    seed("book-current", "revision-current-book");
    db.prepare(`
      INSERT INTO book_index_state(
        book_id,source_revision,state,indexed_units,total_units,error_code,updated_at
      ) VALUES
        ('book-interrupted','revision-interrupted','indexing',0,0,NULL,'now'),
        ('book-stale','revision-old','ready',1,1,NULL,'now'),
        ('book-current','revision-current-book','ready',1,1,NULL,'now')
    `).run();
    const extracted: string[] = [];
    const extractor = async function* (bookId: string): AsyncIterable<TextUnit> {
      extracted.push(bookId);
      yield { unitIndex: 0, content: bookId, charCount: bookId.length };
    };
    const indexer = new TextIndexer(db, extractor, 2);

    indexer.recoverPending();
    await indexer.waitForIdle();

    expect(extracted.sort()).toEqual([
      "book-absent",
      "book-interrupted",
      "book-stale",
    ]);
  });

  it("a preparation success enqueues indexing and index failure leaves the book ready", async () => {
    seed("book-ready", "revision-ready", false);
    const jobs = new BookPreparationJobRepository(db);
    jobs.enqueue("book-ready", "revision-ready", "2026-07-29T00:00:00.000Z");
    const indexer = new TextIndexer(db, async function* () {
      throw new Error("index failed");
    });
    const enqueue = vi.spyOn(indexer, "enqueue");
    const coordinator = new BookPreparationCoordinator(jobs, {
      prepare: vi.fn(async () => ({} as never)),
    });
    coordinator.subscribe((event) => {
      if (event.state === "ready") indexer.enqueue(event.bookId);
    });

    coordinator.start();
    await coordinator.ensureReady("book-ready");
    await indexer.waitForIdle();
    await coordinator.stop();

    expect(enqueue).toHaveBeenCalledWith("book-ready");
    expect(jobs.get("book-ready")?.state).toBe("ready");
    expect(indexer.getIndexState("book-ready")?.state).toBe("error");
  });
});
