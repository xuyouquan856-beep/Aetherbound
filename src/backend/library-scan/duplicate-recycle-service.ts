import { join } from "node:path";
import type { FileInventoryRepository, FileInventoryRecord } from "./file-inventory-repository.js";
import type { ScanFindingRecord, ScanFindingRepository } from "./scan-finding-repository.js";
import type { ScanOperationSink } from "./model-contracts.js";
import { assertManagedFile } from "./path-guard.js";

type QuickFingerprintResult = {
  version: number;
  fingerprint: string;
  fileSize: number;
  modifiedAt: string;
  isFile: boolean;
};

export type DuplicateRecycleDependencies = {
  inventory: FileInventoryRepository;
  findings: ScanFindingRepository;
  operations: ScanOperationSink;
  quickFingerprint(path: string): Promise<QuickFingerprintResult>;
  fullContentHash(path: string): Promise<string>;
  trash(root: string, path: string): Promise<"recycle-bin" | "quarantine">;
  now(): string;
};

export type ApplyDuplicateInput = {
  finding: ScanFindingRecord;
  rootPath: string;
};

/**
 * The outcome of acting on one duplicate finding.
 *
 * `partial` exists because moving several files can fail halfway: the copies that did
 * move stayed moved, and reporting that honestly matters more than a tidy boolean.
 */
export type ApplyDuplicateOutcome =
  | { status: "applied"; recycled: number; reclaimedBytes: number }
  | { status: "stale"; reason: string }
  | { status: "partial"; recycled: number; reclaimedBytes: number; failed: number };

/**
 * Removes the redundant copies of a duplicate finding — and only ever the copies the
 * user explicitly confirmed.
 *
 * This class used to export `recycleEligibleFindings`, which every scan called on its
 * own to sweep duplicates out of the library before the user had seen the list. That
 * is the single most destructive thing this subsystem can do, so the automatic entry
 * point is gone rather than merely gated: there is no longer any code path that moves
 * a file without a decision behind it.
 *
 * The order of operations is deliberate. Before a single victim is touched, the
 * survivor is re-hashed and compared against the content hash recorded in the finding.
 * Only once a byte-identical copy is *proven to exist right now* does anything move.
 * If the survivor has been renamed, edited or deleted since the scan, the finding is
 * marked `stale` and nothing moves at all — the file the user would have been left
 * with is not the file we promised.
 */
export class DuplicateRecycleService {
  constructor(private readonly deps: DuplicateRecycleDependencies) {}

