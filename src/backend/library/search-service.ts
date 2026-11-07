import Database from "better-sqlite3";

export interface SearchResult {
  bookId: string;
  title: string;
  author: string | null;
  format: string;
  matchSnippet: string;
}

export class LibrarySearchService {
  constructor(private readonly db: Database.Database) {}

  search(query: string, limit: number = 20, offset: number = 0): SearchResult[] {
    if (!query.trim()) return [];
    const safeLimit = Math.max(1, Math.min(limit, 100));
    const safeOffset = Math.max(0, offset);
    if (isCjkShortQuery(query)) return this.likeSearch(query, safeLimit, safeOffset);
    return this.fts5Search(query, safeLimit, safeOffset);
  }

  indexBook(bookId: string): void {
    this.db.prepare("DELETE FROM book_search_idx WHERE book_id = ?").run(bookId);
    this.db.prepare(`
      INSERT INTO book_search_idx(book_id, title, author, aliases, series_names, volume_label, format)
      SELECT b.id, b.title, '',
        COALESCE((SELECT GROUP_CONCAT(a.alias, ' ') FROM book_aliases a WHERE a.book_id = b.id), ''),
        COALESCE((SELECT GROUP_CONCAT(s.name, ' ') FROM series_books sb JOIN series s ON s.id = sb.series_id WHERE sb.book_id = b.id), ''),
        COALESCE((SELECT sb2.volume_label FROM series_books sb2 WHERE sb2.book_id = b.id LIMIT 1), ''),
        b.format
      FROM books b WHERE b.id = ?
    `).run(bookId);
  }

  removeBook(bookId: string): void {
    this.db.prepare("DELETE FROM book_search_idx WHERE book_id = ?").run(bookId);
  }

  reindexAll(): void {
    this.db.exec("DELETE FROM book_search_idx");
    this.db.exec(`
      INSERT INTO book_search_idx(book_id, title, author, aliases, series_names, volume_label, format)
      SELECT b.id, b.title, '',
        COALESCE((SELECT GROUP_CONCAT(a.alias, ' ') FROM book_aliases a WHERE a.book_id = b.id), ''),
        COALESCE((SELECT GROUP_CONCAT(s.name, ' ') FROM series_books sb JOIN series s ON s.id = sb.series_id WHERE sb.book_id = b.id), ''),
        COALESCE((SELECT sb2.volume_label FROM series_books sb2 WHERE sb2.book_id = b.id LIMIT 1), ''),
        b.format
      FROM books b
    `);
  }

  private fts5Search(query: string, limit: number, offset: number): SearchResult[] {
    const ftsQuery = escapeFts5(query);
    const rows = this.db.prepare(`
      SELECT book_id, title, author, format,
             snippet(book_search_idx, 1, '<b>', '</b>', '...', 32) AS matchSnippet
      FROM book_search_idx WHERE book_search_idx MATCH ?
      ORDER BY rank LIMIT ? OFFSET ?
    `).all(ftsQuery, limit, offset) as { book_id: string; title: string; author: string; format: string; matchSnippet: string }[];
    return rows.map(mapRow);
  }

  private likeSearch(query: string, limit: number, offset: number): SearchResult[] {
    const pattern = `%${query}%`;
    const rows = this.db.prepare(`
      SELECT book_id, title, author, format,
             substr(title, 1, 200) AS matchSnippet
      FROM book_search_idx
      WHERE title LIKE ? OR author LIKE ? OR aliases LIKE ? OR series_names LIKE ?
      ORDER BY title LIMIT ? OFFSET ?
    `).all(pattern, pattern, pattern, pattern, limit, offset) as { book_id: string; title: string; author: string; format: string; matchSnippet: string }[];
    return rows.map(mapRow);
  }
}

const mapRow = (r: { book_id: string; title: string; author: string; format: string; matchSnippet: string }): SearchResult => ({
  bookId: r.book_id, title: r.title, author: r.author || null, format: r.format, matchSnippet: r.matchSnippet,
});

const isCjkShortQuery = (q: string): boolean => {
  const cjk = q.replace(/[\x00-\x7F]/g, "");
  return cjk.length > 0 && cjk.length <= 2;
};

const escapeFts5 = (q: string): string => {
  const escaped = q.replace(/["*^()]/g, "").trim();
  if (!escaped) return '""';
  return escaped.split(/\s+/).filter(Boolean).map((t) => `"${t}"`).join(" ");
};
