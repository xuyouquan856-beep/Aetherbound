import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BookPreparationJobRepository } from "../../src/backend/library/book-preparation-job-repository.js";
import { LibraryAdmissionService } from "../../src/backend/library/library-admission-service.js";
import { quickFingerprint } from "../../src/backend/library/fingerprint.js";
import { openDatabase, type OpenedDatabase } from "../../src/backend/storage/database.js";

let dataRoot = "";
let opened: OpenedDatabase | null = null;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "reader-admission-"));
  opened = openDatabase(dataRoot);
});

afterEach(async () => {
  vi.restoreAllMocks();
  opened?.close();
  opened = null;
  await rm(dataRoot, { recursive: true, force: true });
});

const insertCandidate = async (
  path: string,
  bookId: string,
  fullHash: string | null,
) => {
  const facts = await quickFingerprint(path);
  const now = "2026-07-29T00:00:00.000Z";
  opened!.db.transaction(() => {
    opened!.db.prepare(
      "INSERT INTO books(id,format,title,author,created_at,updated_at) VALUES (?,'epub',?,NULL,?,?)",
    ).run(bookId, bookId, now, now);
    opened!.db.prepare(`
      INSERT INTO book_sources(
        id,book_id,source_path,quick_fingerprint_version,quick_fingerprint,
        full_content_hash_algorithm,full_content_hash,file_size,modified_at,
        source_revision,availability_status,verified_at
      ) VALUES (?,?,?,?,?,'sha256',?,?,?,?, 'available',?)
    `).run(
      `source-${bookId}`,
      bookId,
      path,
      facts.version,
      facts.fingerprint,
      fullHash,
      facts.fileSize,
      facts.modifiedAt,
      `revision-${bookId}`,
      now,
    );
  })();
  return facts;
};

