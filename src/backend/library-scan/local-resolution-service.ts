import type Database from "better-sqlite3";
import { join } from "node:path";
import type { ScanFindingRecord } from "./scan-finding-repository.js";
import { ScanFindingRepository } from "./scan-finding-repository.js";
import { DuplicateResolver, type DuplicateCandidate, type ExactDuplicateGroup } from "./duplicate-resolver.js";
import { resolveSeries } from "./series-resolver.js";
import type { LibraryLinkIndex } from "./library-link.js";
import type { InventoryMetadata } from "../../shared/contracts.js";
import { InventoryMetadataSchema } from "../../shared/contracts.js";
import type { FileInventoryRepository } from "./file-inventory-repository.js";

type InventoryRow = {
  id: string;
  root_id: string;
  relative_path: string;
  format: "txt" | "epub";
  file_size: number;
  modified_at: string;
  quick_fingerprint_version: number | null;
  quick_fingerprint: string | null;
  metadata_json: string | null;
};

/**
 * Finds the volume marker in whichever of the two names has one.
 *
 * The metadata title and the file name are different sources and neither is reliable on
 * its own. A TXT whose first line reads like a title gets that line as its title, and the
 * line is usually not where the volume number lives — the file name is. An EPUB's OPF
 * title is usually the better name but frequently carries no volume marker at all, while
 * the file it came from was named "… 第7卷.epub" by whoever published it.
 *
 * So both are tried, and the one that actually yields a volume label wins. "No volume
 * found" is the only result that is not worth preferring over the other.
 */
function detectSeries(metadataTitle: string | null, stem: string) {
  const fromMetadata = resolveSeries({
    metadataTitle: metadataTitle ?? stem,
    displayFileName: stem,
  });
  if (fromMetadata.volumeLabel) return fromMetadata;
  if (!metadataTitle || metadataTitle === stem) return fromMetadata;

  const fromFileName = resolveSeries({ metadataTitle: stem, displayFileName: stem });
  return fromFileName.volumeLabel ? fromFileName : fromMetadata;
}

export type RunLocalResolutionInput = {
  rootId: string;
  jobId: string;
  rootPath: string;
  computeFullHash: (absolutePath: string) => Promise<string>;
  now: string;
  /** Path-keyed view of the library, so findings can say what is already imported. */
  libraryLink: LibraryLinkIndex;
  /** Used to persist content hashes so a later scan does not re-read every file. */
  inventory: FileInventoryRepository;
};

export type RunLocalResolutionResult = {
  findings: ScanFindingRecord[];
  /** Files that were hashed during this pass; the resolution total for progress. */
  examined: number;
};

/**
 * Turns the raw inventory into findings the user can review.
 *
 * Nothing here changes the library or the filesystem. It reads metadata, groups files
 * that are byte-identical, groups files that look like volumes of one series, and
 * records both as findings. Acting on them is a separate, explicitly confirmed step.
 */
export class LocalResolutionService {
  private readonly findingRepo: ScanFindingRepository;
  private readonly dupResolver: DuplicateResolver;

  constructor(private readonly db: Database.Database) {
    this.findingRepo = new ScanFindingRepository(db);
    this.dupResolver = new DuplicateResolver();
  }

  async runLocalResolution(input: RunLocalResolutionInput): Promise<RunLocalResolutionResult> {
    const { rootId, jobId, rootPath, computeFullHash, now, libraryLink, inventory } = input;

    const rows = this.db.prepare(
      `SELECT * FROM file_inventory
       WHERE root_id = ? AND inventory_status IN ('discovered','cached')
       AND metadata_state = 'ready'
       AND quick_fingerprint IS NOT NULL
       ORDER BY relative_path ASC`
    ).all(rootId) as InventoryRow[];

    if (rows.length < 2) return { findings: [], examined: 0 };

    const parsed = rows.map((row) => {
      let metadata: InventoryMetadata | null = null;
      if (row.metadata_json) {
        try {
          metadata = InventoryMetadataSchema.parse(JSON.parse(row.metadata_json));
        } catch { /* skip */ }
      }
      const stem = row.relative_path.replace(/\.[^.]+$/, "");
      return { row, metadata, seriesResult: detectSeries(metadata?.title ?? null, stem) };
    });

    const candidates: DuplicateCandidate[] = parsed.map(({ row }) => {
      const absolutePath = join(rootPath, row.relative_path);
      const link = libraryLink.get(absolutePath);
      return {
        inventoryId: row.id,
        format: row.format,
        relativePath: row.relative_path,
        absolutePath,
        fileSize: row.file_size,
        modifiedAt: row.modified_at,
        quickFingerprintVersion: row.quick_fingerprint_version ?? 1,
        quickFingerprint: row.quick_fingerprint ?? "",
        imported: link !== undefined,
        importedAvailable: link?.available === true,
      };
    });

    const hashCache = new Map<string, string>();
    const dupGroups = await this.dupResolver.findExactDuplicates({
      candidates,
      computeFullHash: async (absolutePath) => {
        const cached = hashCache.get(absolutePath);
        if (cached) return cached;
        const hash = await computeFullHash(absolutePath);
        hashCache.set(absolutePath, hash);
        return hash;
      },
    });

    // Persist the hashes this pass computed. Without this every scan re-reads every
    // candidate in full, which is the most expensive thing the scan does and, for an
    // unchanged library, pure waste.
    for (const [absolutePath, hash] of hashCache) {
      const candidate = candidates.find((c) => c.absolutePath === absolutePath);
      if (!candidate) continue;
      try {
        inventory.saveFullContentHash(candidate.inventoryId, hash, now);
      } catch { /* a stale row is not worth failing the phase over */ }
    }

    const findings: ScanFindingRecord[] = [];

    // Both loops below need "which parsed entry is this inventory id". Scanning the
    // array for each candidate made the phase quadratic in the size of the folder, on
    // the main process — an index over the rows it already has costs one pass.
    const entryById = new Map(parsed.map((entry) => [entry.row.id, entry]));

    for (const group of dupGroups) {
      findings.push(this.recordDuplicateFinding(group, { rootId, jobId, now, entryById }));
    }

    for (const series of this.groupSeries(parsed)) {
      findings.push(this.findingRepo.upsertFinding({
        rootId,
        jobId,
        kind: "series_volume",
        // Never `new`: a series grouping is a suggestion about how to organize a
        // collection, and the user is the one who decides whether it is right.
        status: "needs_review",
        confidence: series.confidence,
        candidateIds: series.members.map((p) => p.row.id),
        evidence: {
          kind: "series_volume" as const,
          evidenceVersion: 1 as const,
          normalizedSeries: series.name,
          volumeLabel: series.volumeLabels.join("、") || null,
          volumeIndex: series.volumeIndexes.length === 1 ? series.volumeIndexes[0] : null,
          ruleCodes: ["series_pattern_match"],
        },
        now,
      }));
    }

    return { findings, examined: hashCache.size };
  }

