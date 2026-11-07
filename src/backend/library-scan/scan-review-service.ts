import { join } from "node:path";
import type Database from "better-sqlite3";import {
  type LibraryImportItemResult,
  type ScanBatchDecisionResult,
  type ScanDecisionResult,
  type ScanFileList,
  type ScanFindingCandidate,
  type ScanFindingDetail,
  type ScanFindingKind,
  type ScanFindingList,
  type ScanOverview,
  type ScanProposedAction,
  CollectionNameSchema,
  ScanFindingCandidateSchema,
} from "../../shared/contracts.js";
import { ReaderError } from "../../shared/errors.js";
import type { CustomCollectionService } from "../library/custom-collection-service.js";
import { normalizeCollectionName } from "../library/custom-collection-service.js";
import type { FileInventoryRepository, FileInventoryRecord } from "./file-inventory-repository.js";
import type { LibraryRootRepository } from "./library-root-repository.js";
import { loadLibraryLinks, type LibraryLinkIndex } from "./library-link.js";
import type { ScanFindingRecord, ScanFindingRepository } from "./scan-finding-repository.js";
import type { DuplicateRecycleService } from "./duplicate-recycle-service.js";
import type { ScanOperationSink } from "./model-contracts.js";
import type { MixedImportFile } from "../library/library-import-service.js";

/**
 * How many inventory rows one review request will walk.
 *
 * The "which of my files are not in the library yet" question can only be answered by
 * comparing every file against `book_sources`, and the comparison has to happen in
 * memory because the two sides store the path differently (relative vs absolute). The
 * cap keeps a pathological folder — someone pointing the scanner at a game install —
 * from turning a page request into an unbounded table walk on the main process.
 */
const MAX_REVIEW_ROWS = 50_000;

/** A queue-wide action stops here, reporting what it did not reach. */
const MAX_BATCH_FINDINGS = 500;

export type ScanReviewDependencies = {
  db: Database.Database;
  roots: LibraryRootRepository;
  inventory: FileInventoryRepository;
  findings: ScanFindingRepository;
  operations: ScanOperationSink;
  recycler: DuplicateRecycleService;
  collections: Pick<CustomCollectionService, "create" | "addBooks" | "list" | "getMemberships">;
  importer: {
    importMixedFiles(
      files: readonly MixedImportFile[],
      onProgress?: (value: { processed: number; total: number; fileName: string | null }) => void,
    ): Promise<LibraryImportItemResult[]>;
  };
  now(): string;
};

export type ActiveRoot = { id: string; rootPath: string; displayName: string };

/** A collection a series' books already live in. */
type OrganizedTarget = { collectionId: string; name: string };

/** What the scan knows about collections for the series findings of one folder. */
type SeriesContext = {
  /** Findings that are finished: fully imported and filed together. Hidden from the queue. */
  organized: Map<string, OrganizedTarget>;
  /**
   * The collection these books all already share, or null.
   *
   * Every id counts: a book that is in no collection makes this null, which is what
   * "are these filed together?" needs.
   */
  sharedCollectionOf(bookIds: readonly string[]): OrganizedTarget | null;
  /**
   * Where books that are already filed belong.
   *
   * Books that are in no collection are ignored rather than disqualifying the answer.
   * This is the one to ask when aiming an action: a series with two shelved volumes and
   * a third that has just been imported should be pointed at the collection the user
   * made, not at a fresh one named after the file.
   */
  preferredCollectionFor(bookIds: readonly string[]): OrganizedTarget | null;
};

/** Used when the request cannot involve series at all, so nothing is looked up. */
const EMPTY_SERIES_CONTEXT: SeriesContext = {
  organized: new Map(),
  sharedCollectionOf: () => null,
  preferredCollectionFor: () => null,
};

/** Files resolved from inventory ids, in the order the caller gave them. */
export type ResolvedImportFile = { inventoryId: string; path: string; format: "txt" | "epub" };

/**
 * Everything the review screen does: read the state of a scanned folder, and carry out
 * one decision at a time — or one whole queue at a time.
 *
 * This is the only place in the scan subsystem allowed to change anything. Each entry
 * point is reached exclusively from an explicit action on the review screen, so there
 * is still no path from "scan" to "your files changed" — the batch operations below
 * widen *how much* a confirmed action covers, not whether it was confirmed.
 */
