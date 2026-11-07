import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ScanOperationRecord, ScanOperationSink } from "./model-contracts.js";

/**
 * Append-only audit log for operations the scan system performs on the user's files.
 *
 * This is the safety story for a feature that moves and recycles real books: every
 * action is recorded with the candidate path, content hash and outcome, so a user can
 * see what happened and reconcile it afterwards.
 *
 * The table is still named `librarian_operations` for on-disk compatibility. Renaming
 * it would be a migration for no functional gain, and existing databases already carry
 * the rows.
 */
export class ScanOperationRepository implements ScanOperationSink {
  constructor(private readonly db: Database.Database) {}

  record(value: ScanOperationRecord): void {
    this.db.prepare(`INSERT INTO librarian_operations(
      id,review_id,action_id,kind,book_id,candidate_path,prior_source_path,content_hash,reason,outcome,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      randomUUID(),
      value.reviewId,
      value.actionId,
      value.kind,
      value.bookId,
      value.candidatePath,
      value.priorSourcePath,
      value.contentHash,
      value.reason,
      value.outcome,
      new Date().toISOString(),
    );
  }

  listRecent(limit = 50): Array<ScanOperationRecord & { createdAt: string }> {
    return (this.db.prepare(
      "SELECT * FROM librarian_operations ORDER BY created_at DESC LIMIT ?",
    ).all(limit) as Array<Record<string, unknown>>).map((row) => ({
      reviewId: row.review_id as string,
      actionId: row.action_id as string,
      kind: row.kind as ScanOperationRecord["kind"],
      bookId: row.book_id as string | null,
      candidatePath: row.candidate_path as string,
      priorSourcePath: row.prior_source_path as string | null,
      contentHash: row.content_hash as string,
      reason: row.reason as string,
      outcome: row.outcome as ScanOperationRecord["outcome"],
      createdAt: row.created_at as string,
    }));
  }
}
