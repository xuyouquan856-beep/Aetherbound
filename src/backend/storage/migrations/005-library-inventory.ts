export const libraryInventoryStatements = [
  `CREATE TABLE library_roots (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    root_path TEXT NOT NULL UNIQUE,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE scan_jobs (
    id TEXT PRIMARY KEY,
    root_id TEXT NOT NULL REFERENCES library_roots(id) ON DELETE CASCADE,
    state TEXT NOT NULL CHECK(state IN ('queued','running','paused','completed','cancelled','failed','recoverable')),
    phase TEXT NOT NULL CHECK(phase IN ('inventory','metadata','local_resolution','agent_resolution','apply')),
    cursor_json TEXT NOT NULL,
    counters_json TEXT NOT NULL,
    started_at TEXT NOT NULL,
    last_heartbeat_at TEXT NOT NULL,
    ended_at TEXT,
    error_code TEXT
  )`,
  `CREATE TABLE file_inventory (
    id TEXT PRIMARY KEY,
    root_id TEXT NOT NULL REFERENCES library_roots(id) ON DELETE CASCADE,
    relative_path TEXT NOT NULL,
    format TEXT NOT NULL CHECK(format IN ('txt','epub')),
    file_size INTEGER NOT NULL,
    modified_at TEXT NOT NULL,
    quick_fingerprint_version INTEGER,
    quick_fingerprint TEXT,
    full_content_hash_algorithm TEXT,
    full_content_hash TEXT,
    metadata_json TEXT,
    inventory_status TEXT NOT NULL CHECK(inventory_status IN ('cached','discovered','metadata_pending','error','missing')),
    last_error_code TEXT,
    last_seen_job_id TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE(root_id, relative_path)
  )`,
  "CREATE INDEX file_inventory_root_status_idx ON file_inventory(root_id,inventory_status,relative_path)",
  "CREATE INDEX file_inventory_quick_fingerprint_idx ON file_inventory(root_id,file_size,quick_fingerprint)",
  "CREATE INDEX file_inventory_full_hash_idx ON file_inventory(root_id,full_content_hash_algorithm,full_content_hash)",
  "CREATE INDEX scan_jobs_root_state_idx ON scan_jobs(root_id,state,last_heartbeat_at)",
] as const;
