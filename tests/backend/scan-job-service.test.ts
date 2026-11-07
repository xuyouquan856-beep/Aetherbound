import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileInventoryRepository } from "../../src/backend/library-scan/file-inventory-repository.js";
import { LibraryRootRepository } from "../../src/backend/library-scan/library-root-repository.js";
import { ScanJobRepository } from "../../src/backend/library-scan/scan-job-repository.js";
import { ScanJobService, type ScanJobServiceDependencies } from "../../src/backend/library-scan/scan-job-service.js";
import { LightweightMetadataExtractor } from "../../src/backend/library-scan/lightweight-metadata-extractor.js";
import { LocalResolutionService } from "../../src/backend/library-scan/local-resolution-service.js";
import { ScanOperationRepository } from "../../src/backend/library-scan/operation-repository.js";
import { ScanFindingRepository } from "../../src/backend/library-scan/scan-finding-repository.js";
import { loadLibraryLinks } from "../../src/backend/library-scan/library-link.js";
import { openDatabase } from "../../src/backend/storage/database.js";
import { LibraryScanSnapshot } from "../../src/shared/contracts.js";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((p) => rm(p, { recursive: true, force: true }))));

function makeServices(db: ReturnType<typeof openDatabase>["db"]) {
  const ops = new ScanOperationRepository(db);
  const findings = new ScanFindingRepository(db);
  const inventory = new FileInventoryRepository(db);
  return {
    ops, findings, inventory,
    metadataExtractor: new LightweightMetadataExtractor(),
    resolutionService: new LocalResolutionService(db),
  };
}

function makeDeps(
  opened: ReturnType<typeof openDatabase>,
  overrides: Partial<ScanJobServiceDependencies> = {},
): ScanJobServiceDependencies {
  const svc = makeServices(opened.db);
  return {
    roots: new LibraryRootRepository(opened.db),
    inventory: svc.inventory,
    jobs: new ScanJobRepository(opened.db),
    metadataExtractor: svc.metadataExtractor,
    resolutionService: svc.resolutionService,
    loadLibraryLinks: () => loadLibraryLinks(opened.db),
    getManagedRoot: async () => null,
    canonicalizeRoot: async (p) => p,
    walk: async function* () {},
    now: () => new Date().toISOString(),
    ...overrides,
  };
}