export class ScanReviewService {
  constructor(private readonly deps: ScanReviewDependencies) {}

  getActiveRoot(): ActiveRoot | null {
    const root = this.deps.roots.getMostRecent();
    return root ? { id: root.id, rootPath: root.rootPath, displayName: root.displayName } : null;
  }

  requireActiveRoot(): ActiveRoot {
    const root = this.getActiveRoot();
    if (!root) throw new ReaderError("INVALID_REQUEST", "MANAGED_FOLDER_REQUIRED");
    return root;
  }

  /**
   * The headline numbers for a scanned folder.
   *
   * Counts come from SQL rather than from the first page of results, so "导入全部 780
   * 本" is 780 and not "however many fitted on a page".
   */
  overview(rootId: string, rootPath: string): ScanOverview {
    const { findings, inventory, roots } = this.deps;
    const root = roots.getById(rootId);
    const links = loadLibraryLinks(this.deps.db);
    const series = this.seriesContext(rootId, rootPath, links);

    let present = 0;
    let inLibrary = 0;
    for (let offset = 0; offset < MAX_REVIEW_ROWS; offset += 500) {
      const page = inventory.listPresent(rootId, { limit: 500, offset });
      if (page.length === 0) break;
      for (const record of page) {
        present += 1;
        if (links.get(join(rootPath, record.relativePath))) inLibrary += 1;
      }
      if (page.length < 500) break;
    }

    // The duplicate numbers need the candidates behind each finding (for the size and
    // for the volume-conflict flag), so they are computed from the open findings
    // themselves. A folder with more than 500 open duplicates has an unusual problem,
    // and the numbers stay honest by reporting what was actually examined.
    const open = findings.listByRoot(rootId, { limit: MAX_BATCH_FINDINGS, includeResolved: false });
    let clearableDuplicateGroups = 0;
    let conflictedDuplicateGroups = 0;
    let reclaimableBytes = 0;
    let seriesGroups = 0;
    let seriesReadyToCollect = 0;
    let seriesPendingImport = 0;

    for (const record of open) {
      if (record.kind === "exact_duplicate") {
        const conflict = record.evidence.kind === "exact_duplicate" && record.evidence.volumeConflict;
        if (conflict) {
          conflictedDuplicateGroups += 1;
          continue;
        }
        clearableDuplicateGroups += 1;
        reclaimableBytes += this.reclaimableBytes(record, rootPath, links);
        continue;
      }
      if (record.kind === "series_volume") {
        // Already imported *and* already filed together: there is no suggestion left to
        // make, so it must not be counted as pending work either.
        if (series.organized.has(record.id)) continue;
        seriesGroups += 1;
        const imported = this.countImportedCandidates(record, rootPath, links);
        if (imported > 0) seriesReadyToCollect += 1;
        else seriesPendingImport += 1;
      }
    }

    return {
      rootName: root?.displayName ?? null,
      present,
      inLibrary,
      unimported: Math.max(0, present - inLibrary),
      missing: inventory.countMissing(rootId),
      duplicateGroups: clearableDuplicateGroups + conflictedDuplicateGroups,
      clearableDuplicateGroups,
      reclaimableBytes,
      conflictedDuplicateGroups,
      seriesGroups,
      seriesReadyToCollect,
      seriesPendingImport,
      scannedAt: this.latestScanTime(rootId),
    };
  }

  listFindings(rootId: string, options: { limit: number; offset: number; includeResolved: boolean; kind?: ScanFindingKind }): ScanFindingList {
    const { findings, inventory, roots } = this.deps;
    const root = roots.getById(rootId);
    const links = loadLibraryLinks(this.deps.db);
    const series = options.kind === "exact_duplicate"
      ? EMPTY_SERIES_CONTEXT
      : this.seriesContext(rootId, root?.rootPath ?? "", links);
    const organized = series.organized;

    // Over-fetch by the number of hidden findings so a page still comes back full: the
    // filter runs after the SQL LIMIT otherwise, and page two would silently lose rows.
    const records = findings.listByRoot(rootId, {
      ...options,
      limit: Math.min(options.limit + organized.size, 500),
    });
    const visible = records
      .filter((record) => !organized.has(record.id))
      .slice(0, options.limit);

    return {
      rootName: root?.displayName ?? null,
      findings: visible.map((record) => this.toDetail(record, inventory, links, series)),
      total: Math.max(0, findings.countByRoot(rootId, {
        includeResolved: options.includeResolved,
        kind: options.kind,
      }) - (options.kind === "exact_duplicate" ? 0 : organized.size)),
      awaitingReview: Math.max(0, findings.countByRoot(rootId) - organized.size),
    };
  }

