import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { z } from "zod";
import type { InventoryMetadata } from "../../shared/contracts.js";
import { InventoryMetadataSchema } from "../../shared/contracts.js";
import { InventoryDisposition, InventoryEntryInput } from "./types.js";

const InventoryProcessingStateSchema = z.enum(["pending", "ready", "error"]);
export type InventoryProcessingState = z.infer<typeof InventoryProcessingStateSchema>;

type InventoryRow = {
  id: string;
  root_id: string;
  relative_path: string;
  format: "txt" | "epub";
  file_size: number;
  modified_at: string;
  inventory_status: "cached" | "discovered" | "metadata_pending" | "error" | "missing";
  metadata_state?: string;
  resolution_state?: string;
  quick_fingerprint_version?: number | null;
  quick_fingerprint?: string | null;
  full_content_hash?: string | null;
  metadata_json?: string | null;
};

export type FileInventoryRecord = {
  id: string;
  rootId: string;
  relativePath: string;
  format: "txt" | "epub";
  fileSize: number;
  modifiedAt: string;
  inventoryStatus: "cached" | "discovered" | "metadata_pending" | "error" | "missing";
  metadataState: InventoryProcessingState;
  resolutionState: InventoryProcessingState;
  quickFingerprintVersion: number | null;
  quickFingerprint: string | null;
  fullContentHash: string | null;
  metadata: InventoryMetadata | null;
};

export class FileInventoryRepository {
  constructor(private readonly db: Database.Database) {}

  beginScan(rootId: string, now: string): void {
    this.db.prepare(
      "UPDATE file_inventory SET inventory_status = 'missing', last_seen_job_id = NULL, updated_at = ? WHERE root_id = ?",
    ).run(now, rootId);
  }

  upsertSeen(rootId: string, jobId: string, entry: InventoryEntryInput, now: string): InventoryDisposition {
    return this.db.transaction(() => this.upsertSeenUnsafe(rootId, jobId, entry, now))();
  }

  /** The upsert body without a transaction, so callers can batch many into one. */
  private upsertSeenUnsafe(rootId: string, jobId: string, entry: InventoryEntryInput, now: string): InventoryDisposition {
    const existing = this.db.prepare(
      "SELECT * FROM file_inventory WHERE root_id = ? AND relative_path = ?",
    ).get(rootId, entry.relativePath) as InventoryRow | undefined;

    if (existing) {
      const unchanged = existing.file_size === entry.fileSize && existing.modified_at === entry.modifiedAt;
      if (unchanged) {
        this.db.prepare(
          `UPDATE file_inventory SET
            inventory_status = 'cached',
            last_error_code = NULL,
            last_seen_job_id = ?,
            updated_at = ?
          WHERE id = ?`,
        ).run(jobId, now, existing.id);
        return "cached";
      }

      this.db.prepare(
        `UPDATE file_inventory SET
          format = ?,
          file_size = ?,
          modified_at = ?,
          quick_fingerprint_version = NULL,
          quick_fingerprint = NULL,
          full_content_hash_algorithm = NULL,
          full_content_hash = NULL,
          metadata_json = NULL,
          metadata_state = 'pending',
          resolution_state = 'pending',
          inventory_status = 'discovered',
          last_error_code = NULL,
          last_seen_job_id = ?,
          updated_at = ?
        WHERE id = ?`,
      ).run(entry.format, entry.fileSize, entry.modifiedAt, jobId, now, existing.id);
      return "discovered";
    }

    const id = randomUUID();
    this.db.prepare(
      `INSERT INTO file_inventory (
        id, root_id, relative_path, format, file_size, modified_at,
        inventory_status, metadata_state, resolution_state, last_seen_job_id, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'discovered', 'pending', 'pending', ?, ?)`,
    ).run(id, rootId, entry.relativePath, entry.format, entry.fileSize, entry.modifiedAt, jobId, now);
    return "discovered";
  }

