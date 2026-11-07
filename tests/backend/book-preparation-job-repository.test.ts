import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BookPreparationJobRepository } from "../../src/backend/library/book-preparation-job-repository.js";
import { openDatabase, type OpenedDatabase } from "../../src/backend/storage/database.js";

let dataRoot = "";
let opened: OpenedDatabase | null = null;
let repository: BookPreparationJobRepository;

const insertBook = (bookId: string, now = "2026-07-29T00:00:00.000Z") => {
  opened!.db.prepare(
    "INSERT INTO books(id,format,title,author,created_at,updated_at) VALUES (?,'epub',?,NULL,?,?)",
  ).run(bookId, bookId, now, now);
};

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "reader-preparation-repository-"));
  opened = openDatabase(dataRoot);
  repository = new BookPreparationJobRepository(opened.db);
});

afterEach(async () => {
  opened?.close();
  opened = null;
  await rm(dataRoot, { recursive: true, force: true });
});

describe("BookPreparationJobRepository", () => {
  it("enqueues idempotently and resets every mutable field for a new revision", () => {
    insertBook("book-1");
    const created = repository.enqueue("book-1", "revision-1", "2026-07-29T00:00:01.000Z");

    expect(created).toMatchObject({
      bookId: "book-1",
      sourceRevision: "revision-1",
      state: "queued",
      priority: "background",
      attemptCount: 0,
      errorCode: null,
      startedAt: null,
      completedAt: null,
    });
    expect(repository.markPreparing("book-1", "revision-1", "2026-07-29T00:00:02.000Z")).toBe(true);
    expect(repository.markError(
      "book-1",
      "revision-1",
      "INVALID_PACKAGE",
      "2026-07-29T00:00:03.000Z",
    )).toBe(true);

    const unchanged = repository.enqueue("book-1", "revision-1", "2026-07-29T00:00:04.000Z");
    expect(unchanged.state).toBe("error");
    expect(unchanged.attemptCount).toBe(1);

    const replaced = repository.enqueue("book-1", "revision-2", "2026-07-29T00:00:05.000Z");
    expect(replaced).toMatchObject({
      sourceRevision: "revision-2",
      state: "queued",
      priority: "background",
      attemptCount: 0,
      errorCode: null,
      createdAt: "2026-07-29T00:00:05.000Z",
      updatedAt: "2026-07-29T00:00:05.000Z",
      startedAt: null,
      completedAt: null,
    });
  });

  it("selects interactive work first and otherwise selects the oldest queue item", () => {
    insertBook("book-old");
    insertBook("book-new");
    insertBook("book-interactive");
    repository.enqueue("book-new", "revision-new", "2026-07-29T00:00:03.000Z");
    repository.enqueue("book-old", "revision-old", "2026-07-29T00:00:01.000Z");
    repository.enqueue("book-interactive", "revision-interactive", "2026-07-29T00:00:04.000Z");
    repository.promote("book-interactive", "revision-interactive", "2026-07-29T00:00:05.000Z");

    expect(repository.nextQueued()?.bookId).toBe("book-interactive");
    expect(repository.markPreparing(
      "book-interactive",
      "revision-interactive",
      "2026-07-29T00:00:06.000Z",
    )).toBe(true);
    expect(repository.nextQueued()?.bookId).toBe("book-old");
  });

  it("guards every transition by revision and current state", () => {
    insertBook("book-guarded");
    repository.enqueue("book-guarded", "revision-current", "2026-07-29T00:00:01.000Z");

    expect(repository.markPreparing(
      "book-guarded",
      "revision-obsolete",
      "2026-07-29T00:00:02.000Z",
    )).toBe(false);
    expect(repository.markPreparing(
      "book-guarded",
      "revision-current",
      "2026-07-29T00:00:02.000Z",
    )).toBe(true);
    expect(repository.get("book-guarded")?.attemptCount).toBe(1);
    expect(repository.markReady(
      "book-guarded",
      "revision-obsolete",
      "2026-07-29T00:00:03.000Z",
    )).toBe(false);
    expect(repository.markReady(
      "book-guarded",
      "revision-current",
      "2026-07-29T00:00:03.000Z",
    )).toBe(true);
    expect(repository.markReady(
      "book-guarded",
      "revision-current",
      "2026-07-29T00:00:04.000Z",
    )).toBe(false);
  });

  it("retries terminal failures and recovers interrupted work without losing attempts", () => {
    for (const bookId of ["book-a", "book-b", "book-error"]) insertBook(bookId);
    repository.enqueue("book-a", "revision-a", "2026-07-29T00:00:01.000Z");
    repository.enqueue("book-b", "revision-b", "2026-07-29T00:00:02.000Z");
    repository.enqueue("book-error", "revision-error", "2026-07-29T00:00:03.000Z");
    repository.markPreparing("book-a", "revision-a", "2026-07-29T00:00:04.000Z");
    repository.markPreparing("book-b", "revision-b", "2026-07-29T00:00:04.000Z");
    repository.markPreparing("book-error", "revision-error", "2026-07-29T00:00:04.000Z");
    repository.markError(
      "book-error",
      "revision-error",
      "INVALID_PACKAGE",
      "2026-07-29T00:00:05.000Z",
    );

    expect(repository.recoverInterrupted("2026-07-29T00:00:06.000Z")).toBe(2);
    expect(repository.get("book-a")).toMatchObject({
      state: "queued",
      attemptCount: 1,
      startedAt: null,
      completedAt: null,
    });

    const retried = repository.retry(
      "book-error",
      "revision-error",
      "2026-07-29T00:00:07.000Z",
    );
    expect(retried).toMatchObject({
      state: "queued",
      priority: "interactive",
      attemptCount: 1,
      errorCode: null,
      startedAt: null,
      completedAt: null,
    });
  });
});