  listFiles(
    rootId: string,
    rootPath: string,
    options: { limit: number; offset: number; onlyUnimported: boolean },
  ): ScanFileList {
    const { inventory, roots } = this.deps;
    const root = roots.getById(rootId);
    const links = loadLibraryLinks(this.deps.db);

    const matches: FileInventoryRecord[] = [];
    let inLibrary = 0;
    let examinedTotal = 0;

    const pageSize = 500;
    for (let offset = 0; offset < MAX_REVIEW_ROWS; offset += pageSize) {
      const page = inventory.listPresent(rootId, { limit: pageSize, offset });
      if (page.length === 0) break;
      for (const record of page) {
        const link = links.get(join(rootPath, record.relativePath));
        if (link) inLibrary++;
        examinedTotal++;
        if (options.onlyUnimported && link) continue;
        matches.push(record);
      }
      if (page.length < pageSize) break;
    }

    return {
      rootName: root?.displayName ?? null,
      files: matches
        .slice(options.offset, options.offset + options.limit)
        .map((record) => this.buildCandidate(record, rootPath, links))
        .filter((candidate): candidate is ScanFindingCandidate => candidate !== null),
      total: matches.length,
      present: examinedTotal,
      inLibrary,
      missing: inventory.countMissing(rootId),
    };
  }

  /** Every inventory id the library does not have yet, for "import all". */
  listUnimportedInventoryIds(rootId: string, rootPath: string, limit = 5000): string[] {
    const { inventory } = this.deps;
    const links = loadLibraryLinks(this.deps.db);
    const ids: string[] = [];
    const pageSize = 500;
    for (let offset = 0; offset < MAX_REVIEW_ROWS && ids.length < limit; offset += pageSize) {
      const page = inventory.listPresent(rootId, { limit: pageSize, offset });
      if (page.length === 0) break;
      for (const record of page) {
        if (links.get(join(rootPath, record.relativePath))) continue;
        ids.push(record.id);
        if (ids.length >= limit) break;
      }
      if (page.length < pageSize) break;
    }
    return ids;
  }

  /**
   * Turns inventory ids into importable paths.
   *
   * Rows that are missing from disk, or that belong to another folder, are dropped
   * rather than failing the whole request: a file can disappear between the scan and
   * the import, and losing the other 999 over it would be absurd.
   */
  resolveImportFiles(rootId: string, rootPath: string, inventoryIds: readonly string[]): ResolvedImportFile[] {
    const files: ResolvedImportFile[] = [];
    for (const row of this.deps.inventory.getManyByIds(inventoryIds)) {
      if (row.rootId !== rootId || row.inventoryStatus === "missing") continue;
      files.push({
        inventoryId: row.id,
        path: join(rootPath, row.relativePath),
        format: row.format,
      });
    }
    return files;
  }

  async decide(rootId: string, rootPath: string, findingId: string, decision: "accept" | "reject"): Promise<ScanDecisionResult> {
    const { findings, inventory } = this.deps;
    const finding = findings.getFinding(findingId);
    if (!finding) throw new ReaderError("INVALID_REQUEST", "FINDING_NOT_FOUND");
    if (finding.rootId !== rootId) throw new ReaderError("INVALID_REQUEST", "FINDING_NOT_IN_ROOT");

    if (isResolved(finding.status)) {
      return {
        findingId,
        status: finding.status,
        applied: false,
        summary: "这个条目已经有结论了，未做改动。",
        affectedBookIds: [],
      };
    }

    if (decision === "reject") {
      findings.updateStatus(findingId, "rejected", this.deps.now());
      return { findingId, status: "rejected", applied: false, summary: "已忽略。", affectedBookIds: [] };
    }

    const links = loadLibraryLinks(this.deps.db);
    const series = this.seriesContext(rootId, rootPath, links);
    const existing = series.organized.get(findingId);
    if (existing) {
      // Reachable from a screen that was rendered before the books were filed. Say so
      // instead of creating a second collection under the filename-derived name.
      return {
        findingId,
        status: finding.status,
        applied: false,
        summary: `这些书已经在珍藏「${existing.name}」里了，无需重复归入。`,
        affectedBookIds: [],
      };
    }

    const detail = this.toDetail(finding, inventory, links, series);
    return this.applyAction(finding, rootPath, detail.proposedAction);
  }

