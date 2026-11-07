import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { ScanFindingEvidence, ScanFindingKind, ScanFindingStatus } from "../../shared/contracts.js";
import { ScanFindingCandidateIdsSchema, ScanFindingEvidenceSchema, ScanFindingStatusSchema } from "../../shared/contracts.js";
import { ReaderError } from "../../shared/errors.js";

export type ScanFindingRecord = {
  id: string;
  rootId: string;
  jobId: string;
  findingKey: string;
  kind: ScanFindingKind;
  status: ScanFindingStatus;
  confidence: number;
  evidence: ScanFindingEvidence;
  candidateIds: string[];
  createdAt: string;
  resolvedAt: string | null;
};

export type UpsertFindingInput = {
  rootId: string;
  jobId: string;
  kind: ScanFindingKind;
  status: ScanFindingStatus;
  confidence: number;
  candidateIds: string[];
  evidence: ScanFindingEvidence;
  now: string;
};

export type ListFindingsOptions = {
  limit?: number;
  offset?: number;
  /**
   * Include findings the user already acted on. Defaults to false: `stale`, `rejected`
   * and `auto_applied` rows are history, and mixing them into the review list by
   * default would bury the handful of decisions actually waiting.
   */
  includeResolved?: boolean;
  /** Restrict to one kind, so each review tab asks for its own queue. */
  kind?: ScanFindingKind;
};

const TERMINAL_STATUSES = new Set<ScanFindingStatus>(["auto_applied", "rejected", "stale"]);

/** Statuses that still need the user to decide something. */
const OPEN_STATUSES: ScanFindingStatus[] = ["new", "needs_review", "accepted"];

export function generateFindingKey(kind: ScanFindingKind, candidateIds: string[]): string {
  const sorted = [...new Set(candidateIds)].sort();
  return `${kind}:${sorted.join(",")}`;
}

export class ScanFindingRepository {
  constructor(private readonly db: Database.Database) {}

