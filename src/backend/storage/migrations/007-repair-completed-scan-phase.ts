export const repairCompletedScanPhaseStatements = [
  `PRAGMA foreign_keys = OFF`,
  `CREATE TABLE scan_jobs_repaired (
    id TEXT PRIMARY KEY,
    root_id TEXT NOT NULL REFERENCES library_roots(id) ON DELETE CASCADE,
    state TEXT NOT NULL CHECK(state IN ('queued','running','paused','completed','cancelled','failed','recoverable')),
    phase TEXT NOT NULL CHECK(phase IN ('inventory','metadata','local_resolution','agent_resolution','apply','completed')),
    cursor_json TEXT NOT NULL,
    counters_json TEXT NOT NULL,
    started_at TEXT NOT NULL,
    last_heartbeat_at TEXT NOT NULL,
    ended_at TEXT,
    error_code TEXT
  )`,
  `INSERT INTO scan_jobs_repaired (
    id, root_id, state, phase, cursor_json, counters_json,
    started_at, last_heartbeat_at, ended_at, error_code
  ) SELECT
    id, root_id, state, phase, cursor_json, counters_json,
    started_at, last_heartbeat_at, ended_at, error_code
  FROM scan_jobs`,
  `DROP TABLE scan_jobs`,
  `ALTER TABLE scan_jobs_repaired RENAME TO scan_jobs`,
  `CREATE INDEX scan_jobs_root_state_idx ON scan_jobs(root_id,state,last_heartbeat_at)`,
  `PRAGMA foreign_keys = ON`,
] as const;
