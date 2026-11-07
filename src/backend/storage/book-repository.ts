import type Database from "better-sqlite3";
import { ReadingLocationSchema, type BookSummary } from "../../shared/contracts.js";

export type SourceRecord = {
  id: string;
  bookId: string;
  sourcePath: string;
  sourceRevision: string;
  quickFingerprint: string;
  fullContentHash: string | null;
  fileSize: number;
  modifiedAt: string;
};

export class BookRepository {
  constructor(private readonly db: Database.Database) {}

  findSourceByPath(path: string): SourceRecord | undefined {
    return this.mapSource(this.db.prepare("SELECT * FROM book_sources WHERE source_path = ?").get(path));
  }

  findSourceByHash(hash: string, format?: "txt" | "epub"): SourceRecord | undefined {
    return this.mapSource(format
      ? this.db.prepare("SELECT s.* FROM book_sources s JOIN books b ON b.id=s.book_id WHERE s.full_content_hash=? AND b.format=? LIMIT 1").get(hash, format)
      : this.db.prepare("SELECT * FROM book_sources WHERE full_content_hash = ? LIMIT 1").get(hash));
  }

  getSourceForBook(bookId: string): SourceRecord | undefined {
    return this.mapSource(this.db.prepare("SELECT * FROM book_sources WHERE book_id = ? ORDER BY verified_at DESC LIMIT 1").get(bookId));
  }

  findSourceByQuickCandidate(
    format: "txt" | "epub",
    fileSize: number,
    quickFingerprint: string,
  ): SourceRecord | undefined {
    return this.mapSource(this.db.prepare(`
      SELECT s.*
      FROM book_sources s
      JOIN books b ON b.id = s.book_id
      WHERE b.format = ? AND s.file_size = ? AND s.quick_fingerprint = ?
      ORDER BY s.verified_at ASC, s.id ASC
      LIMIT 1
    `).get(format, fileSize, quickFingerprint));
  }

  listSources(): SourceRecord[] {
    return (this.db.prepare("SELECT * FROM book_sources ORDER BY verified_at DESC").all() as any[])
      .map((row) => this.mapSource(row)!);
  }

  list(): BookSummary[] {
    const rows = this.db.prepare(`SELECT b.*, b.created_at AS added_at, b.updated_at AS book_updated_at,
      s.availability_status, p.locator_json, p.updated_at AS last_read_at,
      j.state AS preparation_status, j.error_code AS preparation_error_code
      FROM books b JOIN book_sources s ON s.book_id = b.id
      LEFT JOIN reading_progress p ON p.book_id = b.id
      LEFT JOIN book_preparation_jobs j ON j.book_id = b.id
      GROUP BY b.id ORDER BY b.updated_at DESC`).all() as any[];
    return rows.map((row) => this.mapBook(row));
  }

  getBook(bookId: string): BookSummary | undefined {
    const row = this.db.prepare(`SELECT b.*, b.created_at AS added_at, b.updated_at AS book_updated_at,
      s.availability_status, p.locator_json, p.updated_at AS last_read_at,
      j.state AS preparation_status, j.error_code AS preparation_error_code
      FROM books b JOIN book_sources s ON s.book_id = b.id
      LEFT JOIN reading_progress p ON p.book_id = b.id
      LEFT JOIN book_preparation_jobs j ON j.book_id = b.id
      WHERE b.id = ?
      ORDER BY s.verified_at DESC
      LIMIT 1`).get(bookId) as any;
    return row ? this.mapBook(row) : undefined;
  }

  private mapBook(row: any): BookSummary {
    let progress = 0;
    if (row.locator_json) {
      const parsed = ReadingLocationSchema.safeParse(JSON.parse(row.locator_json));
      progress = parsed.success ? parsed.data.progression.total ?? 0 : 0;
    }
    const summary: BookSummary = {
      id: row.id,
      title: row.title,
      author: row.author,
      format: row.format,
      availabilityStatus: row.availability_status,
      progress,
      addedAt: row.added_at,
      lastReadAt: row.last_read_at ?? null,
      updatedAt: row.book_updated_at,
      coverUrl: null,
    };
    if (row.preparation_status) {
      summary.preparationStatus = row.preparation_status;
      summary.preparationErrorCode = row.preparation_error_code ?? null;
    }
    return summary;
  }

  private mapSource(row: any): SourceRecord | undefined {
    if (!row) return undefined;
    return { id: row.id, bookId: row.book_id, sourcePath: row.source_path, sourceRevision: row.source_revision, quickFingerprint: row.quick_fingerprint, fullContentHash: row.full_content_hash, fileSize: row.file_size, modifiedAt: row.modified_at };
  }
}
