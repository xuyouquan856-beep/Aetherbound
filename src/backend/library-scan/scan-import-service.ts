import {
  ScanImportProgressSchema,
  type ScanImportProgress,
} from "../../shared/contracts.js";
import { ReaderError } from "../../shared/errors.js";
import type { MixedImportFile } from "../library/library-import-service.js";
import type { ResolvedImportFile, ScanReviewService } from "./scan-review-service.js";

/**
 * How many files go into one `importMixedFiles` call.
 *
 * The slice is the unit of progress reporting and of cancellation. Small enough that
 * the bar moves and a cancel is honoured promptly, large enough that the per-slice
 * bookkeeping (a Set of already-admitted ids) stays negligible.
 */
const IMPORT_SLICE_SIZE = 10;

export type ScanImportDependencies = {
  review: Pick<
    ScanReviewService,
    "resolveImportFiles" | "addBooksToCollection" | "listUnimportedInventoryIds" | "requireActiveRoot"
  >;
  importer: {
    importMixedFiles(
      files: readonly MixedImportFile[],
      onProgress?: (value: { processed: number; total: number; fileName: string | null }) => void,
    ): Promise<Array<{ status: "imported" | "duplicate" | "unsupported" | "failed"; book?: { id: string } }>>;
  };
  now(): string;
};

export type StartImportInput = {
  /** Explicit selection, or null to import everything the library does not have. */
  inventoryIds: readonly string[] | null;
  /** When set, the imported books are filed into this collection afterwards. */
  collection?: { id: string; name: string };
};

/**
 * Runs the "bring scanned files into the library" half of the review screen.
 *
 * It exists as a separate, stateful service because that work is long: a folder can
 * hold a thousand books, each needing a fingerprint, a hash and (for EPUB) a queued
 * preparation. A plain request handler could only answer when it was all over, which is
 * what the first version did — silence, then a toast. This reports progress per slice
 * and stops between slices on request.
 *
 * Cancelling is deliberately not a rollback. The books already admitted are in the
 * library and stay there; the summary says so. Undoing an import would mean deleting
 * records for books the user asked for, which is a worse surprise than a partial run.
 */
export class ScanImportService {
  private readonly listeners = new Set<(progress: ScanImportProgress) => void>();
  private current: ScanImportProgress | null = null;
  private controller: AbortController | null = null;
  private running: Promise<ScanImportProgress> | null = null;

  constructor(private readonly deps: ScanImportDependencies) {}

  subscribe(listener: (progress: ScanImportProgress) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** The last known progress, so a screen that mounts mid-run can pick it up. */
  active(): ScanImportProgress | null {
    return this.current;
  }

  isRunning(): boolean {
    return this.running !== null;
  }

  cancel(): ScanImportProgress | null {
    if (!this.controller || !this.running) return this.current;
    this.controller.abort();
    return this.current;
  }

  start(input: StartImportInput): Promise<ScanImportProgress> {
    if (this.running) {
      throw new ReaderError("INVALID_REQUEST", "已经有导入在进行中。");
    }
    const running = this.run(input).finally(() => {
      this.running = null;
      this.controller = null;
    });
    this.running = running;
    return running;
  }

  private async run(input: StartImportInput): Promise<ScanImportProgress> {
    const root = this.deps.review.requireActiveRoot();
    this.controller = new AbortController();
    const signal = this.controller.signal;

    const inventoryIds = input.inventoryIds
      ?? this.deps.review.listUnimportedInventoryIds(root.id, root.rootPath);
    const files = this.deps.review.resolveImportFiles(root.id, root.rootPath, inventoryIds);

    const counters = { processed: 0, imported: 0, duplicates: 0, failed: 0 };
    let collectionName = input.collection?.name ?? null;
    let lastFileName: string | null = null;

    const emit = (phase: ScanImportProgress["phase"], summary: string | null) => {
      const progress = ScanImportProgressSchema.parse({
        phase,
        processed: counters.processed,
        total: files.length,
        imported: counters.imported,
        duplicates: counters.duplicates,
        failed: counters.failed,
        fileName: lastFileName,
        collectionName,
        summary,
      });
      this.current = progress;
      for (const listener of this.listeners) listener(progress);
      return progress;
    };

    if (files.length === 0) {
      return emit("completed", "没有需要导入的文件。");
    }

    emit("importing", null);

    // Duplicate detection has to span the whole run, not each slice: `importMixedFiles`
    // reports the second copy of identical content as a duplicate only if it saw the
    // first one in the same call. Tracking admitted book ids here keeps the counts
    // truthful across slice boundaries.
    const admittedBookIds = new Set<string>();
    const importedBookIds: string[] = [];

    for (let index = 0; index < files.length; index += IMPORT_SLICE_SIZE) {
      if (signal.aborted) {
        return emit(
          "cancelled",
          `已停止导入。已入库 ${counters.imported} 本，剩余 ${files.length - counters.processed} 个文件未处理。`,
        );
      }

      const slice = files.slice(index, index + IMPORT_SLICE_SIZE);
      lastFileName = fileNameOf(slice[slice.length - 1]);

      let items: Awaited<ReturnType<ScanImportDependencies["importer"]["importMixedFiles"]>>;
      try {
        items = await this.deps.importer.importMixedFiles(
          slice.map((file) => ({ path: file.path, format: file.format })),
        );
      } catch {
        // A slice that blows up is counted and skipped; the rest of the folder still
        // deserves its chance.
        counters.failed += slice.length;
        counters.processed += slice.length;
        emit("importing", null);
        continue;
      }

      for (const item of items) {
        if (item.status === "imported" || item.status === "duplicate") {
          const bookId = item.book?.id ?? null;
          if (bookId === null) {
            counters.failed += 1;
          } else if (admittedBookIds.has(bookId)) {
            counters.duplicates += 1;
          } else {
            admittedBookIds.add(bookId);
            counters.imported += 1;
            importedBookIds.push(bookId);
          }
        } else {
          counters.failed += 1;
        }
      }
      counters.processed += items.length;
      emit("importing", null);
    }

    if (input.collection) {
      emit("filing", null);
      try {
        await this.deps.review.addBooksToCollection(input.collection.id, importedBookIds);
      } catch {
        return emit("failed", `导入完成，但归入珍藏「${input.collection.name}」失败，可在珍藏页手动加入。`);
      }
      collectionName = input.collection.name;
    }

    const summary = collectionName
      ? `已导入 ${counters.imported} 本，并归入珍藏「${collectionName}」` +
        `${counters.duplicates > 0 ? `；${counters.duplicates} 个文件内容重复，未重复入库` : ""}` +
        `${counters.failed > 0 ? `；${counters.failed} 个失败` : ""}。`
      : `已导入 ${counters.imported} 本` +
        `${counters.duplicates > 0 ? `；${counters.duplicates} 个文件内容重复，未重复入库` : ""}` +
        `${counters.failed > 0 ? `；${counters.failed} 个失败` : ""}。`;
    return emit("completed", summary);
  }
}

function fileNameOf(file: ResolvedImportFile | undefined): string | null {
  if (!file) return null;
  const parts = file.path.split(/[\\/]/u);
  return parts[parts.length - 1] ?? null;
}
