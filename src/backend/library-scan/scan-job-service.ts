import { basename, join } from "node:path";
import {
  LibraryScanCounters,
  LibraryScanPhase,
  LibraryScanSnapshot,
} from "../../shared/contracts.js";
import { ReaderError } from "../../shared/errors.js";
import { FileInventoryRepository } from "./file-inventory-repository.js";
import { WalkedInventoryEntry } from "./inventory-walker.js";
import { LibraryRootRepository } from "./library-root-repository.js";
import { LightweightMetadataExtractor } from "./lightweight-metadata-extractor.js";
import { LocalResolutionService } from "./local-resolution-service.js";
import { ScanJobRepository } from "./scan-job-repository.js";
import { AgentResolutionService, type AgentResolutionFinding, type PublicFileMetadata } from "./agent-resolution-service.js";
import { ScanFindingRepository } from "./scan-finding-repository.js";
import type { LibraryLinkIndex } from "./library-link.js";
import { fullContentHash } from "../library/fingerprint.js";
import type { InventoryEntryInput } from "./types.js";

/** Rows written per inventory commit; also the unit of yielding to the event loop. */
const INVENTORY_BATCH_SIZE = 200;
import { quickFingerprint } from "../library/fingerprint.js";

export type ScanJobServiceDependencies = {
  roots: LibraryRootRepository;
  inventory: FileInventoryRepository;
  jobs: ScanJobRepository;
  metadataExtractor: LightweightMetadataExtractor;
  resolutionService: LocalResolutionService;
  getManagedRoot(): Promise<string | null>;
  canonicalizeRoot(path: string): Promise<string>;
  walk(root: string, signal: AbortSignal): AsyncGenerator<WalkedInventoryEntry>;
  /** Snapshot of what the library already owns, so resolution can correlate by path. */
  loadLibraryLinks(): LibraryLinkIndex;
  now(): string;
  agentService?: AgentResolutionService;
  findingsRepo?: ScanFindingRepository;
};

type RuntimeHandle = {
  controller: AbortController;
  paused: boolean;
  resumeWaiters: Array<() => void>;
  runPromise?: Promise<void>;
};

export class ScanJobService {
  private readonly runtime = new Map<string, RuntimeHandle>();
  private readonly listeners = new Set<(snapshot: LibraryScanSnapshot) => void>();
  private readonly lastEmission = new Map<string, { at: number; processed: number }>();

  constructor(private readonly deps: ScanJobServiceDependencies) {}

  recoverInterruptedJobs(): number {
    return this.deps.jobs.markInterruptedRecoverable(this.deps.now());
  }

  async start(): Promise<LibraryScanSnapshot> {
    const rawRoot = await this.deps.getManagedRoot();
    if (!rawRoot) throw new ReaderError("INVALID_REQUEST", "MANAGED_FOLDER_REQUIRED");

    const canonicalRoot = await this.deps.canonicalizeRoot(rawRoot);
    const displayName = basename(canonicalRoot) || canonicalRoot;
    const now = this.deps.now();
    const root = this.deps.roots.ensureRoot(canonicalRoot, displayName, now);

    const active = this.deps.jobs.getActiveForRoot(root.id);
    if (active) return this.deps.jobs.toPublicSnapshot(active, root.displayName);

    const newJob = this.deps.jobs.create(root.id, now);
    const snapshot = this.deps.jobs.toPublicSnapshot(newJob, root.displayName);
    this.emit(snapshot);

    const handle: RuntimeHandle = { controller: new AbortController(), paused: false, resumeWaiters: [] };
    this.runtime.set(newJob.id, handle);
    handle.runPromise = this.runPipeline(newJob.id, root.id, root.rootPath, root.displayName, handle);
    return snapshot;
  }

  getActive(): LibraryScanSnapshot | null {
    const active = this.deps.jobs.getAnyActive();
    if (!active) return null;
    const root = this.deps.roots.getById(active.rootId);
    return this.deps.jobs.toPublicSnapshot(active, root?.displayName ?? "Library");
  }

