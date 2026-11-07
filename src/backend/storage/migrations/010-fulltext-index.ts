export const fulltextIndexStatements = [
  `CREATE TABLE book_text_units (
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    unit_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    char_count INTEGER NOT NULL,
    PRIMARY KEY (book_id, unit_index)
  )`,
  `CREATE VIRTUAL TABLE book_content_fts USING fts5(
    book_id UNINDEXED,
    unit_index UNINDEXED,
    content,
    tokenize='unicode61 remove_diacritics 2'
  )`,
  `CREATE TABLE book_index_state (
    book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
    source_revision TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','indexing','ready','error')),
    indexed_units INTEGER NOT NULL DEFAULT 0,
    total_units INTEGER NOT NULL DEFAULT 0,
    error_code TEXT,
    updated_at TEXT NOT NULL
  )`,
  // Clean up FTS when book is deleted (CASCADE handles book_text_units and book_index_state)
  `CREATE TRIGGER IF NOT EXISTS book_content_fts_cleanup
   AFTER DELETE ON books
   BEGIN
     DELETE FROM book_content_fts WHERE book_id = OLD.id;
   END`,
] as const;
