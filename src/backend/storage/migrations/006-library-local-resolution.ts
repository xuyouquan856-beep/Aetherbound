export const libraryLocalResolutionStatements = [
  `ALTER TABLE file_inventory ADD COLUMN metadata_state TEXT NOT NULL DEFAULT 'pending' CHECK(metadata_state IN ('pending','ready','error'))`,
  `ALTER TABLE file_inventory ADD COLUMN resolution_state TEXT NOT NULL DEFAULT 'pending' CHECK(resolution_state IN ('pending','ready','error'))`,
  `ALTER TABLE file_inventory ADD COLUMN metadata_error_code TEXT`,
  `ALTER TABLE file_inventory ADD COLUMN resolution_error_code TEXT`,

  `CREATE TABLE IF NOT EXISTS scan_findings (
    id TEXT PRIMARY KEY,
    root_id TEXT NOT NULL REFERENCES library_roots(id) ON DELETE CASCADE,
    job_id TEXT NOT NULL REFERENCES scan_jobs(id) ON DELETE CASCADE,
    finding_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('exact_duplicate','series_volume','edition_variant')),
    status TEXT NOT NULL CHECK(status IN ('new','auto_applied','needs_review','accepted','rejected','stale')),
    confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
    evidence_json TEXT NOT NULL,
    candidate_ids_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    UNIQUE(root_id, finding_key)
  )`,

  `CREATE INDEX IF NOT EXISTS scan_findings_root_status_idx ON scan_findings(root_id, status, kind, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS scan_findings_job_idx ON scan_findings(job_id, kind, status)`,
] as const;
