import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import {
  LibraryScanCounters,
  LibraryScanCountersSchema,
  LibraryScanPhase,
  LibraryScanPhaseSchema,
  LibraryScanSnapshot,
  LibraryScanSnapshotSchema,
  LibraryScanState,
} from "../../shared/contracts.js";
import { ReaderError } from "../../shared/errors.js";
import { InternalScanJob, ScanJobPatch } from "./types.js";

type RawScanJobRow = {
  id: string;
  root_id: string;
  state: LibraryScanState;
  phase: string;
  cursor_json: string;
  counters_json: string;
  started_at: string;
  last_heartbeat_at: string;
  ended_at: string | null;
  error_code: string | null;
};

const ALLOWED_TRANSITIONS: Record<LibraryScanState, LibraryScanState[]> = {
  queued: ["running", "cancelled", "failed"],
  running: ["paused", "completed", "cancelled", "failed", "recoverable"],
  paused: ["running", "cancelled", "recoverable"],
  recoverable: ["running", "cancelled"],
  completed: [],
  cancelled: [],
  failed: [],
};

export class ScanJobRepository {
  constructor(private readonly db: Database.Database) {}

  private parseCounters(json: string): LibraryScanCounters {
    try {
      const parsed = JSON.parse(json);
      const res = LibraryScanCountersSchema.safeParse(parsed);
      if (!res.success) {
        throw new ReaderError("DATABASE_ERROR", "SCAN_COUNTERS_INVALID");
      }
      return res.data;
    } catch (cause) {
      if (cause instanceof ReaderError) throw cause;
      throw new ReaderError("DATABASE_ERROR", "SCAN_COUNTERS_INVALID");
    }
  }

  private mapRow(row: RawScanJobRow): InternalScanJob {
    let phase: LibraryScanPhase;
    try {
      phase = LibraryScanPhaseSchema.parse(row.phase);
    } catch {
      throw new ReaderError("DATABASE_ERROR", `INVALID_SCAN_JOB_PHASE: ${row.phase}`);
    }

    return {
      id: row.id,
      rootId: row.root_id,
      state: row.state,
      phase,
      cursorJson: row.cursor_json,
      counters: this.parseCounters(row.counters_json),
      startedAt: row.started_at,
      lastHeartbeatAt: row.last_heartbeat_at,
      endedAt: row.ended_at,
      errorCode: row.error_code,
    };
  }

  create(rootId: string, now: string): InternalScanJob {
    return this.db.transaction(() => {
      const active = this.getActiveForRoot(rootId);
      if (active) {
        throw new ReaderError("INVALID_REQUEST", `Active scan job already exists for root ${rootId}`);
      }

      const id = `scan-${randomUUID()}`;
      const cursorJson = JSON.stringify({ strategy: "restart-with-cache" });
      const initialCounters: LibraryScanCounters = {
        discovered: 0,
        supported: 0,
        cached: 0,
        queued: 0,
        processed: 0,
        skipped: 0,
        errors: 0,
        metadataTotal: 0,
        metadataProcessed: 0,
        metadataErrors: 0,
        resolutionTotal: 0,
        resolutionProcessed: 0,
        resolutionFindings: 0,
        resolutionRecycled: 0,
        agentTotal: 0,
        agentProcessed: 0,
        agentResolved: 0,
        agentPending: 0,
        seriesApplied: 0,
        seriesSkipped: 0,
      };
      const countersJson = JSON.stringify(initialCounters);

      this.db.prepare(
        `INSERT INTO scan_jobs (
          id, root_id, state, phase, cursor_json, counters_json,
          started_at, last_heartbeat_at
        ) VALUES (?, ?, 'queued', 'inventory', ?, ?, ?, ?)`,
      ).run(id, rootId, cursorJson, countersJson, now, now);

      const created = this.get(id);
      if (!created) throw new ReaderError("DATABASE_ERROR", "Failed to load created scan job");
      return created;
    })();
  }

  get(jobId: string): InternalScanJob | null {
    const row = this.db.prepare("SELECT * FROM scan_jobs WHERE id = ?").get(jobId) as RawScanJobRow | undefined;
    if (!row) return null;
    return this.mapRow(row);
  }

  getActiveForRoot(rootId: string): InternalScanJob | null {
    const row = this.db.prepare(
      "SELECT * FROM scan_jobs WHERE root_id = ? AND state IN ('queued', 'running', 'paused', 'recoverable') ORDER BY started_at DESC LIMIT 1",
    ).get(rootId) as RawScanJobRow | undefined;
    if (!row) return null;
    return this.mapRow(row);
  }

  getAnyActive(): InternalScanJob | null {
    const row = this.db.prepare(
      "SELECT * FROM scan_jobs WHERE state IN ('queued', 'running', 'paused', 'recoverable') ORDER BY started_at DESC LIMIT 1",
    ).get() as RawScanJobRow | undefined;
    if (!row) return null;
    return this.mapRow(row);
  }

  update(jobId: string, patch: ScanJobPatch): InternalScanJob {
    return this.db.transaction(() => {
      const current = this.get(jobId);
      if (!current) {
        throw new ReaderError("INVALID_REQUEST", `Scan job ${jobId} not found`);
      }

      if (patch.state && patch.state !== current.state) {
        const allowed = ALLOWED_TRANSITIONS[current.state];
        if (!allowed.includes(patch.state)) {
          throw new ReaderError("INVALID_REQUEST", `Invalid state transition from ${current.state} to ${patch.state}`);
        }
      }

      const nextState = patch.state ?? current.state;
      const nextPhase = patch.phase ?? current.phase;
      const nextCursorJson = patch.cursorJson ?? current.cursorJson;
      const nextCounters = patch.counters ?? current.counters;
      const nextLastHeartbeatAt = patch.lastHeartbeatAt ?? current.lastHeartbeatAt;
      const nextEndedAt = patch.endedAt !== undefined ? patch.endedAt : current.endedAt;
      const nextErrorCode = patch.errorCode !== undefined ? patch.errorCode : current.errorCode;

      this.db.prepare(
        `UPDATE scan_jobs SET
          state = ?,
          phase = ?,
          cursor_json = ?,
          counters_json = ?,
          last_heartbeat_at = ?,
          ended_at = ?,
          error_code = ?
        WHERE id = ?`,
      ).run(
        nextState,
        nextPhase,
        nextCursorJson,
        JSON.stringify(nextCounters),
        nextLastHeartbeatAt,
        nextEndedAt,
        nextErrorCode,
        jobId,
      );

      const updated = this.get(jobId);
      if (!updated) throw new ReaderError("DATABASE_ERROR", "Failed to reload updated scan job");
      return updated;
    })();
  }

  markInterruptedRecoverable(now: string): number {
    const result = this.db.prepare(
      "UPDATE scan_jobs SET state = 'recoverable', last_heartbeat_at = ? WHERE state IN ('running', 'paused')",
    ).run(now);
    return result.changes;
  }

  toPublicSnapshot(job: InternalScanJob, rootName: string): LibraryScanSnapshot {
    const raw = {
      jobId: job.id,
      rootName,
      state: job.state,
      phase: job.phase,
      counters: job.counters,
      startedAt: job.startedAt,
      updatedAt: job.lastHeartbeatAt,
      errorCode: job.errorCode,
    };
    return LibraryScanSnapshotSchema.parse(raw);
  }
}
