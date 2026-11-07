import { randomUUID } from "node:crypto";
import { basename, extname } from "node:path";
import type Database from "better-sqlite3";
import type { BookSummary } from "../../shared/contracts.js";
import { ReaderError } from "../../shared/errors.js";
import { openTxt } from "../../formats/txt/adapter.js";
import { BookRepository, type SourceRecord } from "../storage/book-repository.js";
import { BookPreparationJobRepository } from "./book-preparation-job-repository.js";
import {
  fullContentHash as calculateFullContentHash,
  quickFingerprint as calculateQuickFingerprint,
} from "./fingerprint.js";

type QuickFacts = Awaited<ReturnType<typeof calculateQuickFingerprint>>;

type AdmissionRuntime = {
  quickFingerprint(path: string): Promise<QuickFacts>;
  fullContentHash(path: string): Promise<string>;
  now(): string;
  createId(): string;
};

function sameFacts(left: QuickFacts, right: QuickFacts) {
  return left.isFile === right.isFile
    && left.fileSize === right.fileSize
    && left.modifiedAt === right.modifiedAt
    && left.fingerprint === right.fingerprint;
}

export class LibraryAdmissionService {
  private readonly books: BookRepository;
  private readonly jobs: BookPreparationJobRepository;
  private readonly runtime: AdmissionRuntime;

  constructor(
    private readonly db: Database.Database,
    runtime: Partial<AdmissionRuntime> = {},
  ) {
    this.books = new BookRepository(db);
    this.jobs = new BookPreparationJobRepository(db);
    this.runtime = {
      quickFingerprint: runtime.quickFingerprint ?? calculateQuickFingerprint,
      fullContentHash: runtime.fullContentHash ?? calculateFullContentHash,
      now: runtime.now ?? (() => new Date().toISOString()),
      createId: runtime.createId ?? randomUUID,
    };
  }

  knownBookIds(): Set<string> {
    const rows = this.db.prepare("SELECT id FROM books").all() as Array<{ id: string }>;
    return new Set(rows.map((row) => row.id));
  }

  async admitEpub(path: string, targetBookId?: string): Promise<BookSummary> {
    if (extname(path).toLowerCase() !== ".epub") {
      throw new ReaderError("FORMAT_NOT_SUPPORTED", "Only EPUB files can be admitted here.");
    }
    const before = await this.runtime.quickFingerprint(path);
    if (!before.isFile) {
      throw new ReaderError("FILE_NOT_READABLE", "The selected item is not a regular file.");
    }
    if (before.fileSize > 512 * 1024 * 1024) {
      throw new ReaderError("ARCHIVE_LIMIT", "The EPUB exceeds the safe file-size limit.");
    }

    const target = this.resolveTarget(targetBookId, "epub");
    const existingPath = this.books.findSourceByPath(path);
    if (target && existingPath && existingPath.bookId !== target.bookId) {
      throw new ReaderError("INVALID_REQUEST", "The source path belongs to another book.");
    }
    if (!target && existingPath && this.sourceMatches(existingPath, before)) {
      return this.requireBook(existingPath.bookId);
    }

    let hash: string | null = null;
    if (!target && !existingPath) {
      const candidate = this.books.findSourceByQuickCandidate(
        "epub",
        before.fileSize,
        before.fingerprint,
      );
      if (candidate) {
        hash = await this.runtime.fullContentHash(path);
        await this.assertSourceUnchanged(path, before);
        if (!candidate.fullContentHash) {
          await this.verifyCandidateHash(candidate);
        }
        const identical = this.books.findSourceByHash(hash, "epub");
        if (identical) {
          const now = this.runtime.now();
          this.db.prepare(`
            UPDATE book_sources
            SET source_path = ?,
                quick_fingerprint_version = ?,
                quick_fingerprint = ?,
                file_size = ?,
                modified_at = ?,
                availability_status = 'available',
                verified_at = ?
            WHERE id = ?
          `).run(
            path,
            before.version,
            before.fingerprint,
            before.fileSize,
            before.modifiedAt,
            now,
            identical.id,
          );
          return this.requireBook(identical.bookId);
        }
      }
    }

    const existing = target ?? existingPath;
    const bookId = existing?.bookId ?? this.runtime.createId();
    const sourceRevision = this.runtime.createId();
    const now = this.runtime.now();
    const title = basename(path, extname(path));

    this.db.transaction(() => {
      if (existing) {
        this.db.prepare(
          "UPDATE books SET updated_at = ? WHERE id = ?",
        ).run(now, bookId);
        this.db.prepare(`
          UPDATE book_sources
          SET source_path = ?,
              quick_fingerprint_version = ?,
              quick_fingerprint = ?,
              full_content_hash_algorithm = ?,
              full_content_hash = ?,
              file_size = ?,
              modified_at = ?,
              source_revision = ?,
              availability_status = 'available',
              verified_at = ?
          WHERE id = ?
        `).run(
          path,
          before.version,
          before.fingerprint,
          hash ? "sha256" : null,
          hash,
          before.fileSize,
          before.modifiedAt,
          sourceRevision,
          now,
          existing.id,
        );
      } else {
        this.db.prepare(
          "INSERT INTO books(id,format,title,author,created_at,updated_at) VALUES (?,'epub',?,NULL,?,?)",
        ).run(bookId, title, now, now);
        this.db.prepare(`
          INSERT INTO book_sources(
            id,book_id,source_path,quick_fingerprint_version,quick_fingerprint,
            full_content_hash_algorithm,full_content_hash,file_size,modified_at,
            source_revision,availability_status,verified_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?, 'available',?)
        `).run(
          this.runtime.createId(),
          bookId,
          path,
          before.version,
          before.fingerprint,
          hash ? "sha256" : null,
          hash,
          before.fileSize,
          before.modifiedAt,
          sourceRevision,
          now,
        );
      }
      this.jobs.enqueue(bookId, sourceRevision, now);
    })();

    return this.requireBook(bookId);
  }