  /**
   * Clears a whole queue.
   *
   * What this does *not* do is decide the hard cases. A duplicate whose filenames
   * disagree about the volume, a series with nothing imported yet, and a series the user
   * has already filed by hand are counted as `skipped` and left alone, because none of
   * them has an answer that can be derived from the evidence — the first needs someone to
   * look at it, the second needs an import first, and the third is already done.
   * Reporting them as successes would be the worst outcome: the queue would look empty
   * and the work would not have happened.
   */
  async decideBatch(
    rootId: string,
    rootPath: string,
    kind: ScanFindingKind,
    decision: "accept" | "reject",
  ): Promise<ScanBatchDecisionResult> {
    const { findings, inventory } = this.deps;
    const ids = findings.listOpenIds(rootId, kind, MAX_BATCH_FINDINGS);
    const links = loadLibraryLinks(this.deps.db);
    const series = kind === "exact_duplicate"
      ? EMPTY_SERIES_CONTEXT
      : this.seriesContext(rootId, rootPath, links);

    let applied = 0;
    let failed = 0;
    let skipped = 0;
    const affectedBookIds: string[] = [];

    for (const id of ids) {
      const finding = findings.getFinding(id);
      if (!finding || isResolved(finding.status)) {
        skipped += 1;
        continue;
      }

      if (decision === "reject") {
        findings.updateStatus(id, "rejected", this.deps.now());
        applied += 1;
        continue;
      }

      if (series.organized.has(id)) {
        skipped += 1;
        continue;
      }

      const action = this.proposeAction(finding, inventory, links, series);
      // The batch runs on a folder the user pointed at, so its actions are limited to
      // the ones whose consequence is unambiguous from the evidence alone.
      if (action.kind === "none") {
        skipped += 1;
        continue;
      }
      if (action.kind === "recycle_duplicates"
        && finding.evidence.kind === "exact_duplicate"
        && finding.evidence.volumeConflict) {
        skipped += 1;
        continue;
      }

      const result = await this.applyAction(finding, rootPath, action);
      if (result.applied) applied += 1;
      else if (result.status === "stale") failed += 1;
      else skipped += 1;
      affectedBookIds.push(...result.affectedBookIds);
    }

    return {
      kind,
      considered: ids.length,
      applied,
      failed,
      skipped,
      summary: describeBatch(kind, decision, { applied, failed, skipped, considered: ids.length }),
      affectedBookIds: [...new Set(affectedBookIds)],
    };
  }

  /**
   * Adds books to a collection, importing anything not in the library first.
   *
   * The import half is handed back to the caller as files to run rather than executed
   * here, because a thousand-file import needs progress and cancellation and this
   * service answers requests. See ScanImportService.
   */
  prepareCollection(rawName: string | undefined, collectionId: string | undefined): Promise<{ id: string; name: string }> {
    if (collectionId) {
      return this.deps.collections.list().then((list) => {
        const found = list.find((item) => item.id === collectionId);
        if (!found) throw new ReaderError("INVALID_REQUEST", "珍藏不存在。");
        return { id: found.id, name: found.name };
      });
    }
    const name = safeCollectionName(rawName ?? "");
    if (!name) throw new ReaderError("INVALID_REQUEST", "请填写珍藏名称。");
    return this.ensureCollection(name);
  }

