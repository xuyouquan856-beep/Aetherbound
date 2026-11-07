export const CJK_FULLTEXT_MIGRATION_VERSION = 14;

/**
 * `book_content_fts` was created with `unicode61`, which treats every run of CJK
 * characters as ONE token. Measured against SQLite 3.53:
 *
 *   content "第一章风起云涌少年出山"  ->  token "第一章风起云涌少年出山"
 *   query   "风起"                    ->  0 hits
 *
 * Novels in this app's target audience are written without spaces between words,
 * so a substring query could never match anything. Switching to `trigram` makes
 * substring search work for both CJK and Latin text.
 *
 * The index is a derived cache, so rebuilding it is cheaper and safer than trying
 * to migrate rows. Index states are reset so the indexer re-derives them.
 */
export const cjkFulltextStatements = [
  "DROP TABLE IF EXISTS book_content_fts",
  `CREATE VIRTUAL TABLE book_content_fts USING fts5(
    book_id UNINDEXED,
    unit_index UNINDEXED,
    content,
    tokenize='trigram'
  )`,
  // The deletion trigger from migration 010 was dropped with its table.
  `CREATE TRIGGER IF NOT EXISTS book_content_fts_cleanup
   AFTER DELETE ON books
   BEGIN
     DELETE FROM book_content_fts WHERE book_id = OLD.id;
   END`,
  // Short queries fall back to LIKE on this table, so it needs a book_id index.
  "CREATE INDEX IF NOT EXISTS book_text_units_book_idx ON book_text_units(book_id)",
  "UPDATE book_index_state SET state = 'pending', indexed_units = 0",
] as const;
