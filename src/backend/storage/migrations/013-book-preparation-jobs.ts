export const bookPreparationStatements = [
  `CREATE TABLE book_preparation_jobs (
    book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
    source_revision TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('queued','preparing','ready','error')),
    priority TEXT NOT NULL CHECK(priority IN ('background','interactive')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
    error_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT
  )`,
  `CREATE INDEX book_preparation_queue_idx
    ON book_preparation_jobs(state, priority, created_at, book_id)`,
] as const;
