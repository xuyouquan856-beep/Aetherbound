import type Database from "better-sqlite3";
import {
  BookPreparationJobSchema,
  type BookPreparationJob,
} from "../../shared/contracts.js";
import {
  ReaderError,
  type ReaderErrorCode,
} from "../../shared/errors.js";

type RawBookPreparationJob = {
  book_id: string;
  source_revision: string;
  state: string;
  priority: string;
  attempt_count: number;
  error_code: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
};

export class BookPreparationJobRepository {
  constructor(private readonly db: Database.Database) {}

  private mapRow(row: RawBookPreparationJob): BookPreparationJob {
    const parsed = BookPreparationJobSchema.safeParse({
      bookId: row.book_id,
      sourceRevision: row.source_revision,
      state: row.state,
      priority: row.priority,
      attemptCount: row.attempt_count,
      errorCode: row.error_code,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    });
    if (!parsed.success) {
      throw new ReaderError("DATABASE_ERROR", "BOOK_PREPARATION_JOB_INVALID");
    }
    return parsed.data;
  }

  get(bookId: string): BookPreparationJob | null {
    const row = this.db.prepare(
      "SELECT * FROM book_preparation_jobs WHERE book_id = ?",
    ).get(bookId) as RawBookPreparationJob | undefined;
    return row ? this.mapRow(row) : null;
  }

  enqueue(bookId: string, sourceRevision: string, now: string): BookPreparationJob {
    return this.db.transaction(() => {
      const existing = this.get(bookId);
      if (existing?.sourceRevision === sourceRevision) return existing;

      if (existing) {
        this.db.prepare(`
          UPDATE book_preparation_jobs
          SET source_revision = ?,
              state = 'queued',
              priority = 'background',
              attempt_count = 0,
              error_code = NULL,
              created_at = ?,
              updated_at = ?,
              started_at = NULL,
              completed_at = NULL
          WHERE book_id = ?
        `).run(sourceRevision, now, now, bookId);
      } else {
        this.db.prepare(`
          INSERT INTO book_preparation_jobs(
            book_id, source_revision, state, priority, attempt_count,
            error_code, created_at, updated_at, started_at, completed_at
          ) VALUES (?, ?, 'queued', 'background', 0, NULL, ?, ?, NULL, NULL)
        `).run(bookId, sourceRevision, now, now);
      }

      return this.require(bookId);
    })();
  }

  nextQueued(): BookPreparationJob | null {
    const row = this.db.prepare(`
      SELECT *
      FROM book_preparation_jobs
      WHERE state = 'queued'
      ORDER BY
        CASE priority WHEN 'interactive' THEN 0 ELSE 1 END,
        created_at ASC,
        book_id ASC
      LIMIT 1
    `).get() as RawBookPreparationJob | undefined;
    return row ? this.mapRow(row) : null;
  }

  promote(bookId: string, sourceRevision: string, now: string): BookPreparationJob {
    return this.db.transaction(() => {
      const existing = this.requireMatchingRevision(bookId, sourceRevision);
      if (existing.state === "queued" && existing.priority !== "interactive") {
        this.db.prepare(`
          UPDATE book_preparation_jobs
          SET priority = 'interactive', updated_at = ?
          WHERE book_id = ? AND source_revision = ? AND state = 'queued'
        `).run(now, bookId, sourceRevision);
      }
      return this.require(bookId);
    })();
  }

  markPreparing(bookId: string, sourceRevision: string, now: string): boolean {
    const result = this.db.prepare(`
      UPDATE book_preparation_jobs
      SET state = 'preparing',
          attempt_count = attempt_count + 1,
          error_code = NULL,
          updated_at = ?,
          started_at = ?,
          completed_at = NULL
      WHERE book_id = ? AND source_revision = ? AND state = 'queued'
    `).run(now, now, bookId, sourceRevision);
    return result.changes === 1;
  }

  markReady(bookId: string, sourceRevision: string, now: string): boolean {
    const result = this.db.prepare(`
      UPDATE book_preparation_jobs
      SET state = 'ready',
          error_code = NULL,
          updated_at = ?,
          completed_at = ?
      WHERE book_id = ? AND source_revision = ? AND state = 'preparing'
    `).run(now, now, bookId, sourceRevision);
    return result.changes === 1;
  }

  markError(
    bookId: string,
    sourceRevision: string,
    code: ReaderErrorCode,
    now: string,
  ): boolean {
    const result = this.db.prepare(`
      UPDATE book_preparation_jobs
      SET state = 'error',
          error_code = ?,
          updated_at = ?,
          completed_at = ?
      WHERE book_id = ? AND source_revision = ? AND state = 'preparing'
    `).run(code, now, now, bookId, sourceRevision);
    return result.changes === 1;
  }

  recoverInterrupted(now: string): number {
    const result = this.db.prepare(`
      UPDATE book_preparation_jobs
      SET state = 'queued',
          updated_at = ?,
          started_at = NULL,
          completed_at = NULL
      WHERE state = 'preparing'
    `).run(now);
    return result.changes;
  }

  retry(bookId: string, sourceRevision: string, now: string): BookPreparationJob {
    return this.db.transaction(() => {
      const existing = this.requireMatchingRevision(bookId, sourceRevision);
      if (existing.state !== "error") {
        throw new ReaderError("INVALID_REQUEST", "BOOK_PREPARATION_NOT_RETRYABLE");
      }
      const result = this.db.prepare(`
        UPDATE book_preparation_jobs
        SET state = 'queued',
            priority = 'interactive',
            error_code = NULL,
            updated_at = ?,
            started_at = NULL,
            completed_at = NULL
        WHERE book_id = ? AND source_revision = ? AND state = 'error'
      `).run(now, bookId, sourceRevision);
      if (result.changes !== 1) {
        throw new ReaderError("DATABASE_ERROR", "BOOK_PREPARATION_RETRY_FAILED");
      }
      return this.require(bookId);
    })();
  }

  private require(bookId: string): BookPreparationJob {
    const job = this.get(bookId);
    if (!job) {
      throw new ReaderError("BOOK_NOT_FOUND", "BOOK_PREPARATION_JOB_NOT_FOUND");
    }
    return job;
  }

  private requireMatchingRevision(
    bookId: string,
    sourceRevision: string,
  ): BookPreparationJob {
    const job = this.require(bookId);
    if (job.sourceRevision !== sourceRevision) {
      throw new ReaderError("SOURCE_CHANGED", "BOOK_PREPARATION_REVISION_CHANGED");
    }
    return job;
  }
}
