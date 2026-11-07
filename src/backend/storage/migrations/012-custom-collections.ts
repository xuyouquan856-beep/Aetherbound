export const customCollectionStatements = [
  `CREATE TABLE collections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    normalized_name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE collection_books (
    collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK(position >= 0),
    added_at TEXT NOT NULL,
    PRIMARY KEY (collection_id, book_id)
  )`,
  `CREATE INDEX collection_books_collection_position_idx
    ON collection_books(collection_id, position, book_id)`,
  `CREATE INDEX collection_books_book_idx
    ON collection_books(book_id, collection_id)`,
] as const;