  /**
   * Files books into a collection, tolerating books that vanished in between.
   *
   * `addBooks` refuses the whole request if any id is unknown, which is right for the
   * collections UI where the user picked from a list they were just looking at. Here
   * the ids were resolved from a scan that may be minutes old, so a book the user
   * deleted in the meantime would otherwise take the rest of the series with it.
   */
  async addBooksToCollection(collectionId: string, bookIds: readonly string[]): Promise<number> {
    const unique = [...new Set(bookIds)];
    if (unique.length === 0) return 0;
    const placeholders = unique.map(() => "?").join(",");
    const rows = this.deps.db.prepare(
      `SELECT id FROM books WHERE id IN (${placeholders})`,
    ).all(...unique) as Array<{ id: string }>;
    const present = rows.map((row) => row.id);
    if (present.length === 0) return 0;
    await this.deps.collections.addBooks(collectionId, present);
    return present.length;
  }

  /** Collections the user can file into, for the organize picker. */
  async listCollections(): Promise<Array<{ id: string; name: string; bookCount: number }>> {
    const list = await this.deps.collections.list();
    return list.map((item) => ({ id: item.id, name: item.name, bookCount: item.bookCount }));
  }

  private async ensureCollection(name: string): Promise<{ id: string; name: string }> {
    const existing = (await this.deps.collections.list()).find(
      (collection) => normalizeCollectionName(collection.name) === normalizeCollectionName(name),
    );
    if (existing) return { id: existing.id, name: existing.name };
    const created = await this.deps.collections.create(name);
    return { id: created.id, name: created.name };
  }

  // --- Internals ---

  private async applyAction(
    finding: ScanFindingRecord,
    rootPath: string,
    action: ScanProposedAction,
  ): Promise<ScanDecisionResult> {
    const { findings } = this.deps;

    if (action.kind === "none") {
      return {
        findingId: finding.id,
        status: finding.status,
        applied: false,
        summary: describeNoAction(action),
        affectedBookIds: [],
      };
    }

    // Marked accepted before the work starts, so an interrupted apply leaves the
    // finding in a state that says "the user approved this" rather than silently
    // reverting to "new" and asking again.
    findings.updateStatus(finding.id, "accepted", this.deps.now());

    if (action.kind === "create_collection") {
      return this.applyCollection(finding, action);
    }
    return this.applyRecycle(finding, rootPath, action);
  }

  private async applyCollection(
    finding: ScanFindingRecord,
    action: Extract<ScanProposedAction, { kind: "create_collection" }>,
  ): Promise<ScanDecisionResult> {
    const name = safeCollectionName(action.name);
    if (!name) {
      return {
        findingId: finding.id,
        status: finding.status,
        applied: false,
        summary: "无法从文件名推断出可用的系列名，未创建珍藏。",
        affectedBookIds: [],
      };
    }

    const collection = await this.ensureCollection(name);
    await this.deps.collections.addBooks(collection.id, action.bookIds);

    this.deps.findings.updateStatus(finding.id, "auto_applied", this.deps.now());
    this.deps.operations.record({
      reviewId: finding.id,
      actionId: `collection:${finding.id}`,
      kind: "import",
      bookId: action.bookIds[0] ?? null,
      candidatePath: finding.candidateIds.join(", "),
      priorSourcePath: null,
      contentHash: "",
      reason: `已确认系列，归入珍藏「${collection.name}」`,
      outcome: "completed",
    });

    return {
      findingId: finding.id,
      status: "auto_applied",
      applied: true,
      summary: `已把 ${action.bookIds.length} 本书归入珍藏「${collection.name}」。`,
      affectedBookIds: action.bookIds,
    };
  }

  private async applyRecycle(
    finding: ScanFindingRecord,
    rootPath: string,
    action: Extract<ScanProposedAction, { kind: "recycle_duplicates" }>,
  ): Promise<ScanDecisionResult> {
    const outcome = await this.deps.recycler.applyExactDuplicateFinding({ finding, rootPath });

    if (outcome.status === "stale") {
      return {
        findingId: finding.id,
        status: "stale",
        applied: false,
        summary: `文件在扫描后发生了变化，没有移动任何文件：${outcome.reason}`,
        affectedBookIds: [],
      };
    }

    if (outcome.status === "partial") {
      return {
        findingId: finding.id,
        status: "accepted",
        applied: true,
        summary: `已移除 ${outcome.recycled} 个重复文件（${formatBytes(outcome.reclaimedBytes)}），另有 ${outcome.failed} 个失败。`,
        affectedBookIds: [],
      };
    }

    this.deps.findings.updateStatus(finding.id, "auto_applied", this.deps.now());
    return {
      findingId: finding.id,
      status: "auto_applied",
      applied: true,
      summary: `已移除 ${outcome.recycled} 个重复文件，释放 ${formatBytes(outcome.reclaimedBytes)}。`,
      affectedBookIds: [],
    };
  }

