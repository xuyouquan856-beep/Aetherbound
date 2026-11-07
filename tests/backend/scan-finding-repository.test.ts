import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type OpenedDatabase } from "../../src/backend/storage/database.js";
import { ScanFindingRepository } from "../../src/backend/library-scan/scan-finding-repository.js";
import { ScanJobRepository } from "../../src/backend/library-scan/scan-job-repository.js";
import { ReaderError } from "../../src/shared/errors.js";

describe("ScanFindingRepository & ScanJobRepository Strict Tests", () => {
  let tempDir: string;
  let opened: OpenedDatabase;
  let repo: ScanFindingRepository;
  let jobRepo: ScanJobRepository;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "reader-finding-repo-test-"));
    opened = openDatabase(tempDir);
    repo = new ScanFindingRepository(opened.db);
    jobRepo = new ScanJobRepository(opened.db);

    opened.db.prepare("INSERT INTO library_roots(id, root_path, display_name, created_at, updated_at) VALUES ('r1', 'C:\\test', 'Test', 'now', 'now')").run();
    opened.db.prepare("INSERT INTO library_roots(id, root_path, display_name, created_at, updated_at) VALUES ('r2', 'C:\\test2', 'Test2', 'now', 'now')").run();
    opened.db.prepare("INSERT INTO scan_jobs(id, root_id, state, phase, cursor_json, counters_json, started_at, last_heartbeat_at) VALUES ('j1', 'r1', 'completed', 'local_resolution', '{}', '{}', 'now', 'now')").run();
  });

  afterEach(async () => {
    opened.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("upserts exact_duplicate evidence with discriminated union", () => {
    const f = repo.upsertFinding({
      rootId: "r1",
      jobId: "j1",
      kind: "exact_duplicate",
      status: "new",
      confidence: 1.0,
      candidateIds: ["cand-a", "cand-b"],
      evidence: {
        kind: "exact_duplicate",
        evidenceVersion: 1,
        algorithm: "sha256",
        fullContentHash: "a".repeat(64),
        survivorInventoryId: "cand-a",
        volumeConflict: false,
        ruleCodes: ["exact_hash"],
      },
      now: "2026-07-24T00:00:00Z",
    });
    expect(f.evidence.kind).toBe("exact_duplicate");
    expect(f.candidateIds).toEqual(["cand-a", "cand-b"]);
  });

  it("upserts series_volume evidence with discriminated union", () => {
    const f = repo.upsertFinding({
      rootId: "r1",
      jobId: "j1",
      kind: "series_volume",
      status: "new",
      confidence: 0.9,
      candidateIds: ["cand-c"],
      evidence: {
        kind: "series_volume",
        evidenceVersion: 1,
        normalizedSeries: "魔王城",
        volumeLabel: "第1卷",
        volumeIndex: 1,
        ruleCodes: ["series_regex"],
      },
      now: "2026-07-24T00:00:00Z",
    });
    expect(f.evidence.kind).toBe("series_volume");
  });

  it("upserts edition_variant evidence with discriminated union", () => {
    const f = repo.upsertFinding({
      rootId: "r1",
      jobId: "j1",
      kind: "edition_variant",
      status: "new",
      confidence: 0.8,
      candidateIds: ["cand-d"],
      evidence: {
        kind: "edition_variant",
        evidenceVersion: 1,
        normalizedTitle: "测试书",
        variantSignals: ["精校版"],
        ruleCodes: ["variant_match"],
      },
      now: "2026-07-24T00:00:00Z",
    });
    expect(f.evidence.kind).toBe("edition_variant");
  });

  it("rejects evidence when kind and evidence structure mismatch", () => {
    expect(() =>
      repo.upsertFinding({
        rootId: "r1",
        jobId: "j1",
        kind: "exact_duplicate",
        status: "new",
        confidence: 1.0,
        candidateIds: ["c1"],
        evidence: {
          kind: "series_volume" as any, // Mismatched kind discriminator
          evidenceVersion: 1,
          normalizedSeries: "series",
          volumeLabel: null,
          volumeIndex: null,
          ruleCodes: [],
        },
        now: "now",
      })
    ).toThrow();
  });

  it("rejects candidate IDs containing absolute paths", () => {
    expect(() =>
      repo.upsertFinding({
        rootId: "r1",
        jobId: "j1",
        kind: "exact_duplicate",
        status: "new",
        confidence: 1.0,
        candidateIds: ["C:\\secret\\file.txt"],
        evidence: {
          kind: "exact_duplicate",
          evidenceVersion: 1,
          algorithm: "sha256",
          fullContentHash: "a".repeat(64),
          survivorInventoryId: "cand-a",
          volumeConflict: false,
          ruleCodes: [],
        },
        now: "now",
      })
    ).toThrow();
  });

  it("rejects corrupt evidence JSON on read", () => {
    opened.db.prepare(`
      INSERT INTO scan_findings (
        id, root_id, job_id, finding_key, kind, status, confidence, evidence_json, candidate_ids_json, created_at
      ) VALUES ('corrupt-1', 'r1', 'j1', 'key1', 'exact_duplicate', 'new', 1.0, '{"bad": true}', '["cand-1"]', 'now')
    `).run();

    expect(() => repo.getFinding("corrupt-1")).toThrow();
  });

  it("enforces bounded limit, offset, and stable ordering in listByRoot", () => {
    // Insert 60 findings
    for (let i = 0; i < 60; i++) {
      const id = `f-${i.toString().padStart(3, "0")}`;
      const key = `exact_duplicate:c-${i}`;
      const time = `2026-07-24T00:${Math.floor(i / 60).toString().padStart(2, "0")}:${(i % 60).toString().padStart(2, "0")}:00Z`;
      opened.db.prepare(`
        INSERT INTO scan_findings (
          id, root_id, job_id, finding_key, kind, status, confidence, evidence_json, candidate_ids_json, created_at
        ) VALUES (?, 'r1', 'j1', ?, 'exact_duplicate', 'new', 1.0, ?, '["cand-1"]', ?)
      `).run(
        id,
        key,
        JSON.stringify({
          kind: "exact_duplicate",
          evidenceVersion: 1,
          algorithm: "sha256",
          fullContentHash: "a".repeat(64),
          survivorInventoryId: "cand-1",
          volumeConflict: false,
          ruleCodes: [],
        }),
        time
      );
    }

    // Default limit should be 50
    const page1 = repo.listByRoot("r1");
    expect(page1.length).toBe(50);

    // Limit override
    const pageSmall = repo.listByRoot("r1", { limit: 10, offset: 0 });
    expect(pageSmall.length).toBe(10);

    // Filter by root (r2 should be empty)
    const pageRoot2 = repo.listByRoot("r2");
    expect(pageRoot2.length).toBe(0);
  });

  it("prevents state machine from resetting terminal status", () => {
    const f1 = repo.upsertFinding({
      rootId: "r1",
      jobId: "j1",
      kind: "exact_duplicate",
      status: "new",
      confidence: 1.0,
      candidateIds: ["cand-1"],
      evidence: {
        kind: "exact_duplicate",
        evidenceVersion: 1,
        algorithm: "sha256",
        fullContentHash: "b".repeat(64),
        survivorInventoryId: "cand-1",
        volumeConflict: false,
        ruleCodes: ["exact_hash"],
      },
      now: "2026-07-24T00:00:00Z",
    });

    repo.updateStatus(f1.id, "auto_applied", "2026-07-24T00:01:00Z");

    const f2 = repo.upsertFinding({
      rootId: "r1",
      jobId: "j1",
      kind: "exact_duplicate",
      status: "new",
      confidence: 1.0,
      candidateIds: ["cand-1"],
      evidence: {
        kind: "exact_duplicate",
        evidenceVersion: 1,
        algorithm: "sha256",
        fullContentHash: "b".repeat(64),
        survivorInventoryId: "cand-1",
        volumeConflict: false,
        ruleCodes: ["exact_hash"],
      },
      now: "2026-07-24T00:02:00Z",
    });

    expect(f2.status).toBe("auto_applied");
  });

  it("rejects invalid scan phase in ScanJobRepository", () => {
    opened.db.prepare("INSERT INTO scan_jobs(id, root_id, state, phase, cursor_json, counters_json, started_at, last_heartbeat_at) VALUES ('j-bad', 'r1', 'running', 'inventory', '{}', '{}', 'now', 'now')").run();

    opened.db.pragma("ignore_check_constraints = ON");
    opened.db.prepare("UPDATE scan_jobs SET phase = 'invalid_phase' WHERE id = 'j-bad'").run();

    expect(() => jobRepo.get("j-bad")).toThrow(ReaderError);
  });
});