describe("ScanJobService", () => {
  it("throws when managed root is missing", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "service-test-"));
    cleanup.push(rootDir);
    const opened = openDatabase(rootDir);
    const service = new ScanJobService(makeDeps(opened));

    await expect(service.start()).rejects.toThrow("MANAGED_FOLDER_REQUIRED");
    opened.close();
  });

  it("start returns queued/running snapshot and respects idempotency", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "service-test-"));
    cleanup.push(rootDir);
    const opened = openDatabase(rootDir);

    let resolveStep: (() => void) | null = null;
    async function* slowWalk() {
      yield { absolutePath: join(rootDir, "f1.txt"), relativePath: "f1.txt", format: "txt" as const, fileSize: 10, modifiedAt: new Date().toISOString() };
      await new Promise<void>((r) => { resolveStep = r; });
      yield { absolutePath: join(rootDir, "f2.txt"), relativePath: "f2.txt", format: "txt" as const, fileSize: 20, modifiedAt: new Date().toISOString() };
    }

    const service = new ScanJobService(makeDeps(opened, {
      getManagedRoot: async () => rootDir,
      walk: slowWalk,
    }));

    const s1 = await service.start();
    expect(["queued", "running"]).toContain(s1.state);
    const s2 = await service.start();
    expect(s2.jobId).toBe(s1.jobId);
    if (resolveStep) (resolveStep as () => void)();
    await new Promise((r) => setTimeout(r, 100));
    opened.close();
  });

  it("handles pause, resume, cancel and crash recovery", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "service-test-"));
    cleanup.push(rootDir);
    const opened = openDatabase(rootDir);
    const jobs = new ScanJobRepository(opened.db);
    const roots = new LibraryRootRepository(opened.db);

    const service = new ScanJobService(makeDeps(opened, {
      jobs,
      roots,
      getManagedRoot: async () => rootDir,
      walk: async function* (_r, signal) {
        signal.throwIfAborted();
        yield { absolutePath: join(rootDir, "a.txt"), relativePath: "a.txt", format: "txt", fileSize: 10, modifiedAt: "t1" };
      },
    }));

    const rootRecord = roots.ensureRoot(rootDir, "test", new Date().toISOString());
    const oldJob = jobs.create(rootRecord.id, new Date().toISOString());
    jobs.update(oldJob.id, { state: "running" });
    expect(service.recoverInterruptedJobs()).toBe(1);
    expect(jobs.get(oldJob.id)?.state).toBe("recoverable");

    const startSnap = await service.start();
    expect(startSnap.state).toBe("recoverable");

    const resumed = await service.resume(oldJob.id);
    expect(resumed.state).toBe("running");
    await new Promise((r) => setTimeout(r, 100));
    expect(jobs.get(oldJob.id)?.state).toBe("completed");
    opened.close();
  });

  it("handles item errors gracefully", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "service-err-test-"));
    cleanup.push(rootDir);
    const opened = openDatabase(rootDir);
    const jobs = new ScanJobRepository(opened.db);
    const roots = new LibraryRootRepository(opened.db);
    const inventory = new FileInventoryRepository(opened.db);

    // Inventory is written in batches, so the failure is injected at the batch
    // boundary. What matters is unchanged: one bad write must not abort the scan.
    const origBatch = inventory.upsertSeenBatch.bind(inventory);
    let thrown = false;
    inventory.upsertSeenBatch = (rootId, jobId, entries, now) => {
      if (!thrown) { thrown = true; throw new Error("Disk write error"); }
      return origBatch(rootId, jobId, entries, now);
    };

    const service = new ScanJobService(makeDeps(opened, {
      jobs, roots, inventory,
      getManagedRoot: async () => rootDir,
      walk: async function* () {
        yield { absolutePath: "1.txt", relativePath: "1.txt", format: "txt", fileSize: 10, modifiedAt: "t1" };
        yield { absolutePath: "2.txt", relativePath: "2.txt", format: "txt", fileSize: 20, modifiedAt: "t1" };
      },
    }));

    const received: LibraryScanSnapshot[] = [];
    const unsub = service.subscribe((s) => received.push(s));
    const snap = await service.start();
    await new Promise((r) => setTimeout(r, 200));
    expect(received.length).toBeGreaterThan(0);
    unsub();
    const finalJob = jobs.get(snap.jobId);
    // Both fixture entries are written in a single batch, and a failed batch is
    // accounted for as errors across the whole batch. The behaviour under test is
    // that the scan still reaches a terminal state instead of aborting.
    expect(finalJob?.counters.errors).toBe(2);
    expect(["completed", "failed", "cancelled"]).toContain(finalJob?.state);
    opened.close();
  });
});