  private toDetail(
    record: ScanFindingRecord,
    inventory: FileInventoryRepository,
    links: LibraryLinkIndex,
    series: SeriesContext,
  ): ScanFindingDetail {
    const root = this.deps.roots.getById(record.rootId);
    const candidates = inventory
      .getManyByIds(record.candidateIds)
      .map((row) => this.buildCandidate(row, root?.rootPath ?? "", links))
      .filter((candidate): candidate is ScanFindingCandidate => candidate !== null);

    return {
      id: record.id,
      kind: record.kind,
      status: record.status,
      summary: describeFinding(record, candidates),
      candidateCount: candidates.length,
      confidence: record.confidence,
      createdAt: record.createdAt,
      resolvedAt: record.resolvedAt,
      evidence: record.evidence,
      candidates,
      proposedAction: this.proposeAction(record, inventory, links, series),
    };
  }

  /**
   * What the scan knows about collections, for the series findings of one folder.
   *
   * Two questions get asked of this, and they are different:
   *
   *  - "is this series finished?" — every file of it is in the library *and* all of those
   *    books sit in one collection. Those findings are hidden: there is no suggestion
   *    left to make.
   *  - "where do these books already live?" — asked of any subset, so a series that is
   *    half shelved aims its remaining volumes at the collection the user already chose
   *    instead of at a new one named after the file.
   *
   * The second question is what the reported problem needed. Collections are named by
   * the user, so matching on the filename-derived series name was never going to find
   * them; membership is the only thing that actually knows.
   */
  private seriesContext(
    rootId: string,
    rootPath: string,
    links: LibraryLinkIndex,
  ): SeriesContext {
    const open = this.deps.findings.listByRoot(rootId, {
      limit: MAX_BATCH_FINDINGS,
      includeResolved: false,
      kind: "series_volume",
    });
    const organized = new Map<string, OrganizedTarget>();
    if (open.length === 0) {
      return { organized, sharedCollectionOf: () => null, preferredCollectionFor: () => null };
    }

    // One pass over the candidates: which books each finding has in the library, and
    // the union of them all, so the membership lookup is a single query.
    const importedByFinding = new Map<string, string[]>();
    const completeFindings = new Set<string>();
    const everyBookId = new Set<string>();
    for (const record of open) {
      const rows = this.deps.inventory.getManyByIds(record.candidateIds);
      const bookIds: string[] = [];
      let complete = rows.length > 0;
      for (const row of rows) {
        const link = links.get(join(rootPath, row.relativePath));
        if (!link) {
          complete = false;
          continue;
        }
        bookIds.push(link.bookId);
        everyBookId.add(link.bookId);
      }
      if (bookIds.length > 0) importedByFinding.set(record.id, bookIds);
      if (complete) completeFindings.add(record.id);
    }

    const membersByCollection = new Map<string, Set<string>>();
    if (everyBookId.size > 0) {
      for (const membership of this.deps.collections.getMemberships([...everyBookId])) {
        membersByCollection.set(membership.collectionId, new Set(membership.bookIds));
      }
    }

    const sharedCollectionOf = (bookIds: readonly string[]): OrganizedTarget | null => {
      if (bookIds.length === 0) return null;
      for (const [collectionId, members] of membersByCollection) {
        if (!bookIds.every((bookId) => members.has(bookId))) continue;
        return { collectionId, name: this.collectionName(collectionId) };
      }
      return null;
    };

    const filed = new Set<string>();
    for (const members of membersByCollection.values()) {
      for (const bookId of members) filed.add(bookId);
    }
    const preferredCollectionFor = (bookIds: readonly string[]): OrganizedTarget | null =>
      sharedCollectionOf(bookIds.filter((bookId) => filed.has(bookId)));

    for (const findingId of completeFindings) {
      const target = sharedCollectionOf(importedByFinding.get(findingId) ?? []);
      if (target) organized.set(findingId, target);
    }

    return { organized, sharedCollectionOf, preferredCollectionFor };
  }