  /**
   * Upserts a batch of walked entries inside ONE transaction.
   *
   * The per-entry `upsertSeen` opens its own transaction, which in WAL mode means a
   * commit — and therefore an fsync — per discovered file. Walking a large tree that
   * way costs one fsync per file on the main process. Batching turns that into one
   * commit per batch.
   */
  upsertSeenBatch(
    rootId: string,
    jobId: string,
    entries: readonly InventoryEntryInput[],
    now: string,
  ): { cached: number; queued: number; errors: number } {
    const result = { cached: 0, queued: 0, errors: 0 };
    if (entries.length === 0) return result;
    this.db.transaction(() => {
      for (const entry of entries) {
        try {
          const disposition = this.upsertSeenUnsafe(rootId, jobId, entry, now);
          if (disposition === "cached") result.cached++;
          else result.queued++;
        } catch {
          // One bad entry must not roll back the whole batch; it is counted instead.
          result.errors++;
        }
      }
    })();
    return result;
  }

  /**
   * Returns one bounded page of rows still needing metadata.
   *
   * Note this deliberately keeps serving rows whose extraction previously failed
   * (`metadata_json IS NULL`) so a later scan can retry them. A caller paging through
   * this in a loop must therefore exclude ids it has already attempted, or those rows
   * are handed back forever and the loop never drains.
   */
  listMetadataWork(rootId: string, limit = 500, excludeIds: readonly string[] = []): FileInventoryRecord[] {
    const safeLimit = Math.max(1, Math.min(limit, 1000));
    const clause = excludeIds.length > 0
      ? ` AND id NOT IN (${excludeIds.map(() => "?").join(",")})`
      : "";
    const rows = this.db.prepare(
      `SELECT * FROM file_inventory WHERE root_id = ? AND inventory_status IN ('discovered', 'cached') AND (metadata_state = 'pending' OR metadata_json IS NULL)${clause} ORDER BY relative_path ASC, id ASC LIMIT ?`
    ).all(rootId, ...excludeIds, safeLimit) as InventoryRow[];
    return rows.map((r) => this.mapRecord(r));
  }

