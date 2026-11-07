import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type Database from "better-sqlite3";
import {
  CollectionNameSchema,
  type BookSummary,
  type CollectionDetails,
  type CollectionMembership,
  type CollectionSummary,
} from "../../shared/contracts.js";
import { ReaderError } from "../../shared/errors.js";

type CollectionBookProvider = {
  listBooks(): Promise<BookSummary[]>;
  getBook(bookId: string): BookSummary;
};

type CollectionServiceOptions = {
  now(): string;
  id(): string;
};

type CollectionRow = {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
};

export function normalizeCollectionName(name: string) {
  return name.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

export function normalizeImportFolderPath(folderPath: string) {
  const path = resolve(folderPath).normalize("NFKC");
  return process.platform === "win32" ? path.toLowerCase() : path;
}

export class CustomCollectionService {
  private readonly options: CollectionServiceOptions;

  constructor(
    private readonly db: Database.Database,
    private readonly books: CollectionBookProvider,
    options: Partial<CollectionServiceOptions> = {},
  ) {
    this.options = {
      now: options.now ?? (() => new Date().toISOString()),
      id: options.id ?? randomUUID,
    };
  }

  async list(): Promise<CollectionSummary[]> {
    const collections = this.db.prepare(
      `SELECT c.*, COUNT(cb.book_id) AS book_count
       FROM collections c
       LEFT JOIN collection_books cb ON cb.collection_id = c.id
       GROUP BY c.id
       ORDER BY c.updated_at DESC, c.id ASC`,
    ).all() as Array<CollectionRow & { book_count: number }>;
    if (collections.length === 0) return [];

    const previews = this.db.prepare(
      `SELECT collection_id, book_id
       FROM (
         SELECT collection_id, book_id,
           ROW_NUMBER() OVER (PARTITION BY collection_id ORDER BY position, book_id) AS row_number
         FROM collection_books
       )
       WHERE row_number <= 3
       ORDER BY collection_id, row_number`,
    ).all() as Array<{ collection_id: string; book_id: string }>;
    const bookMap = new Map((await this.books.listBooks()).map((book) => [book.id, book]));
    const previewsByCollection = new Map<string, BookSummary[]>();
    for (const preview of previews) {
      const item = bookMap.get(preview.book_id);
      if (!item) continue;
      const current = previewsByCollection.get(preview.collection_id) ?? [];
      current.push(item);
      previewsByCollection.set(preview.collection_id, current);
    }

    return collections.map((collection) => ({
      id: collection.id,
      name: collection.name,
      bookCount: collection.book_count,
      previewBooks: previewsByCollection.get(collection.id) ?? [],
      updatedAt: collection.updated_at,
    }));
  }

  async get(id: string): Promise<CollectionDetails> {
    const collection = this.requireCollection(id);
    const rows = this.db.prepare(
      `SELECT book_id FROM collection_books
       WHERE collection_id = ?
       ORDER BY position, book_id`,
    ).all(id) as Array<{ book_id: string }>;
    if (rows.length <= 64) {
      return {
        id: collection.id,
        name: collection.name,
        createdAt: collection.created_at,
        updatedAt: collection.updated_at,
        books: rows.map(({ book_id }) => this.books.getBook(book_id)),
      };
    }
    const bookMap = new Map((await this.books.listBooks()).map((book) => [book.id, book]));
    return {
      id: collection.id,
      name: collection.name,
      createdAt: collection.created_at,
      updatedAt: collection.updated_at,
      books: rows.flatMap(({ book_id }) => {
        const item = bookMap.get(book_id);
        return item ? [item] : [];
      }),
    };
  }

  async create(rawName: string): Promise<CollectionDetails> {
    const name = CollectionNameSchema.parse(rawName);
    const normalized = normalizeCollectionName(name);
    const existing = this.db.prepare(
      "SELECT id FROM collections WHERE normalized_name = ?",
    ).get(normalized) as { id: string } | undefined;
    if (existing) return this.get(existing.id);

    const id = this.options.id();
    const now = this.options.now();
    this.db.prepare(
      `INSERT INTO collections(id, name, normalized_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, name, normalized, now, now);
    return this.get(id);
  }

  async resolveFolderImport(folderPath: string, rawName: string, bookIds: readonly string[]): Promise<CollectionDetails> {
    const path = normalizeImportFolderPath(folderPath);
    const alias = this.db.prepare(
      "SELECT collection_id FROM collection_import_aliases WHERE folder_path = ?",
    ).get(path) as { collection_id: string } | undefined;
    if (alias) return this.get(alias.collection_id);

    const name = CollectionNameSchema.parse(rawName);
    const exact = this.db.prepare(
      "SELECT id FROM collections WHERE normalized_name = ?",
    ).get(normalizeCollectionName(name)) as { id: string } | undefined;
    const matchedId = exact?.id ?? this.findMatchingCollection(bookIds);
    const collection = matchedId ? await this.get(matchedId) : await this.create(name);
    this.db.prepare(
      "INSERT INTO collection_import_aliases(folder_path, collection_id) VALUES (?, ?)",
    ).run(path, collection.id);
    return collection;
  }

  private findMatchingCollection(bookIds: readonly string[]): string | undefined {
    const unique = [...new Set(bookIds)];
    if (unique.length === 0 || unique.length > 900) return undefined;
    const placeholders = unique.map(() => "?").join(",");
    const candidates = this.db.prepare(
      `SELECT cb.collection_id AS id, COUNT(*) AS matching,
         (SELECT COUNT(*) FROM collection_books WHERE collection_id = cb.collection_id) AS total
       FROM collection_books cb
       WHERE cb.book_id IN (${placeholders})
       GROUP BY cb.collection_id`,
    ).all(...unique) as Array<{ id: string; matching: number; total: number }>;
    const eligible = candidates
      .map((item) => ({ id: item.id, score: item.matching / (item.total + unique.length - item.matching) }))
      .filter((item) => item.score >= 0.8)
      .sort((left, right) => right.score - left.score);
    if (eligible.length === 0 || (eligible[1] && eligible[0]!.score - eligible[1].score < 0.05)) {
      return undefined;
    }
    return eligible[0]!.id;
  }

  async rename(id: string, rawName: string): Promise<CollectionDetails> {
    this.requireCollection(id);
    const name = CollectionNameSchema.parse(rawName);
    const normalized = normalizeCollectionName(name);
    const collision = this.db.prepare(
      "SELECT id FROM collections WHERE normalized_name = ? AND id <> ?",
    ).get(normalized, id) as { id: string } | undefined;
    if (collision) throw new ReaderError("INVALID_REQUEST", "已经存在同名珍藏。");

    this.db.prepare(
      "UPDATE collections SET name = ?, normalized_name = ?, updated_at = ? WHERE id = ?",
    ).run(name, normalized, this.options.now(), id);
    return this.get(id);
  }

  delete(id: string): void {
    this.requireCollection(id);
    this.db.prepare("DELETE FROM collections WHERE id = ?").run(id);
  }

  async addBooks(id: string, bookIds: readonly string[]): Promise<CollectionDetails> {
    this.requireCollection(id);
    this.assertBooksExist(bookIds);
    const now = this.options.now();
    const transaction = this.db.transaction(() => {
      let position = (this.db.prepare(
        "SELECT COALESCE(MAX(position), -1) AS position FROM collection_books WHERE collection_id = ?",
      ).get(id) as { position: number }).position + 1;
      const insert = this.db.prepare(
        `INSERT INTO collection_books(collection_id, book_id, position, added_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(collection_id, book_id) DO NOTHING`,
      );
      let inserted = 0;
      for (const bookId of bookIds) {
        const result = insert.run(id, bookId, position, now);
        if (result.changes > 0) {
          position += 1;
          inserted += 1;
        }
      }
      if (inserted > 0) {
        this.db.prepare("UPDATE collections SET updated_at = ? WHERE id = ?").run(now, id);
      }
    });
    transaction();
    return this.get(id);
  }

  async removeBooks(id: string, bookIds: readonly string[]): Promise<CollectionDetails> {
    this.requireCollection(id);
    const transaction = this.db.transaction(() => {
      const remove = this.db.prepare(
        "DELETE FROM collection_books WHERE collection_id = ? AND book_id = ?",
      );
      let removed = 0;
      for (const bookId of bookIds) removed += remove.run(id, bookId).changes;
      if (removed === 0) return;
      this.compactPositions(id);
      this.db.prepare("UPDATE collections SET updated_at = ? WHERE id = ?")
        .run(this.options.now(), id);
    });
    transaction();
    return this.get(id);
  }

  async reorder(id: string, bookIds: readonly string[]): Promise<CollectionDetails> {
    this.requireCollection(id);
    const currentIds = (this.db.prepare(
      "SELECT book_id FROM collection_books WHERE collection_id = ? ORDER BY position, book_id",
    ).all(id) as Array<{ book_id: string }>).map(({ book_id }) => book_id);
    const currentSet = [...currentIds].sort();
    const requestedSet = [...bookIds].sort();
    if (
      new Set(bookIds).size !== bookIds.length
      || currentSet.length !== requestedSet.length
      || currentSet.some((bookId, index) => bookId !== requestedSet[index])
    ) {
      throw new ReaderError("INVALID_REQUEST", "珍藏成员已变化，请刷新后重试。");
    }

    const transaction = this.db.transaction(() => {
      const update = this.db.prepare(
        "UPDATE collection_books SET position = ? WHERE collection_id = ? AND book_id = ?",
      );
      bookIds.forEach((bookId, position) => update.run(position, id, bookId));
      this.db.prepare("UPDATE collections SET updated_at = ? WHERE id = ?")
        .run(this.options.now(), id);
    });
    transaction();
    return this.get(id);
  }

  getMemberships(bookIds: readonly string[]): CollectionMembership[] {
    if (bookIds.length === 0) return [];
    const placeholders = bookIds.map(() => "?").join(",");
    const rows = this.db.prepare(
      `SELECT collection_id, book_id
       FROM collection_books
       WHERE book_id IN (${placeholders})
       ORDER BY collection_id, position, book_id`,
    ).all(...bookIds) as Array<{ collection_id: string; book_id: string }>;
    const grouped = new Map<string, Set<string>>();
    for (const row of rows) {
      const current = grouped.get(row.collection_id) ?? new Set<string>();
      current.add(row.book_id);
      grouped.set(row.collection_id, current);
    }
    return [...grouped].map(([collectionId, members]) => ({
      collectionId,
      bookIds: bookIds.filter((bookId) => members.has(bookId)),
    }));
  }

  async listUnorganized(): Promise<BookSummary[]> {
    const rows = this.db.prepare(
      `SELECT b.id FROM books b
       WHERE NOT EXISTS (
         SELECT 1 FROM collection_books cb WHERE cb.book_id = b.id
       )`,
    ).all() as Array<{ id: string }>;
    const wanted = new Set(rows.map(({ id }) => id));
    return (await this.books.listBooks()).filter(({ id }) => wanted.has(id));
  }

  private requireCollection(id: string): CollectionRow {
    const row = this.db.prepare(
      "SELECT id, name, created_at, updated_at FROM collections WHERE id = ?",
    ).get(id) as CollectionRow | undefined;
    if (!row) throw new ReaderError("INVALID_REQUEST", "珍藏不存在。");
    return row;
  }

  private assertBooksExist(bookIds: readonly string[]) {
    if (bookIds.length === 0 || new Set(bookIds).size !== bookIds.length) {
      throw new ReaderError("INVALID_REQUEST", "请选择有效且不重复的书籍。");
    }
    const placeholders = bookIds.map(() => "?").join(",");
    const row = this.db.prepare(
      `SELECT COUNT(*) AS count FROM books WHERE id IN (${placeholders})`,
    ).get(...bookIds) as { count: number };
    if (row.count !== bookIds.length) {
      throw new ReaderError("BOOK_NOT_FOUND", "有书籍已不在书架中。");
    }
  }

  private compactPositions(id: string) {
    const rows = this.db.prepare(
      "SELECT book_id FROM collection_books WHERE collection_id = ? ORDER BY position, book_id",
    ).all(id) as Array<{ book_id: string }>;
    const update = this.db.prepare(
      "UPDATE collection_books SET position = ? WHERE collection_id = ? AND book_id = ?",
    );
    rows.forEach(({ book_id }, position) => update.run(position, id, book_id));
  }
}