  pause(jobId: string): LibraryScanSnapshot {
    const job = this.deps.jobs.get(jobId);
    if (!job) throw new ReaderError("INVALID_REQUEST", `Job ${jobId} not found`);
    const root = this.deps.roots.getById(job.rootId);
    const rootName = root?.displayName ?? "Library";
    if (job.state !== "running" && job.state !== "queued") return this.deps.jobs.toPublicSnapshot(job, rootName);

    const updated = this.deps.jobs.update(jobId, { state: "paused", lastHeartbeatAt: this.deps.now() });
    const handle = this.runtime.get(jobId);
    if (handle) handle.paused = true;
    const snapshot = this.deps.jobs.toPublicSnapshot(updated, rootName);
    this.emit(snapshot);
    return snapshot;
  }

  async resume(jobId: string): Promise<LibraryScanSnapshot> {
    const job = this.deps.jobs.get(jobId);
    if (!job) throw new ReaderError("INVALID_REQUEST", `Job ${jobId} not found`);
    const root = this.deps.roots.getById(job.rootId);
    if (!root) throw new ReaderError("DATABASE_ERROR", `Root ${job.rootId} not found`);

    if (job.state === "paused") {
      const updated = this.deps.jobs.update(jobId, { state: "running", lastHeartbeatAt: this.deps.now() });
      const handle = this.runtime.get(jobId);
      if (handle) { handle.paused = false; for (const w of handle.resumeWaiters.splice(0)) w(); }
      const snap = this.deps.jobs.toPublicSnapshot(updated, root.displayName);
      this.emit(snap);
      return snap;
    }
    if (job.state === "recoverable") {
      const updated = this.deps.jobs.update(jobId, { state: "running", lastHeartbeatAt: this.deps.now() });
      const snap = this.deps.jobs.toPublicSnapshot(updated, root.displayName);
      this.emit(snap);
      const handle: RuntimeHandle = { controller: new AbortController(), paused: false, resumeWaiters: [] };
      this.runtime.set(jobId, handle);
      // Resume from the persisted phase
      handle.runPromise = this.runPipeline(jobId, root.id, root.rootPath, root.displayName, handle, updated.phase);
      return snap;
    }
    return this.deps.jobs.toPublicSnapshot(job, root.displayName);
  }

  cancel(jobId: string): LibraryScanSnapshot {
    const job = this.deps.jobs.get(jobId);
    if (!job) throw new ReaderError("INVALID_REQUEST", `Job ${jobId} not found`);
    const root = this.deps.roots.getById(job.rootId);
    const rootName = root?.displayName ?? "Library";
    if (job.state === "completed" || job.state === "cancelled" || job.state === "failed")
      return this.deps.jobs.toPublicSnapshot(job, rootName);

    const updated = this.deps.jobs.update(jobId, { state: "cancelled", endedAt: this.deps.now(), lastHeartbeatAt: this.deps.now() });
    const handle = this.runtime.get(jobId);
    if (handle) { handle.paused = false; for (const w of handle.resumeWaiters.splice(0)) w(); handle.controller.abort(); }
    const snap = this.deps.jobs.toPublicSnapshot(updated, rootName);
    this.emit(snap);
    return snap;
  }