  /** Rows still awaiting metadata, for progress reporting. */
  countMetadataPending(rootId: string): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS count FROM file_inventory WHERE root_id = ? AND inventory_status IN ('discovered', 'cached') AND (metadata_state = 'pending' OR metadata_json IS NULL)",
    ).get(rootId) as { count: number };
    return row.count;
  }

  saveFingerprint(id: string, version: number, fingerprint: string, now: string): void {
    this.db.prepare(
      "UPDATE file_inventory SET quick_fingerprint_version = ?, quick_fingerprint = ?, updated_at = ? WHERE id = ?"
    ).run(version, fingerprint, now, id);
  }

  saveMetadata(id: string, metadata: InventoryMetadata, now: string): void {
    const parsed = InventoryMetadataSchema.parse(metadata);
    this.db.prepare(
      "UPDATE file_inventory SET metadata_json = ?, metadata_state = 'ready', metadata_error_code = NULL, updated_at = ? WHERE id = ?"
    ).run(JSON.stringify(parsed), now, id);
  }

  markMetadataError(id: string, code: string, now: string): void {
    this.db.prepare(
      "UPDATE file_inventory SET metadata_state = 'error', metadata_error_code = ?, updated_at = ? WHERE id = ?"
    ).run(code, now, id);
  }

  listResolutionCandidates(rootId: string, limit = 500): FileInventoryRecord[] {
    const safeLimit = Math.max(1, Math.min(limit, 1000));
    const rows = this.db.prepare(
      "SELECT * FROM file_inventory WHERE root_id = ? AND inventory_status IN ('discovered', 'cached') AND metadata_state = 'ready' ORDER BY relative_path ASC, id ASC LIMIT ?"
    ).all(rootId, safeLimit) as InventoryRow[];
    return rows.map((r) => this.mapRecord(r));
  }

  /** Files the resolution phase will consider, for progress reporting. */
  countResolutionCandidates(rootId: string): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS count FROM file_inventory WHERE root_id = ? AND inventory_status IN ('discovered', 'cached') AND metadata_state = 'ready'",
    ).get(rootId) as { count: number };
    return row.count;
  }

  /**
   * Files a rescan still found on disk, newest first.
   *
   * `missing` rows are excluded on purpose: they are files the library remembers but
   * the folder no longer has, and offering to import one would be a lie.
   */
  listPresent(rootId: string, options: { limit?: number; offset?: number } = {}): FileInventoryRecord[] {
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
    const offset = Math.max(0, options.offset ?? 0);
    const rows = this.db.prepare(
      `SELECT * FROM file_inventory
       WHERE root_id = ? AND inventory_status IN ('cached', 'discovered')
       ORDER BY relative_path ASC, id ASC LIMIT ? OFFSET ?`,
    ).all(rootId, limit, offset) as InventoryRow[];
    return rows.map((r) => this.mapRecord(r));
  }

  countPresent(rootId: string): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS count FROM file_inventory WHERE root_id = ? AND inventory_status IN ('cached', 'discovered')",
    ).get(rootId) as { count: number };
    return row.count;
  }

  countMissing(rootId: string): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS count FROM file_inventory WHERE root_id = ? AND inventory_status = 'missing'",
    ).get(rootId) as { count: number };
    return row.count;
  }

  getManyByIds(ids: readonly string[]): FileInventoryRecord[] {
    if (ids.length === 0) return [];
    const rows: FileInventoryRecord[] = [];
    for (const id of ids) {
      const row = this.db.prepare("SELECT * FROM file_inventory WHERE id = ?").get(id) as InventoryRow | undefined;
      if (row) rows.push(this.mapRecord(row));
    }
    return rows;
  }

  saveFullContentHash(id: string, hash: string, now: string): void {
    this.db.prepare(
      "UPDATE file_inventory SET full_content_hash_algorithm = 'sha256', full_content_hash = ?, updated_at = ? WHERE id = ?"
    ).run(hash, now, id);
  }

  markResolutionReady(ids: string[], now: string): void {
    if (!ids.length) return;
    const stmt = this.db.prepare("UPDATE file_inventory SET resolution_state = 'ready', resolution_error_code = NULL, updated_at = ? WHERE id = ?");
    this.db.transaction(() => {
      for (const id of ids) stmt.run(now, id);
    })();
  }

  markResolutionError(id: string, code: string, now: string): void {
    this.db.prepare(
      "UPDATE file_inventory SET resolution_state = 'error', resolution_error_code = ?, updated_at = ? WHERE id = ?"
    ).run(code, now, id);
  }

  getById(id: string): FileInventoryRecord | null {
    const row = this.db.prepare("SELECT * FROM file_inventory WHERE id = ?").get(id) as InventoryRow | undefined;
    if (!row) return null;
    return this.mapRecord(row);
  }

  countByStatus(rootId: string): Record<"cached" | "discovered" | "metadata_pending" | "error" | "missing", number> {
    const rows = this.db.prepare(
      "SELECT inventory_status, COUNT(*) as count FROM file_inventory WHERE root_id = ? GROUP BY inventory_status",
    ).all(rootId) as Array<{ inventory_status: string; count: number }>;

    const result = {
      cached: 0,
      discovered: 0,
      metadata_pending: 0,
      error: 0,
      missing: 0,
    };

    for (const row of rows) {
      if (row.inventory_status in result) {
        result[row.inventory_status as keyof typeof result] = row.count;
      }
    }

    return result;
  }

  private mapRecord(row: InventoryRow): FileInventoryRecord {
    let metadata: InventoryMetadata | null = null;
    if (row.metadata_json) {
      try {
        metadata = InventoryMetadataSchema.parse(JSON.parse(row.metadata_json));
      } catch {
        metadata = null;
      }
    }
    const metadataState = InventoryProcessingStateSchema.parse(row.metadata_state ?? "pending");
    const resolutionState = InventoryProcessingStateSchema.parse(row.resolution_state ?? "pending");

    return {
      id: row.id,
      rootId: row.root_id,
      relativePath: row.relative_path,
      format: row.format,
      fileSize: row.file_size,
      modifiedAt: row.modified_at,
      inventoryStatus: row.inventory_status,
      metadataState,
      resolutionState,
      quickFingerprintVersion: row.quick_fingerprint_version ?? null,
      quickFingerprint: row.quick_fingerprint ?? null,
      fullContentHash: row.full_content_hash ?? null,
      metadata,
    };
  }
}