  async applyExactDuplicateFinding(input: ApplyDuplicateInput): Promise<ApplyDuplicateOutcome> {
    const { finding, rootPath } = input;
    const { inventory, operations, quickFingerprint, fullContentHash, trash } = this.deps;

    const evidence = finding.evidence;
    if (finding.kind !== "exact_duplicate" || evidence.kind !== "exact_duplicate") {
      return { status: "stale", reason: "finding is not an exact duplicate" };
    }

    const survivorId = evidence.survivorInventoryId;
    if (!finding.candidateIds.includes(survivorId)) {
      this.markStale(finding, "survivor is not one of the finding's files");
      return { status: "stale", reason: "survivor is not one of the finding's files" };
    }

    const victimIds = finding.candidateIds.filter((id) => id !== survivorId);
    if (victimIds.length === 0) {
      this.markStale(finding, "finding has no redundant copy to remove");
      return { status: "stale", reason: "finding has no redundant copy to remove" };
    }

    const survivors = this.resolveRows([survivorId], inventory);
    if (!survivors) {
      this.markStale(finding, "the surviving copy is no longer in the inventory");
      return { status: "stale", reason: "the surviving copy is no longer in the inventory" };
    }
    const survivor = survivors[0];

    // Prove the survivor is still the exact file this finding was built from. This is
    // the check that makes every later move safe, so it runs first and it is the full
    // hash, not the cheap fingerprint.
    const survivorPath = join(rootPath, survivor.relativePath);
    let survivorVerified = false;
    try {
      const canonicalSurvivor = await assertManagedFile(rootPath, survivorPath);
      const fingerprint = await quickFingerprint(canonicalSurvivor);
      if (fingerprint.isFile && fingerprint.fileSize === survivor.fileSize) {
        const hash = await fullContentHash(canonicalSurvivor);
        survivorVerified = hash === evidence.fullContentHash;
      }
    } catch {
      survivorVerified = false;
    }
    if (!survivorVerified) {
      this.markStale(finding, "the surviving copy changed since the scan");
      return { status: "stale", reason: "the surviving copy changed since the scan" };
    }

    // Every victim must still be the file that was scanned. One surprise in the group
    // invalidates the grouping, so the whole finding is re-derived on the next scan
    // rather than half-applied now.
    const victimRows = this.resolveRows(victimIds, inventory);
    if (!victimRows) {
      this.markStale(finding, "a redundant copy is no longer in the inventory");
      return { status: "stale", reason: "a redundant copy is no longer in the inventory" };
    }
    for (const victim of victimRows) {
      try {
        const canonical = await assertManagedFile(rootPath, join(rootPath, victim.relativePath));
        const fingerprint = await quickFingerprint(canonical);
        if (
          !fingerprint.isFile
          || fingerprint.fileSize !== victim.fileSize
          || fingerprint.modifiedAt !== victim.modifiedAt
          || fingerprint.fingerprint !== victim.quickFingerprint
        ) {
          this.markStale(finding, `a redundant copy changed since the scan: ${victim.relativePath}`);
          return { status: "stale", reason: `a redundant copy changed since the scan: ${victim.relativePath}` };
        }
      } catch {
        this.markStale(finding, `a redundant copy is unreadable: ${victim.relativePath}`);
        return { status: "stale", reason: `a redundant copy is unreadable: ${victim.relativePath}` };
      }
    }

    let recycled = 0;
    let reclaimedBytes = 0;
    let failed = 0;

    for (const victim of victimRows) {
      const actionId = `recycle:${finding.id}:${victim.id}`;
      try {
        await trash(rootPath, join(rootPath, victim.relativePath));
        recycled++;
        reclaimedBytes += victim.fileSize;
        operations.record({
          reviewId: finding.id,
          actionId,
          kind: "recycle_duplicate",
          bookId: null,
          candidatePath: victim.relativePath,
          priorSourcePath: null,
          contentHash: evidence.fullContentHash,
          reason: `已确认重复，保留 ${survivor.relativePath}`,
          outcome: "completed",
        });
      } catch (cause) {
        failed++;
        operations.record({
          reviewId: finding.id,
          actionId,
          kind: "recycle_duplicate",
          bookId: null,
          candidatePath: victim.relativePath,
          priorSourcePath: null,
          contentHash: evidence.fullContentHash,
          reason: `移除失败：${cause instanceof Error ? cause.message : String(cause)}`,
          outcome: "failed",
        });
      }
    }

    if (failed === 0) return { status: "applied", recycled, reclaimedBytes };
    if (recycled === 0) return { status: "stale", reason: "no copy could be moved" };
    return { status: "partial", recycled, reclaimedBytes, failed };
  }

  private resolveRows(ids: readonly string[], inventory: FileInventoryRepository): FileInventoryRecord[] | null {
    const rows: FileInventoryRecord[] = [];
    for (const id of ids) {
      const row = inventory.getById(id);
      if (!row || row.inventoryStatus === "missing") return null;
      rows.push(row);
    }
    return rows;
  }

  private markStale(finding: ScanFindingRecord, reason: string): void {
    try {
      this.deps.findings.updateStatus(finding.id, "stale", this.deps.now());
    } catch {
      // Already terminal, or the row vanished. The caller's return value is the
      // authoritative answer either way.
    }
    this.deps.operations.record({
      reviewId: finding.id,
      actionId: `recycle-stale:${finding.id}`,
      kind: "recycle_duplicate",
      bookId: null,
      candidatePath: finding.candidateIds.join(", "),
      priorSourcePath: null,
      contentHash: finding.evidence.kind === "exact_duplicate" ? finding.evidence.fullContentHash : "",
      reason,
      outcome: "failed",
    });
  }
}