  subscribe(listener: (snapshot: LibraryScanSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  // --- Pipeline ---

  private async runPipeline(jobId: string, rootId: string, rootPath: string, rootName: string, handle: RuntimeHandle, startPhase?: LibraryScanPhase): Promise<void> {
    const phase = startPhase ?? "inventory";
    try {
      if (phase === "inventory") {
        await this.runInventoryPhase(jobId, rootId, rootPath, rootName, handle);
        handle.controller.signal.throwIfAborted();
        await this.transitionPhase(jobId, rootName, "metadata");
      }
      if (phase === "inventory" || phase === "metadata") {
        await this.runMetadataPhase(jobId, rootId, rootPath, rootName, handle);
        handle.controller.signal.throwIfAborted();
        await this.transitionPhase(jobId, rootName, "local_resolution");
      }
      // local_resolution phase (always runs after metadata)
      await this.runResolutionPhase(jobId, rootId, rootPath, rootName, handle);
      handle.controller.signal.throwIfAborted();

      // agent_resolution phase (runs after local_resolution)
      //
      // Requires both halves of the pair. The phase reads findings and hands them to
      // the model, so an agent without the repository is a wiring mistake, not a
      // request to run: it used to throw inside the try below and mark the whole scan
      // `failed`, which is a confusing way to report a missing dependency.
      if (this.deps.agentService && this.deps.findingsRepo) {
        await this.runAgentResolutionPhase(jobId, rootId, rootPath, rootName, handle);
        handle.controller.signal.throwIfAborted();
      }

      // There is deliberately no "apply" phase.
      //
      // This pipeline used to end by recycling every duplicate it had found and by
      // writing accepted series into the library, with no confirmation in between: the
      // user pressed "scan" and files left their folder. A scan now only observes. It
      // produces findings; acting on a finding happens through ScanReviewService, one
      // finding at a time, after that finding's consequence has been shown and
      // confirmed. See duplicate-recycle-service.ts for the file-moving half.

      // Index refresh is deliberately NOT done here.
      //
      // This used to call reindexAll() unconditionally, which re-derives the text
      // index for the entire library on the main process after every scan — minutes of
      // blocking work, for books nothing had changed. A scan does not modify any book;
      // it only observes the filesystem. When it eventually does apply changes, those
      // specific books are indexed by the normal import path, which is already wired
      // to textIndexer.enqueue (see main/bootstrap/services.ts).

      await this.completeJob(jobId, rootName);
    } catch (cause: unknown) {
      const causeErr = cause as { name?: string } | null;
      const isAbort = causeErr?.name === "AbortError" || handle.controller.signal.aborted;
      const finalState = isAbort ? "cancelled" : "failed";
      const currentJob = this.deps.jobs.get(jobId);
      if (currentJob && currentJob.state !== "cancelled" && currentJob.state !== "completed") {
        const failed = this.deps.jobs.update(jobId, { state: finalState, errorCode: isAbort ? null : "SCAN_FAILED", lastHeartbeatAt: this.deps.now(), endedAt: this.deps.now() });
        this.lastEmission.delete(jobId);
        // Emitting the terminal snapshot matters as much here as on the success path.
        // Without it the renderer, which learns about progress only from this stream,
        // keeps showing a running job that will never progress again.
        const job = this.deps.jobs.get(failed.id);
        const root = job ? this.deps.roots.getById(job.rootId) : null;
        if (job) this.emit(this.deps.jobs.toPublicSnapshot(job, root?.displayName ?? "Library"));
      }
    } finally {
      this.runtime.delete(jobId);
    }
  }

  private async transitionPhase(jobId: string, rootName: string, phase: LibraryScanPhase): Promise<void> {
    const current = this.deps.jobs.get(jobId);
    if (!current) return;
    const counters = current.counters;
    const updated = this.deps.jobs.update(jobId, { phase, counters, lastHeartbeatAt: this.deps.now() });
    this.lastEmission.delete(jobId);
    this.emit(this.deps.jobs.toPublicSnapshot(updated, rootName));
  }

  private async completeJob(jobId: string, rootName: string): Promise<void> {
    const current = this.deps.jobs.get(jobId);
    if (!current) return;
    const updated = this.deps.jobs.update(jobId, { state: "completed", phase: "completed", counters: current.counters, lastHeartbeatAt: this.deps.now(), endedAt: this.deps.now() });
    this.lastEmission.delete(jobId);
    this.emit(this.deps.jobs.toPublicSnapshot(updated, rootName));
  }

  // --- Inventory Phase ---

  private async runInventoryPhase(jobId: string, rootId: string, rootPath: string, rootName: string, handle: RuntimeHandle): Promise<void> {
    const now = () => this.deps.now();
    const counters: LibraryScanCounters = { discovered: 0, supported: 0, cached: 0, queued: 0, processed: 0, skipped: 0, errors: 0, metadataTotal: 0, metadataProcessed: 0, metadataErrors: 0, resolutionTotal: 0, resolutionProcessed: 0, resolutionFindings: 0, resolutionRecycled: 0, agentTotal: 0, agentProcessed: 0, agentResolved: 0, agentPending: 0, seriesApplied: 0, seriesSkipped: 0 };

    this.deps.jobs.update(jobId, { state: "running", phase: "inventory", lastHeartbeatAt: now() });
    this.deps.inventory.beginScan(rootId, now());

    // Walk in batches. Committing once per file means one fsync per file on the main
    // process, which stalls the UI on a large tree; one commit per batch does not.
    // The batch is also the unit of yielding, so the event loop stays responsive.
    let batch: InventoryEntryInput[] = [];

    const flushBatch = () => {
      if (batch.length === 0) return;
      try {
        const outcome = this.deps.inventory.upsertSeenBatch(rootId, jobId, batch, now());
        counters.cached += outcome.cached;
        counters.queued += outcome.queued;
        counters.errors += outcome.errors;
      } catch {
        // A failed batch must not abort the whole scan; account for it and continue.
        counters.errors += batch.length;
      }
      batch = [];
      this.persist(jobId, rootName, counters);
    };

    for await (const entry of this.deps.walk(rootPath, handle.controller.signal)) {
      await this.waitIfPaused(handle);
      handle.controller.signal.throwIfAborted();
      counters.discovered++; counters.supported++; counters.processed++;
      batch.push(entry);
      if (batch.length >= INVENTORY_BATCH_SIZE) {
        flushBatch();
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    flushBatch();

    counters.metadataTotal = counters.queued;
    this.flushCounters(jobId, rootName, counters, now());
  }

  // --- Metadata Phase ---

  private async runMetadataPhase(jobId: string, rootId: string, rootPath: string, rootName: string, handle: RuntimeHandle): Promise<void> {
    const now = () => this.deps.now();
    const current = this.deps.jobs.get(jobId);
    const counters = { ...(current?.counters ?? {}) } as LibraryScanCounters;

    // Loop until the work list drains. listMetadataWork returns one bounded page, so
    // a library larger than a page previously stopped after the first batch: every
    // later file silently never received metadata, and the total was taken from that
    // truncated page so progress still reported completion.
    //
    // The total is read once from the database rather than summed over pages, so it
    // stays the real workload size no matter how many pages the loop needs.
    counters.metadataTotal = this.deps.inventory.countMetadataPending(rootId);

    // Rows that fail extraction keep metadata_json NULL, so they would be served on
    // every page and the loop would never drain. Already-attempted ids are excluded in
    // the query rather than filtered afterwards: SQL applies LIMIT first, so filtering
    // in memory lets repeat rows consume page capacity and the final page can come back
    // empty while rows remain. Failures stay queued for the next scan.
    const attempted: string[] = [];

    for (;;) {
      await this.waitIfPaused(handle);
      handle.controller.signal.throwIfAborted();

      const workItems = this.deps.inventory.listMetadataWork(rootId, 500, attempted);
      if (workItems.length === 0) break;
      for (const item of workItems) attempted.push(item.id);

      for (const item of workItems) {
        await this.waitIfPaused(handle);
        handle.controller.signal.throwIfAborted();
        try {
          const fp = await quickFingerprint(join(rootPath, item.relativePath));
          this.deps.inventory.saveFingerprint(item.id, fp.version, fp.fingerprint, now());
          const metadata = await this.deps.metadataExtractor.extract({
            absolutePath: join(rootPath, item.relativePath),
            displayFileName: item.relativePath,
            format: item.format,
          });
          this.deps.inventory.saveMetadata(item.id, metadata, now());
          counters.metadataProcessed++;
        } catch {
          this.deps.inventory.markMetadataError(item.id, "METADATA_FAILED", now());
          counters.metadataErrors++;
        }
        counters.processed++;
        this.persist(jobId, rootName, counters);
      }
    }
    this.flushCounters(jobId, rootName, counters, now());
    if (process.env.READER_SCAN_DEBUG === "1") {
      console.log(`[scan-dbg] metadata done: total=${counters.metadataTotal} processed=${counters.metadataProcessed} errors=${counters.metadataErrors}`);
    }
  }

  // --- Resolution Phase ---

  private async runResolutionPhase(jobId: string, rootId: string, rootPath: string, rootName: string, handle: RuntimeHandle): Promise<void> {
    const now = () => this.deps.now();
    const current = this.deps.jobs.get(jobId);
    const counters = { ...(current?.counters ?? {}) } as LibraryScanCounters;

    await this.waitIfPaused(handle);
    handle.controller.signal.throwIfAborted();

    counters.resolutionTotal = this.deps.inventory.countResolutionCandidates(rootId);

    const result = await this.deps.resolutionService.runLocalResolution({
      rootId, jobId, rootPath,
      computeFullHash: fullContentHash,
      now: now(),
      libraryLink: this.deps.loadLibraryLinks(),
      inventory: this.deps.inventory,
    });
    counters.resolutionFindings = result.findings.length;
    // Files whose full content was read to prove a duplicate. Reported rather than
    // silently absorbed, because it is what the phase actually spends its time on.
    counters.resolutionProcessed = result.examined;
    // Always zero: this phase no longer removes anything.
    counters.resolutionRecycled = 0;

    this.flushCounters(jobId, rootName, counters, now());
  }

  // --- Agent Resolution Phase ---

  private async runAgentResolutionPhase(jobId: string, rootId: string, rootPath: string, _rootName: string, handle: RuntimeHandle): Promise<void> {
    const svc = this.deps.agentService!;
    const findingsRepo = this.deps.findingsRepo!;
    const now = () => this.deps.now();

    await this.waitIfPaused(handle);
    this.deps.jobs.update(jobId, { phase: "agent_resolution", lastHeartbeatAt: now() });

    // Query all needs_review findings for this root and map to agent shape
    const records = findingsRepo.listByRoot(rootId, { limit: 500, offset: 0 });
    const reviewFindings: AgentResolutionFinding[] = records
      .filter((r) => r.status === "new" || r.status === "needs_review")
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        status: r.status,
        summary: r.kind,
      }));

    const job = this.deps.jobs.get(jobId);
    const counters = job ? { ...job.counters } : {
      processed: 0, discovered: 0, supported: 0, cached: 0, queued: 0, skipped: 0, errors: 0,
      metadataTotal: 0, metadataProcessed: 0, metadataErrors: 0,
      resolutionTotal: 0, resolutionProcessed: 0, resolutionFindings: 0, resolutionRecycled: 0,
      agentTotal: 0, agentProcessed: 0, agentResolved: 0, agentPending: 0,
      seriesApplied: 0, seriesSkipped: 0,
    };
    counters.agentTotal = reviewFindings.length;

    if (reviewFindings.length > 0) {
      // Build file metadata context from inventory
      const fileContexts = new Map<string, PublicFileMetadata>();
      for (const f of records) {
        for (const cid of f.candidateIds) {
          if (!fileContexts.has(cid)) {
            const inv = this.deps.inventory.getById(cid);
            if (inv) {
              fileContexts.set(cid, {
                relativePath: inv.relativePath,
                format: inv.format,
                metadata: inv.metadata ?? undefined,
              });
            }
          }
        }
      }

      try {
        const result = await svc.resolve({ findings: reviewFindings, fileContexts });
        counters.agentProcessed = reviewFindings.length;
        counters.agentResolved = result.resolved.length;
        counters.agentPending = result.remaining.length;
      } catch {
        // Agent error: mark all as pending, do NOT fail the job
        counters.agentProcessed = reviewFindings.length;
        counters.agentResolved = 0;
        counters.agentPending = reviewFindings.length;
      }
    }

    this.deps.jobs.update(jobId, { counters, lastHeartbeatAt: now() });
    this.flushCounters(jobId, _rootName, counters, now());
  }

  // --- Helpers ---

  private async waitIfPaused(handle: RuntimeHandle): Promise<void> {
    while (handle.paused && !handle.controller.signal.aborted) {
      await new Promise<void>((resolve) => { handle.resumeWaiters.push(resolve); });
    }
  }

  private persist(jobId: string, rootName: string, counters: LibraryScanCounters): void {
    const nowTime = Date.now();
    const last = this.lastEmission.get(jobId);
    const shouldEmit = !last || nowTime - last.at >= 200 || counters.processed - last.processed >= 50;
    if (shouldEmit) {
      const updated = this.deps.jobs.update(jobId, { counters, lastHeartbeatAt: this.deps.now() });
      this.lastEmission.set(jobId, { at: nowTime, processed: counters.processed });
      this.emit(this.deps.jobs.toPublicSnapshot(updated, rootName));
    }
  }

  private flushCounters(jobId: string, rootName: string, counters: LibraryScanCounters, now: string): void {
    this.deps.jobs.update(jobId, { counters, lastHeartbeatAt: now });
    this.lastEmission.delete(jobId);
  }

  private emit(snapshot: LibraryScanSnapshot): void {
    for (const listener of this.listeners) listener(snapshot);
  }
}
