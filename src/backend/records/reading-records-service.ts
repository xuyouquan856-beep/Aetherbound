import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { ReaderError } from "../../shared/errors.js";
import {
  ReadingRecordSchema, SaveReadingRecordSchema,
  type ListReadingRecords, type ReadingRecord, type SaveReadingRecord,
} from "../../shared/reading-records.js";

type RecordRow = {
  id: string; kind: ReadingRecord["kind"]; book_id: string | null;
  book_title: string; author: string | null; text: string; excerpt: string; source_url: string; note: string;
  color: ReadingRecord["color"]; location_json: string | null;
  location_key: string | null;
  end_location_json: string | null; enabled: number; pinned: number;
  created_at: string; updated_at: string;
};

function toRecord(row: RecordRow): ReadingRecord {
  return ReadingRecordSchema.parse({
    id: row.id, kind: row.kind, bookId: row.book_id,
    bookTitle: row.book_title, author: row.author, text: row.text,
    excerpt: row.excerpt, sourceUrl: row.source_url,
    note: row.note, color: row.color,
    location: row.location_json ? JSON.parse(row.location_json) : null,
    endLocation: row.end_location_json ? JSON.parse(row.end_location_json) : null,
    enabled: Boolean(row.enabled), pinned: Boolean(row.pinned),
    createdAt: row.created_at, updatedAt: row.updated_at,
  });
}

export class ReadingRecordsService {
  constructor(private readonly db: Database.Database, private readonly now: () => Date = () => new Date()) {}

  list(filter: ListReadingRecords = {}): ReadingRecord[] {
    const conditions: string[] = [];
    const values: string[] = [];
    if (filter.bookId) { conditions.push("book_id = ?"); values.push(filter.bookId); }
    if (filter.kind) { conditions.push("kind = ?"); values.push(filter.kind); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    return (this.db.prepare(`SELECT * FROM reading_records ${where} ORDER BY created_at DESC,id DESC`)
      .all(...values) as RecordRow[]).map(toRecord);
  }

  save(value: SaveReadingRecord): ReadingRecord {
    const input = SaveReadingRecordSchema.parse(value);
    return this.db.transaction(() => {
      let title = input.bookTitle;
      let author = input.author;
      if (input.bookId) {
        const book = this.db.prepare("SELECT title,author,format FROM books WHERE id=?")
          .get(input.bookId) as { title: string; author: string | null; format: string } | undefined;
        if (!book) throw new ReaderError("BOOK_NOT_FOUND", "Book is no longer in the library.");
        title = book.title;
        author = book.author;
        for (const location of [input.location, input.endLocation]) {
          if (!location) continue;
          if (location.format !== book.format) throw new ReaderError("INVALID_REQUEST", "Record location format does not match the book.");
          const source = this.db.prepare("SELECT 1 FROM book_sources WHERE book_id=? AND source_revision=?")
            .get(input.bookId, location.sourceRevision);
          if (!source) throw new ReaderError("SOURCE_CHANGED", "Record location refers to a different source revision.");
        }
      }
      if (input.endLocation && (!input.location || input.endLocation.format !== input.location.format
        || input.endLocation.sourceRevision !== input.location.sourceRevision)) {
        throw new ReaderError("INVALID_REQUEST", "Record range endpoints must share a source.");
      }
      const locationJson = input.location ? JSON.stringify(input.location) : null;
      const locationKey = input.location ? JSON.stringify({
        format: input.location.format,
        sourceRevision: input.location.sourceRevision,
        primary: input.location.primary,
      }) : null;
      const endLocationJson = input.endLocation ? JSON.stringify(input.endLocation) : null;
      let id = input.id;
      let existing = id ? this.db.prepare("SELECT * FROM reading_records WHERE id=?").get(id) as RecordRow | undefined : undefined;
      if (id && !existing) throw new ReaderError("INVALID_REQUEST", "Record does not exist.");
      if (!existing && input.bookId && input.kind === "bookmark" && locationKey) {
        existing = this.db.prepare("SELECT * FROM reading_records WHERE kind='bookmark' AND book_id=? AND location_key=?")
          .get(input.bookId, locationKey) as RecordRow | undefined;
      }
      if (!existing && input.bookId && input.kind === "quote") {
        existing = this.db.prepare("SELECT * FROM reading_records WHERE kind='quote' AND book_id=? AND text=? AND COALESCE(location_json,'')=COALESCE(?,'')")
          .get(input.bookId, input.text, locationJson) as RecordRow | undefined;
      }
      id = existing?.id ?? id ?? randomUUID();
      const excerpt = value.excerpt ?? existing?.excerpt ?? "";
      const sourceUrl = value.sourceUrl ?? existing?.source_url ?? "";
      const time = this.now().toISOString();
      if (input.kind === "quote" && input.pinned) {
        this.db.prepare("UPDATE reading_records SET pinned=0,updated_at=? WHERE kind='quote' AND pinned=1 AND id<>?")
          .run(time, id);
      }
      if (existing) {
        this.db.prepare(`UPDATE reading_records SET kind=?,book_id=?,book_title=?,author=?,text=?,excerpt=?,source_url=?,note=?,color=?,
          location_json=?,location_key=?,end_location_json=?,enabled=?,pinned=?,updated_at=? WHERE id=?`)
          .run(input.kind, input.bookId, title, author, input.text, excerpt, sourceUrl, input.note, input.color,
            locationJson, locationKey, endLocationJson, Number(input.enabled), Number(input.pinned), time, id);
      } else {
        this.db.prepare(`INSERT INTO reading_records(id,kind,book_id,book_title,author,text,excerpt,source_url,note,color,
          location_json,location_key,end_location_json,enabled,pinned,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(id, input.kind, input.bookId, title, author, input.text, excerpt, sourceUrl, input.note, input.color,
            locationJson, locationKey, endLocationJson, Number(input.enabled), Number(input.pinned), time, time);
      }
      return toRecord(this.db.prepare("SELECT * FROM reading_records WHERE id=?").get(id) as RecordRow);
    })();
  }

  remove({ id }: { id: string }): void {
    this.db.prepare("DELETE FROM reading_records WHERE id=?").run(id);
  }
}
