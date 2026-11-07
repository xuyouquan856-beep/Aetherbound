export const fts5SearchStatements = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS book_search_idx USING fts5(
    book_id UNINDEXED,
    title,
    author,
    aliases,
    series_names,
    volume_label,
    format,
    tokenize='unicode61 remove_diacritics 2'
  )`,
  `INSERT INTO book_search_idx(book_id, title, author, aliases, series_names, volume_label, format)
   SELECT
     b.id, b.title, '',
     COALESCE((SELECT GROUP_CONCAT(a.alias, ' ') FROM book_aliases a WHERE a.book_id = b.id), ''),
     COALESCE((SELECT GROUP_CONCAT(s.name, ' ') FROM series_books sb JOIN series s ON s.id = sb.series_id WHERE sb.book_id = b.id), ''),
     COALESCE((SELECT sb2.volume_label FROM series_books sb2 WHERE sb2.book_id = b.id LIMIT 1), ''),
     b.format
   FROM books b`,
  `CREATE TABLE IF NOT EXISTS trash_records (
    id TEXT PRIMARY KEY,
    book_id TEXT,
    original_path TEXT NOT NULL,
    trash_path TEXT NOT NULL UNIQUE,
    file_size INTEGER,
    content_hash TEXT,
    deleted_at TEXT NOT NULL,
    restored_at TEXT
  )`,
] as const;
