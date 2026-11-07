/**
 * FTS5 cannot index an UNINDEXED book_id column. The old cleanup trigger scanned
 * every FTS row whenever a book was removed, blocking the Electron main thread.
 * This compact lookup records existing FTS rowids once and keeps future inserts
 * addressable by book_id without rebuilding the multi-gigabyte FTS index.
 */
export const fastFulltextRemovalStatements = [
  `CREATE TABLE book_content_fts_rows (
    fts_rowid INTEGER PRIMARY KEY,
    book_id TEXT NOT NULL
  )`,
  "CREATE INDEX book_content_fts_rows_book_idx ON book_content_fts_rows(book_id)",
  `INSERT INTO book_content_fts_rows(fts_rowid, book_id)
   SELECT rowid, book_id FROM book_content_fts`,
  "DROP TRIGGER book_content_fts_cleanup",
  `CREATE TRIGGER book_content_fts_cleanup
   BEFORE DELETE ON books
   BEGIN
     DELETE FROM book_content_fts
       WHERE rowid IN (SELECT fts_rowid FROM book_content_fts_rows WHERE book_id = OLD.id);
     DELETE FROM book_content_fts_rows WHERE book_id = OLD.id;
   END`,
] as const;
