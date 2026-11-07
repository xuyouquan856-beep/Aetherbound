export const initialStatements = [
  `CREATE TABLE books (
    id TEXT PRIMARY KEY,
    format TEXT NOT NULL CHECK(format = 'txt'),
    title TEXT NOT NULL,
    author TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE book_sources (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    source_path TEXT NOT NULL,
    quick_fingerprint_version INTEGER NOT NULL,
    quick_fingerprint TEXT NOT NULL,
    full_content_hash_algorithm TEXT,
    full_content_hash TEXT,
    file_size INTEGER NOT NULL,
    modified_at TEXT NOT NULL,
    source_revision TEXT NOT NULL UNIQUE,
    availability_status TEXT NOT NULL CHECK(availability_status IN ('available','unavailable')),
    verified_at TEXT NOT NULL
  )`,
  "CREATE UNIQUE INDEX book_sources_path_idx ON book_sources(source_path)",
  "CREATE INDEX book_sources_fingerprint_idx ON book_sources(quick_fingerprint)",
  `CREATE TABLE reading_progress (
    book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
    locator_version INTEGER NOT NULL,
    locator_json TEXT NOT NULL,
    source_revision TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE reading_sessions (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    source_revision TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('open','closed','recovered','abandoned')),
    started_at TEXT NOT NULL,
    last_heartbeat_at TEXT NOT NULL,
    ended_at TEXT,
    start_locator_json TEXT,
    last_locator_json TEXT,
    end_locator_json TEXT
  )`,
  "CREATE INDEX reading_sessions_state_idx ON reading_sessions(state,last_heartbeat_at)",
  `CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
] as const;
