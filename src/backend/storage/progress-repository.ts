import type Database from "better-sqlite3";
import { ReadingLocationSchema, type ReadingLocationV1 } from "../../shared/contracts.js";

export class ProgressRepository {
  constructor(private readonly db: Database.Database) {}

  get(bookId: string): ReadingLocationV1 | null {
    const row = this.db.prepare("SELECT locator_json FROM reading_progress WHERE book_id=?").get(bookId) as { locator_json: string } | undefined;
    return row ? ReadingLocationSchema.parse(JSON.parse(row.locator_json)) : null;
  }

  save(bookId: string, location: ReadingLocationV1, updatedAt: string) {
    this.db.prepare(`INSERT INTO reading_progress(book_id,locator_version,locator_json,source_revision,updated_at)
      VALUES (?,?,?,?,?) ON CONFLICT(book_id) DO UPDATE SET locator_version=excluded.locator_version,locator_json=excluded.locator_json,source_revision=excluded.source_revision,updated_at=excluded.updated_at`)
      .run(bookId, location.locatorVersion, JSON.stringify(location), location.sourceRevision, updatedAt);
  }
}