  private recordDuplicateFinding(
    group: ExactDuplicateGroup,
    context: {
      rootId: string;
      jobId: string;
      now: string;
      entryById: Map<string, { row: InventoryRow; seriesResult: { volumeLabel: string | null } }>;
    },
  ): ScanFindingRecord {
    const { rootId, jobId, now, entryById } = context;

    // A filename that claims a different volume than its byte-identical twin is the
    // one case where "these files are identical" and "these files are the same book"
    // disagree. That must never be auto-resolved, so it is always routed to review —
    // and since every decision is manual now, the flag exists to warn in the UI.
    const volumeLabels = new Set<string>();
    for (const id of group.candidateIds) {
      const label = entryById.get(id)?.seriesResult.volumeLabel;
      if (label) volumeLabels.add(label);
    }
    const volumeConflict = volumeLabels.size > 1;

    return this.findingRepo.upsertFinding({
      rootId,
      jobId,
      kind: "exact_duplicate",
      status: volumeConflict ? "needs_review" : "new",
      confidence: volumeConflict ? 0.6 : 1,
      candidateIds: group.candidateIds,
      evidence: {
        kind: "exact_duplicate" as const,
        evidenceVersion: 1 as const,
        algorithm: "sha256" as const,
        fullContentHash: group.fullContentHash,
        survivorInventoryId: group.survivorId,
        volumeConflict,
        ruleCodes: volumeConflict
          ? ["exact_hash_match", "volume_conflict"]
          : ["exact_hash_match"],
      },
      now,
    });
  }

  /**
   * Groups files that are volumes of the same series.
   *
   * The previous version grouped on `normalizedSeries`, which `resolveSeries` also
   * returns for a title with no volume marker at all — so a `.txt` and a `.epub` of one
   * book, or any two files the resolver failed on, were reported as a "series". A group
   * now has to show real evidence of being a series: at least two members, every member
   * carrying a volume label, and at least two distinct labels.
   */
  private groupSeries(
    parsed: Array<{ row: InventoryRow; seriesResult: { normalizedSeries: string; volumeLabel: string | null; volumeIndex: number | null; confidence: number } }>,
  ): Array<{ name: string; members: typeof parsed; volumeLabels: string[]; volumeIndexes: number[]; confidence: number }> {
    const groups = new Map<string, typeof parsed>();
    for (const entry of parsed) {
      if (!entry.seriesResult.volumeLabel) continue;
      const key = entry.seriesResult.normalizedSeries;
      if (!key) continue;
      const list = groups.get(key) ?? [];
      list.push(entry);
      groups.set(key, list);
    }

    const result: Array<{ name: string; members: typeof parsed; volumeLabels: string[]; volumeIndexes: number[]; confidence: number }> = [];
    for (const [name, members] of groups) {
      if (members.length < 2) continue;
      const labels = members.map((m) => m.seriesResult.volumeLabel as string);
      if (new Set(labels).size < 2) continue;
      result.push({
        name,
        members,
        volumeLabels: labels,
        volumeIndexes: members
          .map((m) => m.seriesResult.volumeIndex)
          .filter((index): index is number => index !== null),
        confidence: Math.min(...members.map((m) => m.seriesResult.confidence)),
      });
    }
    return result;
  }
}