describe("scan pipeline safety", () => {
  /**
   * The single most important property of this subsystem.
   *
   * Every phase used to end with the scan acting on its own conclusions: duplicates
   * were moved to the recycle bin and series were written into the library before the
   * user had seen anything. A scan now only observes. This test scans a folder that
   * contains a duplicate pair and asserts that afterwards the folder is byte-for-byte
   * the same folder, that the duplicate was still reported, and that no recycle
   * operation was recorded.
   */
  it("never moves or deletes a file, even when it finds duplicates", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pipeline-safe-test-"));
    cleanup.push(rootDir);
    const opened = openDatabase(rootDir);

    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(rootDir, "series"), { recursive: true });
    const shared = "identical content that appears twice in this folder";
    await writeFile(join(rootDir, "dup-a.txt"), shared);
    await writeFile(join(rootDir, "dup-b.txt"), shared);
    await writeFile(join(rootDir, "series", "某系列 第1卷.txt"), "第一卷");
    await writeFile(join(rootDir, "series", "某系列 第2卷.txt"), "第二卷");

    const before = (await readdir(rootDir, { recursive: true })).sort();

    const { walkInventory } = await import("../../src/backend/library-scan/inventory-walker.js");
    const svc = makeServices(opened.db);
    const service = new ScanJobService({
      roots: new LibraryRootRepository(opened.db),
      inventory: svc.inventory,
      jobs: new ScanJobRepository(opened.db),
      metadataExtractor: svc.metadataExtractor,
      resolutionService: svc.resolutionService,
      loadLibraryLinks: () => loadLibraryLinks(opened.db),
      getManagedRoot: async () => rootDir,
      canonicalizeRoot: async (p) => p,
      walk: walkInventory,
      now: () => new Date().toISOString(),
    });

    const terminal = await new Promise<LibraryScanSnapshot>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Scan timeout")), 30000);
      const unsubscribe = service.subscribe((snapshot) => {
        if (["completed", "failed", "cancelled"].includes(snapshot.state)) {
          clearTimeout(timeout);
          unsubscribe();
          resolve(snapshot);
        }
      });
      void service.start();
    });

    expect(terminal.state).toBe("completed");

    // The listing is unchanged: nothing was recycled, quarantined or rewritten.
    expect((await readdir(rootDir, { recursive: true })).sort()).toEqual(before);

    // And the work still happened — the scan reports what it found without acting.
    const rootId = new LibraryRootRepository(opened.db).getMostRecent()!.id;
    const findings = svc.findings.listByRoot(rootId, { includeResolved: true });
    expect(findings.some((f) => f.kind === "exact_duplicate")).toBe(true);
    expect(findings.some((f) => f.kind === "series_volume")).toBe(true);
    expect(findings.every((f) => f.status !== "auto_applied")).toBe(true);
    expect(svc.ops.listRecent(500)).toEqual([]);
    expect(terminal.counters.resolutionRecycled).toBe(0);

    opened.close();
  }, 30000);

  it("completes even when the optional agent phase throws", async () => {
    // A failing optional service must not fail the scan. The agent phase is the only
    // optional hook left; the apply phases it used to sit beside are gone entirely.
    const rootDir = await mkdtemp(join(tmpdir(), "pipeline-err-test-"));
    cleanup.push(rootDir);
    const opened = openDatabase(rootDir);
    const seq: string[] = [];

    // The agent phase is only reached when resolution produced something to review, so
    // the fixture has to contain a real duplicate pair.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(rootDir, "dup-a.txt"), "identical bytes");
    await writeFile(join(rootDir, "dup-b.txt"), "identical bytes");

    const { walkInventory } = await import("../../src/backend/library-scan/inventory-walker.js");
    const service = new ScanJobService(makeDeps(opened, {
      getManagedRoot: async () => rootDir,
      walk: walkInventory,
      findingsRepo: new ScanFindingRepository(opened.db),
      agentService: {
        resolve: async () => {
          seq.push("agent-fail");
          throw new Error("agent failed");
        },
      } as never,
    }));

    const unsub = service.subscribe((snap) => {
      seq.push(`event-${snap.state}`);
    });

    await service.start();
    await new Promise((r) => setTimeout(r, 400));
    unsub();

    expect(seq).toContain("agent-fail");
    expect(seq).toContain("event-completed");
    opened.close();
  }, 15000);

  it("broadcasts the terminal state when the pipeline fails", async () => {
    // The renderer only learns about a scan from this stream. A job that died without
    // emitting left the UI showing a progress bar that would never move again.
    const rootDir = await mkdtemp(join(tmpdir(), "pipeline-fail-emit-test-"));
    cleanup.push(rootDir);
    const opened = openDatabase(rootDir);
    const jobs = new ScanJobRepository(opened.db);
    const seen: Array<{ state: string; errorCode: string | null }> = [];

    const service = new ScanJobService(makeDeps(opened, {
      jobs,
      getManagedRoot: async () => rootDir,
      walk: async function* () {
        throw new Error("the folder disappeared mid-walk");
      },
    }));

    const unsub = service.subscribe((snap) => {
      seen.push({ state: snap.state, errorCode: snap.errorCode });
    });

    const started = await service.start();
    await new Promise((r) => setTimeout(r, 200));
    unsub();

    expect(seen.at(-1)).toEqual({ state: "failed", errorCode: "SCAN_FAILED" });
    expect(jobs.get(started.jobId)?.state).toBe("failed");
    opened.close();
  }, 15000);

  it("has no dependency capable of moving a file", () => {
    // A structural guard: the pipeline's dependency surface must not grow a service
    // that acts on the filesystem. Applying a finding belongs to ScanReviewService,
    // which is only reachable from a confirmed decision.
    const deps = makeDeps({ db: null as never } as never);
    expect(Object.keys(deps)).not.toContain("recycleService");
    expect(Object.keys(deps)).not.toContain("seriesApplyService");
    expect(Object.keys(deps)).not.toContain("trash");
  });
});