  upsertFinding(input: UpsertFindingInput): ScanFindingRecord {
    const validatedCandidateIds = ScanFindingCandidateIdsSchema.parse(input.candidateIds);
    const validatedEvidence = ScanFindingEvidenceSchema.parse(input.evidence);
    const validatedStatus = ScanFindingStatusSchema.parse(input.status);

    if (input.kind !== validatedEvidence.kind) {
      throw new ReaderError("INVALID_REQUEST", `Finding kind '${input.kind}' does not match evidence kind '${validatedEvidence.kind}'`);
    }

    const findingKey = generateFindingKey(input.kind, validatedCandidateIds);
    const existing = this.db.prepare(
      "SELECT * FROM scan_findings WHERE root_id = ? AND finding_key = ?"
    ).get(input.rootId, findingKey) as {
      id: string;
      root_id: string;
      job_id: string;
      finding_key: string;
      kind: ScanFindingKind;
      status: ScanFindingStatus;
      confidence: number;
      evidence_json: string;
      candidate_ids_json: string;
      created_at: string;
      resolved_at: string | null;
    } | undefined;

    if (existing) {
      const currentStatus = ScanFindingStatusSchema.parse(existing.status);
      const nextStatus = TERMINAL_STATUSES.has(currentStatus) ? currentStatus : validatedStatus;
      this.db.prepare(`
        UPDATE scan_findings
        SET job_id = ?, status = ?, confidence = ?, evidence_json = ?, candidate_ids_json = ?
        WHERE id = ?
      `).run(
        input.jobId,
        nextStatus,
        input.confidence,
        JSON.stringify(validatedEvidence),
        JSON.stringify([...new Set(validatedCandidateIds)].sort()),
        existing.id
      );

      return this.getFinding(existing.id)!;
    }

    const id = randomUUID();
    const candidateIdsSorted = [...new Set(validatedCandidateIds)].sort();
    this.db.prepare(`
      INSERT INTO scan_findings (
        id, root_id, job_id, finding_key, kind, status, confidence, evidence_json, candidate_ids_json, created_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      id,
      input.rootId,
      input.jobId,
      findingKey,
      input.kind,
      validatedStatus,
      input.confidence,
      JSON.stringify(validatedEvidence),
      JSON.stringify(candidateIdsSorted),
      input.now
    );

    return this.getFinding(id)!;
  }

  updateStatus(id: string, nextStatus: ScanFindingStatus, now: string): void {
    const current = this.getFinding(id);
    if (!current) throw new ReaderError("INVALID_REQUEST", "Finding not found");

    const validatedNext = ScanFindingStatusSchema.parse(nextStatus);

    if (TERMINAL_STATUSES.has(current.status) && validatedNext !== current.status) {
      throw new ReaderError("INVALID_REQUEST", `Cannot transition from terminal state '${current.status}' to '${validatedNext}'`);
    }

    const resolvedAt = TERMINAL_STATUSES.has(validatedNext) ? now : null;
    this.db.prepare("UPDATE scan_findings SET status = ?, resolved_at = ? WHERE id = ?").run(validatedNext, resolvedAt, id);
  }

  getFinding(id: string): ScanFindingRecord | null {
    const row = this.db.prepare("SELECT * FROM scan_findings WHERE id = ?").get(id) as {
      id: string;
      root_id: string;
      job_id: string;
      finding_key: string;
      kind: ScanFindingKind;
      status: ScanFindingStatus;
      confidence: number;
      evidence_json: string;
      candidate_ids_json: string;
      created_at: string;
      resolved_at: string | null;
    } | undefined;

    if (!row) return null;

    let evidenceRaw: unknown;
    let candidateIdsRaw: unknown;
    try {
      evidenceRaw = JSON.parse(row.evidence_json);
      candidateIdsRaw = JSON.parse(row.candidate_ids_json);
    } catch {
      throw new ReaderError("DATABASE_ERROR", "FINDING_JSON_CORRUPT");
    }

    const evidence = ScanFindingEvidenceSchema.parse(evidenceRaw);
    const candidateIds = ScanFindingCandidateIdsSchema.parse(candidateIdsRaw);
    const status = ScanFindingStatusSchema.parse(row.status);

    return {
      id: row.id,
      rootId: row.root_id,
      jobId: row.job_id,
      findingKey: row.finding_key,
      kind: row.kind,
      status,
      confidence: row.confidence,
      evidence,
      candidateIds,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
    };
  }

  listByRoot(rootId: string, options: ListFindingsOptions = {}): ScanFindingRecord[] {
    const limit = Math.max(1, Math.min(options.limit ?? 50, 500));
    const offset = Math.max(0, options.offset ?? 0);
    const filters: string[] = [];
    const params: unknown[] = [];
    if (!options.includeResolved) {
      filters.push(`status IN (${OPEN_STATUSES.map(() => "?").join(",")})`);
      params.push(...OPEN_STATUSES);
    }
    if (options.kind) {
      filters.push("kind = ?");
      params.push(options.kind);
    }
    const clause = filters.length > 0 ? ` AND ${filters.join(" AND ")}` : "";

    const rows = this.db.prepare(
      `SELECT id FROM scan_findings WHERE root_id = ?${clause}
       ORDER BY created_at DESC, id ASC LIMIT ? OFFSET ?`,
    ).all(rootId, ...params, limit, offset) as { id: string }[];

    return rows.map((r) => this.getFinding(r.id)!);
  }

  countByRoot(
    rootId: string,
    options: { includeResolved?: boolean; kind?: ScanFindingKind } = {},
  ): number {
    const filters: string[] = [];
    const params: unknown[] = [];
    if (!options.includeResolved) {
      filters.push(`status IN (${OPEN_STATUSES.map(() => "?").join(",")})`);
      params.push(...OPEN_STATUSES);
    }
    if (options.kind) {
      filters.push("kind = ?");
      params.push(options.kind);
    }
    const clause = filters.length > 0 ? ` AND ${filters.join(" AND ")}` : "";
    const row = this.db.prepare(
      `SELECT COUNT(*) AS count FROM scan_findings WHERE root_id = ?${clause}`,
    ).get(rootId, ...params) as { count: number };
    return row.count;
  }

  /** Ids of every open finding of one kind, for a queue-wide action. */
  listOpenIds(rootId: string, kind: ScanFindingKind, limit = 500): string[] {
    const rows = this.db.prepare(
      `SELECT id FROM scan_findings
       WHERE root_id = ? AND kind = ? AND status IN (${OPEN_STATUSES.map(() => "?").join(",")})
       ORDER BY created_at ASC, id ASC LIMIT ?`,
    ).all(rootId, kind, ...OPEN_STATUSES, Math.max(1, Math.min(limit, 2000))) as { id: string }[];
    return rows.map((row) => row.id);
  }
}
