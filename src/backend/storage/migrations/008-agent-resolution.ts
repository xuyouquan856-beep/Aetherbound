export const agentResolutionStatements = [
  `CREATE TABLE IF NOT EXISTS series (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    representative_book_id TEXT,
    source TEXT NOT NULL CHECK(source IN ('automatic','manual')),
    manual_lock INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS series_books (
    series_id TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,
    book_id TEXT NOT NULL,
    volume_index INTEGER,
    volume_label TEXT,
    confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
    source TEXT NOT NULL CHECK(source IN ('automatic','manual')),
    manual_lock INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (series_id, book_id)
  )`,
  `CREATE TABLE IF NOT EXISTS book_relations (
    left_book_id TEXT NOT NULL,
    right_book_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('same_work_different_edition','supersedes','translation_of','related')),
    confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
    source TEXT NOT NULL CHECK(source IN ('automatic','manual','agent')),
    manual_lock INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (left_book_id, right_book_id, kind)
  )`,
  `CREATE TABLE IF NOT EXISTS book_aliases (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    alias TEXT NOT NULL,
    normalized_alias TEXT NOT NULL,
    language TEXT,
    source TEXT NOT NULL CHECK(source IN ('automatic','agent','manual'))
  )`,
  `CREATE TABLE IF NOT EXISTS agent_operations (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    input_json TEXT NOT NULL,
    result_json TEXT,
    inverse_json TEXT,
    outcome TEXT NOT NULL CHECK(outcome IN ('executed','undone','failed')),
    created_at TEXT NOT NULL,
    undone_at TEXT
  )`,
] as const;
