import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { ReaderError } from "../../shared/errors.js";

export interface Series {
  id: string;
  name: string;
  normalizedName: string;
  representativeBookId: string | null;
  source: "automatic" | "manual";
  manualLock: number;
  createdAt: string;
  updatedAt: string;
}

export interface SeriesBook {
  bookId: string;
  volumeIndex: number | null;
  volumeLabel: string | null;
  confidence: number;
  source: "automatic" | "manual";
  manualLock: number;
}

export interface SeriesWithBooks extends Series {
  books: SeriesBook[];
}

export interface BookAlias {
  id: string;
  bookId: string;
  alias: string;
  normalizedAlias: string;
  language: string | null;
  source: "automatic" | "agent" | "manual";
}

export type RelationKind = "same_work_different_edition" | "supersedes" | "translation_of" | "related";

export interface BookRelation {
  leftBookId: string;
  rightBookId: string;
  kind: RelationKind;
  confidence: number;
  source: "automatic" | "manual" | "agent";
  manualLock: number;
}

export class CollectionService {
  constructor(private readonly db: Database.Database) {}

  // --- Series CRUD ---

  createSeries(name: string, representativeBookId?: string): Series {
    const id = randomUUID();
    const normalizedName = name.trim().toLowerCase();
    const now = new Date().toISOString();

    const existing = this.db.prepare(
      "SELECT * FROM series WHERE normalized_name = ?"
    ).get(normalizedName) as Record<string, unknown> | undefined;
    if (existing) return this.mapSeries(existing);

    this.db.prepare(
      "INSERT INTO series(id, name, normalized_name, representative_book_id, source, manual_lock, created_at, updated_at) VALUES (?,?,?,?,'manual',0,?,?)"
    ).run(id, name, normalizedName, representativeBookId ?? null, now, now);

    return this.getSeries(id)!;
  }

  renameSeries(id: string, name: string): void {
    const series = this.db.prepare("SELECT * FROM series WHERE id = ?").get(id);
    if (!series) throw new ReaderError("INVALID_REQUEST", `系列 ${id} 不存在`);

    const now = new Date().toISOString();
    this.db.prepare(
      "UPDATE series SET name = ?, normalized_name = ?, updated_at = ? WHERE id = ?"
    ).run(name, name.trim().toLowerCase(), now, id);
  }

  deleteSeries(id: string): void {
    const series = this.db.prepare("SELECT * FROM series WHERE id = ?").get(id);
    if (!series) throw new ReaderError("INVALID_REQUEST", `系列 ${id} 不存在`);
    this.db.prepare("DELETE FROM series WHERE id = ?").run(id);
  }

  listSeries(): Series[] {
    const rows = this.db.prepare(
      "SELECT * FROM series ORDER BY updated_at DESC"
    ).all() as Record<string, unknown>[];
    return rows.map((r) => this.mapSeries(r));
  }