  async admitTxt(path: string, targetBookId?: string): Promise<BookSummary> {
    if (extname(path).toLowerCase() !== ".txt") {
      throw new ReaderError("FORMAT_NOT_SUPPORTED", "Only TXT files can be admitted here.");
    }
    const before = await this.runtime.quickFingerprint(path);
    if (!before.isFile) {
      throw new ReaderError("FILE_NOT_READABLE", "The selected item is not a regular file.");
    }
    if (before.fileSize > 20 * 1024 * 1024) {
      throw new ReaderError("FILE_TOO_LARGE", "TXT files larger than 20 MiB are not supported.");
    }

    const target = this.resolveTarget(targetBookId, "txt");
    const existingPath = this.books.findSourceByPath(path);
    if (target && existingPath && existingPath.bookId !== target.bookId) {
      throw new ReaderError("INVALID_REQUEST", "The source path belongs to another book.");
    }
    if (!target && existingPath && this.sourceMatches(existingPath, before)) {
      return this.requireBook(existingPath.bookId);
    }

    const hash = await this.runtime.fullContentHash(path);
    await this.assertSourceUnchanged(path, before);
    const identical = this.books.findSourceByHash(hash, "txt");
    if (!target && !existingPath && identical) {
      return this.requireBook(identical.bookId);
    }

    const existing = target ?? existingPath;
    const bookId = existing?.bookId ?? this.runtime.createId();
    const sourceRevision = this.runtime.createId();
    const document = await openTxt(path, sourceRevision);
    await this.assertSourceUnchanged(path, before);
    const now = this.runtime.now();

    this.db.transaction(() => {
      if (existing) {
        this.db.prepare(
          "UPDATE books SET title = ?, author = ?, updated_at = ? WHERE id = ?",
        ).run(document.title, document.author, now, bookId);
        this.db.prepare(`
          UPDATE book_sources
          SET source_path = ?, quick_fingerprint_version = ?, quick_fingerprint = ?,
              full_content_hash_algorithm = 'sha256', full_content_hash = ?,
              file_size = ?, modified_at = ?, source_revision = ?,
              availability_status = 'available', verified_at = ?
          WHERE id = ?
        `).run(
          path,
          before.version,
          before.fingerprint,
          hash,
          before.fileSize,
          before.modifiedAt,
          sourceRevision,
          now,
          existing.id,
        );
      } else {
        this.db.prepare(
          "INSERT INTO books(id,format,title,author,created_at,updated_at) VALUES (?,'txt',?,?,?,?)",
        ).run(bookId, document.title, document.author, now, now);
        this.db.prepare(`
          INSERT INTO book_sources(
            id,book_id,source_path,quick_fingerprint_version,quick_fingerprint,
            full_content_hash_algorithm,full_content_hash,file_size,modified_at,
            source_revision,availability_status,verified_at
          ) VALUES (?,?,?,?,?,'sha256',?,?,?,?, 'available',?)
        `).run(
          this.runtime.createId(),
          bookId,
          path,
          before.version,
          before.fingerprint,
          hash,
          before.fileSize,
          before.modifiedAt,
          sourceRevision,
          now,
        );
      }
    })();
    return this.requireBook(bookId);
  }

  private resolveTarget(
    targetBookId: string | undefined,
    format: "txt" | "epub",
  ): SourceRecord | undefined {
    if (!targetBookId) return undefined;
    const targetBook = this.books.getBook(targetBookId);
    const targetSource = this.books.getSourceForBook(targetBookId);
    if (!targetBook || !targetSource || targetBook.format !== format) {
      throw new ReaderError("BOOK_NOT_FOUND", "The target book was not found.");
    }
    return targetSource;
  }

  private sourceMatches(source: SourceRecord, facts: QuickFacts) {
    return source.fileSize === facts.fileSize
      && source.modifiedAt === facts.modifiedAt
      && source.quickFingerprint === facts.fingerprint;
  }

  private async assertSourceUnchanged(path: string, before: QuickFacts) {
    const after = await this.runtime.quickFingerprint(path);
    if (!sameFacts(before, after)) {
      throw new ReaderError("SOURCE_CHANGED", "The source changed during admission.");
    }
  }

  private async verifyCandidateHash(candidate: SourceRecord) {
    try {
      const before = await this.runtime.quickFingerprint(candidate.sourcePath);
      if (!before.isFile || !this.sourceMatches(candidate, before)) return;
      const hash = await this.runtime.fullContentHash(candidate.sourcePath);
      const after = await this.runtime.quickFingerprint(candidate.sourcePath);
      if (!sameFacts(before, after)) return;
      this.db.prepare(`
        UPDATE book_sources
        SET full_content_hash_algorithm = 'sha256',
            full_content_hash = ?,
            verified_at = ?
        WHERE id = ?
          AND source_revision = ?
          AND full_content_hash IS NULL
          AND file_size = ?
          AND modified_at = ?
          AND quick_fingerprint = ?
      `).run(
        hash,
        this.runtime.now(),
        candidate.id,
        candidate.sourceRevision,
        before.fileSize,
        before.modifiedAt,
        before.fingerprint,
      );
    } catch {
      // A stale or unavailable candidate cannot prove equality. Admission of
      // the incoming source remains valid and must not inherit that failure.
    }
  }

  private requireBook(bookId: string): BookSummary {
    const book = this.books.getBook(bookId);
    if (!book) {
      throw new ReaderError("DATABASE_ERROR", "The admitted book could not be loaded.");
    }
    return book;
  }
}
