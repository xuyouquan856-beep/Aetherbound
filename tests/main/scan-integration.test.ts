import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { walkInventory } from "../../src/backend/library-scan/inventory-walker.js";
import { FileInventoryRepository } from "../../src/backend/library-scan/file-inventory-repository.js";
import { LibraryRootRepository } from "../../src/backend/library-scan/library-root-repository.js";
import { ScanJobRepository } from "../../src/backend/library-scan/scan-job-repository.js";
import { ScanJobService } from "../../src/backend/library-scan/scan-job-service.js";
import { LightweightMetadataExtractor } from "../../src/backend/library-scan/lightweight-metadata-extractor.js";
import { LocalResolutionService } from "../../src/backend/library-scan/local-resolution-service.js";
import { loadLibraryLinks } from "../../src/backend/library-scan/library-link.js";
import { openDatabase, type OpenedDatabase } from "../../src/backend/storage/database.js";
import type { LibraryScanSnapshot } from "../../src/shared/contracts.js";

function makeScanJobService(db: ReturnType<typeof openDatabase>["db"], managedRoot: string) {
  const inventory = new FileInventoryRepository(db);
  return new ScanJobService({
    roots: new LibraryRootRepository(db),
    inventory,
    jobs: new ScanJobRepository(db),
    metadataExtractor: new LightweightMetadataExtractor(),
    resolutionService: new LocalResolutionService(db),
    loadLibraryLinks: () => loadLibraryLinks(db),
    getManagedRoot: async () => managedRoot,
    canonicalizeRoot: async (p) => p,
    walk: walkInventory,
    now: () => new Date().toISOString(),
  });
}

async function waitForTerminalState(service: ScanJobService): Promise<LibraryScanSnapshot> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Scan timeout")), 120000);
    const unsubscribe = service.subscribe((snapshot) => {
      if (["completed", "failed", "cancelled"].includes(snapshot.state)) {
        clearTimeout(timeout);
        unsubscribe();
        resolve(snapshot);
      }
    });
  });
}

describe("Library Scan Integration & Lifecycle", () => {
  const cleanupDirs: string[] = [];
  let dbDir: string;
  let opened: OpenedDatabase;
  let rootRepo: LibraryRootRepository;
  let inventoryRepo: FileInventoryRepository;
  let scanJobRepo: ScanJobRepository;

  beforeEach(async () => {
    dbDir = await mkdtemp(join(tmpdir(), "scan-integration-db-"));
    cleanupDirs.push(dbDir);
    opened = openDatabase(dbDir);
    rootRepo = new LibraryRootRepository(opened.db);
    inventoryRepo = new FileInventoryRepository(opened.db);
    scanJobRepo = new ScanJobRepository(opened.db);
  });

  afterEach(async () => {
    if (opened) opened.close();
    await Promise.all(cleanupDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("completes 1005 fixture inventory, tests rescan caching, mtime update, file removal, and recoverable lifecycle", { timeout: 30_000 }, async () => {
    const managedRoot = await mkdtemp(join(tmpdir(), "scan-1005-fixtures-"));
    cleanupDirs.push(managedRoot);

    // Create 1005 small TXT/EPUB fixtures
    for (let index = 1; index <= 1005; index += 1) {
      const ext = index % 2 === 0 ? "txt" : "epub";
      const dir = join(managedRoot, `folder_${Math.floor(index / 100)}`);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `book_${index}.${ext}`), `content ${index}`);
    }

    const service = makeScanJobService(opened.db, managedRoot);
    // 1. Initial 1005 scan
    const initialStart = await service.start();
    const firstTerminal = await waitForTerminalState(service);

    expect(firstTerminal.state).toBe("completed");
    expect(firstTerminal.counters.supported).toBe(1005);

    // The regression this test now guards: the metadata phase used to read a single
    // bounded page, so everything past the first 500 files silently never received
    // metadata — and the reported total came from that truncated page, so progress
    // still claimed completion. The test previously asserted processed === 1505
    // ("1005 inventory + up to 500 metadata"), which enshrined the bug.
    //
    // Attempting every file is the invariant. The fixtures are plain text written with
    // an .epub extension, so the odd-indexed half legitimately fails extraction; that
    // is why this is "attempted === supported" rather than "all succeeded". Counters
    // are cumulative across the several scans below, so no exact sum is asserted here.
    expect(firstTerminal.counters.metadataTotal).toBe(1005);
    expect(
      firstTerminal.counters.metadataProcessed + firstTerminal.counters.metadataErrors,
    ).toBeGreaterThanOrEqual(1005);
    expect(firstTerminal.counters.metadataProcessed).toBeGreaterThan(500);
    // Inventory itself must not error.
    expect(firstTerminal.counters.errors).toBe(0);

    const root = rootRepo.getByPath(managedRoot);
    expect(root).not.toBeNull();
    const statusCounts = inventoryRepo.countByStatus(root!.id);
    const inventoryCount = statusCounts.cached + statusCounts.discovered;
    expect(inventoryCount).toBe(1005);

    // 2. Second scan without file changes (hits cache)
    await service.start();
    const secondTerminal = await waitForTerminalState(service);

    expect(secondTerminal.state).toBe("completed");
    expect(secondTerminal.counters.cached).toBe(1005);
    expect(secondTerminal.counters.queued).toBe(0);

    // 3. One changed mtime -> exactly 1 queued
    const changedFile = join(managedRoot, "folder_0", "book_1.epub");
    const future = new Date(Date.now() + 10_000);
    await utimes(changedFile, future, future);

    await service.start();
    const thirdTerminal = await waitForTerminalState(service);

    expect(thirdTerminal.state).toBe("completed");
    expect(thirdTerminal.counters.queued).toBe(1);
    expect(thirdTerminal.counters.cached).toBe(1004);

    // 4. One removed file -> marked as missing in inventory
    const removedFile = join(managedRoot, "folder_0", "book_2.txt");
    await rm(removedFile, { force: true });

    await service.start();
    const fourthTerminal = await waitForTerminalState(service);

    expect(fourthTerminal.state).toBe("completed");
    const missingRecord = opened.db.prepare("SELECT * FROM file_inventory WHERE root_id = ? AND relative_path = ?").get(root!.id, "folder_0/book_2.txt") as { inventory_status: string } | undefined;
    expect(missingRecord?.inventory_status).toBe("missing");

    // 5. Simulated process restart producing recoverable
    const jobRecord = scanJobRepo.create(root!.id, new Date().toISOString());
    scanJobRepo.update(jobRecord.id, { state: "running" });

    const recoveredCount = service.recoverInterruptedJobs();
    expect(recoveredCount).toBe(1);
    expect(scanJobRepo.get(jobRecord.id)?.state).toBe("recoverable");

    const startSnap = await service.start();
    expect(startSnap.jobId).toBe(jobRecord.id);
    expect(startSnap.state).toBe("recoverable");

    // Resuming recoverable work to completion
    await service.resume(jobRecord.id);
    const fifthTerminal = await waitForTerminalState(service);
    expect(fifthTerminal.state).toBe("completed");

    // 6. Scan completes without API key
    expect(fifthTerminal.counters.errors).toBe(0);
  });

});
