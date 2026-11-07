export const librarianStatements = [
  `CREATE TABLE librarian_operations (
    id TEXT PRIMARY KEY,
    review_id TEXT NOT NULL,
    action_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('import','replace','recycle_duplicate','ignore')),
    book_id TEXT,
    candidate_path TEXT NOT NULL,
    prior_source_path TEXT,
    content_hash TEXT NOT NULL,
    reason TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK(outcome IN ('completed','failed')),
    created_at TEXT NOT NULL
  )`,
  "CREATE INDEX librarian_operations_created_idx ON librarian_operations(created_at DESC)",
] as const;