  getSeries(id: string): SeriesWithBooks | null {
    const row = this.db.prepare("SELECT * FROM series WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    const series = this.mapSeries(row);
    const books = this.db.prepare(
      "SELECT * FROM series_books WHERE series_id = ? ORDER BY volume_index ASC, book_id ASC"
    ).all(id) as Record<string, unknown>[];
    return { ...series, books: books.map((b) => this.mapSeriesBook(b)) };
  }

  // --- Volume ordering ---

  addBookToSeries(seriesId: string, bookId: string, opts: {
    volumeIndex?: number;
    volumeLabel?: string;
    confidence: number;
    source: "automatic" | "manual";
  }): void {
    const series = this.db.prepare("SELECT * FROM series WHERE id = ?").get(seriesId) as Record<string, unknown> | undefined;
    if (!series) throw new ReaderError("INVALID_REQUEST", `系列 ${seriesId} 不存在`);

    if (series.manual_lock === 1 && opts.source === "automatic") {
      throw new ReaderError("INVALID_REQUEST", `系列 ${seriesId} 已锁定，不接受自动修改`);
    }

    // PRIMARY KEY (series_id, book_id) enforces uniqueness
    this.db.prepare(
      "INSERT INTO series_books(series_id, book_id, volume_index, volume_label, confidence, source, manual_lock) VALUES (?,?,?,?,?,?,0)"
    ).run(seriesId, bookId, opts.volumeIndex ?? null, opts.volumeLabel ?? null, opts.confidence, opts.source);
  }

  removeBookFromSeries(seriesId: string, bookId: string): void {
    this.db.prepare(
      "DELETE FROM series_books WHERE series_id = ? AND book_id = ?"
    ).run(seriesId, bookId);
  }

  reorderBooks(seriesId: string, bookIds: string[]): void {
    const stmt = this.db.prepare(
      "UPDATE series_books SET volume_index = ? WHERE series_id = ? AND book_id = ?"
    );
    const tx = this.db.transaction(() => {
      for (let i = 0; i < bookIds.length; i++) {
        stmt.run(i + 1, seriesId, bookIds[i]);
      }
    });
    tx();
  }

  // --- Locking ---

  lockSeries(id: string): void {
    this.db.prepare("UPDATE series SET manual_lock = 1, updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  }

  unlockSeries(id: string): void {
    this.db.prepare("UPDATE series SET manual_lock = 0, updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  }

  isLocked(seriesId: string): boolean {
    const row = this.db.prepare("SELECT manual_lock FROM series WHERE id = ?").get(seriesId) as { manual_lock: number } | undefined;
    return row?.manual_lock === 1;
  }

  // --- Aliases ---

  addBookAlias(bookId: string, alias: string, language: string | null, source: "manual" | "agent"): void {
    const id = randomUUID();
    const normalizedAlias = alias.trim().toLowerCase();
    this.db.prepare(
      "INSERT INTO book_aliases(id, book_id, alias, normalized_alias, language, source) VALUES (?,?,?,?,?,?)"
    ).run(id, bookId, alias, normalizedAlias, language ?? null, source);
  }

  removeBookAlias(aliasId: string): void {
    this.db.prepare("DELETE FROM book_aliases WHERE id = ?").run(aliasId);
  }

  listBookAliases(bookId: string): BookAlias[] {
    const rows = this.db.prepare(
      "SELECT * FROM book_aliases WHERE book_id = ? ORDER BY alias"
    ).all(bookId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      bookId: r.book_id as string,
      alias: r.alias as string,
      normalizedAlias: r.normalized_alias as string,
      language: r.language as string | null,
      source: r.source as BookAlias["source"],
    }));
  }

  // --- Book Relations ---

  addBookRelation(left: string, right: string, kind: RelationKind, confidence: number, source: "automatic" | "manual" | "agent"): void {
    this.db.prepare(
      "INSERT INTO book_relations(left_book_id, right_book_id, kind, confidence, source, manual_lock) VALUES (?,?,?,?,?,0)"
    ).run(left, right, kind, confidence, source);
  }

  removeBookRelation(left: string, right: string, kind: RelationKind): void {
    this.db.prepare(
      "DELETE FROM book_relations WHERE left_book_id = ? AND right_book_id = ? AND kind = ?"
    ).run(left, right, kind);
  }

  listBookRelations(bookId: string): BookRelation[] {
    const rows = this.db.prepare(
      "SELECT * FROM book_relations WHERE left_book_id = ? OR right_book_id = ?"
    ).all(bookId, bookId) as Record<string, unknown>[];
    return rows.map((r) => ({
      leftBookId: r.left_book_id as string,
      rightBookId: r.right_book_id as string,
      kind: r.kind as RelationKind,
      confidence: r.confidence as number,
      source: r.source as BookRelation["source"],
      manualLock: r.manual_lock as number,
    }));
  }

  // --- Mapping ---

  private mapSeries(row: Record<string, unknown>): Series {
    return {
      id: row.id as string,
      name: row.name as string,
      normalizedName: row.normalized_name as string,
      representativeBookId: row.representative_book_id as string | null,
      source: row.source as Series["source"],
      manualLock: row.manual_lock as number,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  private mapSeriesBook(row: Record<string, unknown>): SeriesBook {
    return {
      bookId: row.book_id as string,
      volumeIndex: row.volume_index as number | null,
      volumeLabel: row.volume_label as string | null,
      confidence: row.confidence as number,
      source: row.source as SeriesBook["source"],
      manualLock: row.manual_lock as number,
    };
  }
}