describe("LibraryAdmissionService", () => {
  it("admits an ordinary EPUB without hashing, parsing, preparing, or indexing it", async () => {
    const source = join(dataRoot, "Aether Chronicle.epub");
    await writeFile(source, Buffer.alloc(2 * 1024 * 1024, 7));
    const fullContentHash = vi.fn(async () => "unused");
    const service = new LibraryAdmissionService(opened!.db, { fullContentHash });

    const result = await service.admitEpub(source);

    expect(fullContentHash).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      title: "Aether Chronicle",
      format: "epub",
      preparationStatus: "queued",
      preparationErrorCode: null,
    });
    expect(opened!.db.prepare("SELECT COUNT(*) AS count FROM books").get()).toEqual({ count: 1 });
    expect(opened!.db.prepare("SELECT state FROM book_preparation_jobs").get()).toEqual({ state: "queued" });
    expect(opened!.db.prepare(
      "SELECT full_content_hash FROM book_sources",
    ).get()).toEqual({ full_content_hash: null });
  });

  it("treats an unchanged exact source path as idempotent", async () => {
    const source = join(dataRoot, "same-path.epub");
    await writeFile(source, Buffer.alloc(128 * 1024, 3));
    const fullContentHash = vi.fn(async () => "unused");
    const service = new LibraryAdmissionService(opened!.db, { fullContentHash });

    const first = await service.admitEpub(source);
    const second = await service.admitEpub(source);

    expect(second.id).toBe(first.id);
    expect(fullContentHash).not.toHaveBeenCalled();
    expect(opened!.db.prepare("SELECT COUNT(*) AS count FROM books").get()).toEqual({ count: 1 });
  });

  it("hashes only the incoming file for a quick candidate and reuses a verified duplicate", async () => {
    const existingPath = join(dataRoot, "existing.epub");
    const incomingPath = join(dataRoot, "incoming.epub");
    const bytes = Buffer.alloc(192 * 1024, 9);
    await writeFile(existingPath, bytes);
    await writeFile(incomingPath, bytes);
    await insertCandidate(existingPath, "book-existing", "verified-hash");
    const fullContentHash = vi.fn(async () => "verified-hash");
    const service = new LibraryAdmissionService(opened!.db, { fullContentHash });

    const result = await service.admitEpub(incomingPath);

    expect(result.id).toBe("book-existing");
    expect(fullContentHash).toHaveBeenCalledTimes(1);
    expect(fullContentHash).toHaveBeenCalledWith(incomingPath);
    expect(opened!.db.prepare("SELECT COUNT(*) AS count FROM books").get()).toEqual({ count: 1 });
  });

  it("verifies an unprepared candidate so immediate duplicate admissions still reuse one book", async () => {
    const firstPath = join(dataRoot, "first-copy.epub");
    const secondPath = join(dataRoot, "second-copy.epub");
    const bytes = Buffer.alloc(192 * 1024, 6);
    await writeFile(firstPath, bytes);
    await writeFile(secondPath, bytes);
    const fullContentHash = vi.fn(async () => "shared-hash");
    const service = new LibraryAdmissionService(opened!.db, { fullContentHash });

    const first = await service.admitEpub(firstPath);
    const second = await service.admitEpub(secondPath);

    expect(second.id).toBe(first.id);
    expect(fullContentHash).toHaveBeenNthCalledWith(1, secondPath);
    expect(fullContentHash).toHaveBeenNthCalledWith(2, firstPath);
    expect(opened!.db.prepare("SELECT COUNT(*) AS count FROM books").get()).toEqual({ count: 1 });
  });

  it("creates a distinct book when a quick candidate has different verified bytes", async () => {
    const existingPath = join(dataRoot, "candidate.epub");
    const incomingPath = join(dataRoot, "collision.epub");
    const bytes = Buffer.alloc(192 * 1024, 4);
    await writeFile(existingPath, bytes);
    await writeFile(incomingPath, bytes);
    await insertCandidate(existingPath, "book-candidate", "different-hash");
    const service = new LibraryAdmissionService(opened!.db, {
      fullContentHash: vi.fn(async () => "incoming-hash"),
    });

    const result = await service.admitEpub(incomingPath);

    expect(result.id).not.toBe("book-candidate");
    expect(opened!.db.prepare("SELECT COUNT(*) AS count FROM books").get()).toEqual({ count: 2 });
  });

  it("rejects a source stat change during candidate hashing", async () => {
    const candidatePath = join(dataRoot, "candidate.epub");
    const incomingPath = join(dataRoot, "changing.epub");
    const bytes = Buffer.alloc(192 * 1024, 5);
    await writeFile(candidatePath, bytes);
    await writeFile(incomingPath, bytes);
    const initial = await insertCandidate(candidatePath, "book-candidate", "candidate-hash");
    const quick = vi.fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce({ ...initial, modifiedAt: "2026-07-29T00:00:10.000Z" });
    const service = new LibraryAdmissionService(opened!.db, {
      quickFingerprint: quick,
      fullContentHash: vi.fn(async () => "incoming-hash"),
    });

    await expect(service.admitEpub(incomingPath)).rejects.toMatchObject({
      code: "SOURCE_CHANGED",
    });
    expect(opened!.db.prepare("SELECT COUNT(*) AS count FROM books").get()).toEqual({ count: 1 });
  });

  it("rolls back book and source insertion when queue insertion fails", async () => {
    const source = join(dataRoot, "atomic.epub");
    await writeFile(source, Buffer.alloc(128 * 1024, 8));
    vi.spyOn(BookPreparationJobRepository.prototype, "enqueue")
      .mockImplementationOnce(() => {
        throw new Error("queue unavailable");
      });
    const service = new LibraryAdmissionService(opened!.db);

    await expect(service.admitEpub(source)).rejects.toThrow("queue unavailable");
    expect(opened!.db.prepare("SELECT COUNT(*) AS count FROM books").get()).toEqual({ count: 0 });
    expect(opened!.db.prepare("SELECT COUNT(*) AS count FROM book_sources").get()).toEqual({ count: 0 });
  });
});