  /**
   * A collection's name.
   *
   * Read straight from the table rather than through `CustomCollectionService.list()`,
   * which is async and loads every book in the library to build its previews — a lot of
   * work to learn what a collection is called.
   */
  private collectionName(collectionId: string): string {
    const row = this.deps.db.prepare("SELECT name FROM collections WHERE id = ?")
      .get(collectionId) as { name: string } | undefined;
    return row?.name ?? "已有珍藏";
  }

  private buildCandidate(
    row: FileInventoryRecord,
    rootPath: string,
    links: LibraryLinkIndex,
  ): ScanFindingCandidate | null {
    const link = rootPath ? links.get(join(rootPath, row.relativePath)) : undefined;
    const candidate: ScanFindingCandidate = {
      inventoryId: row.id,
      relativePath: sanitizeRelativePath(row.relativePath),
      format: row.format,
      fileSize: row.fileSize,
      modifiedAt: row.modifiedAt,
      title: row.metadata?.title ?? null,
      author: row.metadata?.author ?? null,
      bookId: link?.available ? link.bookId : null,
    };
    // One unusable row must not take the whole review screen down with it: the
    // contracts are strict, so an unrepresentable record is dropped here rather than
    // thrown at the IPC boundary where it would fail the entire page.
    return ScanFindingCandidateSchema.safeParse(candidate).success ? candidate : null;
  }

  private proposeAction(
    record: ScanFindingRecord,
    inventory: FileInventoryRepository,
    links: LibraryLinkIndex,
    series: SeriesContext,
  ): ScanProposedAction {
    const root = this.deps.roots.getById(record.rootId);
    const candidates = inventory
      .getManyByIds(record.candidateIds)
      .map((row) => this.buildCandidate(row, root?.rootPath ?? "", links))
      .filter((candidate): candidate is ScanFindingCandidate => candidate !== null);

    if (record.kind === "exact_duplicate" && record.evidence.kind === "exact_duplicate") {
      const survivorId = record.evidence.survivorInventoryId;
      const victims = candidates.filter((candidate) => candidate.inventoryId !== survivorId);
      if (victims.length === 0) {
        return { kind: "none", reason: "evidence_stale" };
      }
      return {
        kind: "recycle_duplicates",
        survivorInventoryId: survivorId,
        victimInventoryIds: victims.map((victim) => victim.inventoryId),
        reclaimableBytes: victims.reduce((total, victim) => total + victim.fileSize, 0),
      };
    }

    if (record.kind === "series_volume") {
      const bookIds = candidates
        .map((candidate) => candidate.bookId)
        .filter((bookId): bookId is string => bookId !== null);
      if (bookIds.length === 0) {
        // Not a dead end: the caller turns this into "import these first", which is the
        // step that makes the finding actionable.
        return { kind: "none", reason: "nothing_imported" };
      }
      // Some of the series is already shelved: aim at the collection it is in rather than
      // at a new one named after the file, which is how a user who named their own
      // collection would end up with a second, unwanted one.
      const existing = series.preferredCollectionFor(bookIds);
      const name = existing?.name
        ?? (record.evidence.kind === "series_volume" ? record.evidence.normalizedSeries : "");
      if (!safeCollectionName(name)) {
        return { kind: "none", reason: "nothing_imported" };
      }
      return { kind: "create_collection", name, bookIds };
    }

    // `edition_variant` is not produced by local resolution yet; it belongs to the
    // agent layer, which is deliberately not wired. Until then there is nothing to
    // confirm, and saying so is better than an accept button that does nothing.
    return { kind: "none", reason: "nothing_imported" };
  }

  private reclaimableBytes(record: ScanFindingRecord, rootPath: string, links: LibraryLinkIndex): number {
    const candidates = this.deps.inventory
      .getManyByIds(record.candidateIds)
      .map((row) => this.buildCandidate(row, rootPath, links))
      .filter((candidate): candidate is ScanFindingCandidate => candidate !== null);
    const survivorId = record.evidence.kind === "exact_duplicate"
      ? record.evidence.survivorInventoryId
      : null;
    return candidates
      .filter((candidate) => candidate.inventoryId !== survivorId)
      .reduce((total, candidate) => total + candidate.fileSize, 0);
  }

  private countImportedCandidates(record: ScanFindingRecord, rootPath: string, links: LibraryLinkIndex): number {
    return this.deps.inventory
      .getManyByIds(record.candidateIds)
      .filter((row) => links.get(join(rootPath, row.relativePath)) !== undefined)
      .length;
  }

  private latestScanTime(rootId: string): string | null {
    const row = this.deps.db.prepare(
      "SELECT ended_at, last_heartbeat_at FROM scan_jobs WHERE root_id = ? AND state = 'completed' ORDER BY ended_at DESC LIMIT 1",
    ).get(rootId) as { ended_at: string | null; last_heartbeat_at: string } | undefined;
    return row?.ended_at ?? row?.last_heartbeat_at ?? null;
  }
}

function isResolved(status: ScanFindingRecord["status"]): boolean {
  return status === "stale" || status === "rejected" || status === "auto_applied";
}

/**
 * Relative paths are the one filesystem shape the renderer receives, so they are
 * normalized here rather than trusted from the walker: separators are unified and
 * traversal segments removed, so a row can never describe a location outside the
 * scanned folder. Rows the walker wrote are already in this form — this is the check
 * for the ones it did not write.
 */
function sanitizeRelativePath(relativePath: string): string {
  const segments = relativePath
    .replace(/\\/gu, "/")
    .split("/")
    .filter((segment) => segment !== "" && segment !== "." && segment !== "..");
  return segments.length > 0 ? segments.join("/") : "unknown";
}

export function safeCollectionName(name: string): string | null {
  const parsed = CollectionNameSchema.safeParse(name.trim());
  return parsed.success ? parsed.data : null;
}

function describeNoAction(action: Extract<ScanProposedAction, { kind: "none" }>): string {
  switch (action.reason) {
    case "nothing_imported":
      return "这些文件还没有进入书库，先导入后才能整理。";
    case "evidence_stale":
      return "扫描结果已过期，请重新扫描后再处理。";
    case "already_decided":
      return "这个条目已经有结论了，未做改动。";
  }
}

function describeBatch(
  kind: ScanFindingKind,
  decision: "accept" | "reject",
  counts: { applied: number; failed: number; skipped: number; considered: number },
): string {
  const label = kind === "exact_duplicate" ? "重复文件" : kind === "series_volume" ? "疑似系列" : "条目";
  if (counts.considered === 0) return `没有待处理的${label}。`;
  if (decision === "reject") {
    return `已忽略 ${counts.applied} 条${label}${counts.skipped > 0 ? `，跳过 ${counts.skipped} 条` : ""}。`;
  }
  const parts = [`已处理 ${counts.applied} 条${label}`];
  if (counts.skipped > 0) parts.push(`跳过 ${counts.skipped} 条（需要单独确认或先导入）`);
  if (counts.failed > 0) parts.push(`${counts.failed} 条因文件已变化未执行`);
  return `${parts.join("，")}。`;
}

function describeFinding(record: ScanFindingRecord, candidates: ScanFindingCandidate[]): string {
  const totalBytes = candidates.reduce((sum, candidate) => sum + candidate.fileSize, 0);
  if (record.kind === "exact_duplicate") {
    const conflict = record.evidence.kind === "exact_duplicate" && record.evidence.volumeConflict;
    return conflict
      ? `内容完全相同的 ${candidates.length} 个文件，但文件名暗示的卷数不一致，需要你确认`
      : `内容完全相同的 ${candidates.length} 个文件（${formatBytes(totalBytes)}）`;
  }
  if (record.kind === "series_volume") {
    const name = record.evidence.kind === "series_volume" ? record.evidence.normalizedSeries : "未命名";
    const imported = candidates.filter((candidate) => candidate.bookId !== null).length;
    return imported === 0
      ? `疑似系列「${name}」，共 ${candidates.length} 个文件，均未入库`
      : `疑似系列「${name}」，共 ${candidates.length} 个文件，其中 ${imported} 本已入库`;
  }
  return `可能的不同版本，共 ${candidates.length} 个文件`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}
