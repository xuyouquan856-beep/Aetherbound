import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentResolutionService } from "../../src/backend/library-scan/agent-resolution-service.js";
import { FileInventoryRepository } from "../../src/backend/library-scan/file-inventory-repository.js";
import { LibraryRootRepository } from "../../src/backend/library-scan/library-root-repository.js";
import { ScanFindingRepository } from "../../src/backend/library-scan/scan-finding-repository.js";
import { ScanJobRepository } from "../../src/backend/library-scan/scan-job-repository.js";
import { ScanJobService } from "../../src/backend/library-scan/scan-job-service.js";
import type { LibraryScanSnapshot } from "../../src/shared/contracts.js";
import { openDatabase, type OpenedDatabase } from "../../src/backend/storage/database.js";

function waitForTerminalState(service: ScanJobService): Promise<LibraryScanSnapshot> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Scan timeout")), 30000);
    const unsubscribe = service.subscribe((snapshot) => {
      if (["completed", "failed", "cancelled"].includes(snapshot.state)) {
        clearTimeout(timeout);
        unsubscribe();
        resolve(snapshot);
      }
    });
  });
}

describe("Agent Resolution Pipeline Phase", () => {
  let tempDir: string;
  let opened: OpenedDatabase;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "reader-agent-phase-"));
    opened = openDatabase(tempDir);
  });

  afterEach(async () => {
    opened.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  function makeService(agentService?: AgentResolutionService | null) {
    const roots = new LibraryRootRepository(opened.db);
    const inventory = new FileInventoryRepository(opened.db);
    const now = () => new Date().toISOString();

    return new ScanJobService({
      roots,
      inventory,
      jobs: new ScanJobRepository(opened.db),
      findingsRepo: new ScanFindingRepository(opened.db),
      metadataExtractor: {
        extract: async () => ({ metadataVersion: 1 as const, title: "Test", author: null, language: null, identifier: null, source: "txt-head" as const }),
      },
      resolutionService: {
        runLocalResolution: async () => ({ findings: [], examined: 0 }),
      } as never,
      loadLibraryLinks: () => ({ get: () => undefined, size: 0 }),
      getManagedRoot: async () => tempDir,
      canonicalizeRoot: async (p: string) => p,
      walk: async function* () {},
      now,
      agentService: agentService ?? undefined,
    });
  }

  it("starts and completes scan with agent phase wired but empty walker", async () => {
    await writeFile(join(tempDir, "test.txt"), "hello");
    const svc = makeService(undefined);

    // Register root before starting
    opened.db.prepare("INSERT INTO library_roots(id, root_path, display_name, created_at, updated_at) VALUES ('r1', ?, 'Test', 'now', 'now')").run(tempDir);

    // Subscribe before start to catch all snapshots
    const terminalPromise = waitForTerminalState(svc);
    svc.start();
    const result = await terminalPromise;

    expect(result.state).toBe("completed");
    expect(result.phase).toBe("completed");
  });

  it("completes when agentService is provided (no findings, graceful skip)", async () => {
    await writeFile(join(tempDir, "test.txt"), "hello");
    const svc = makeService(new AgentResolutionService({
      chatModel: null,
      getApiKey: async () => null,
    }));

    opened.db.prepare("INSERT INTO library_roots(id, root_path, display_name, created_at, updated_at) VALUES ('r2', ?, 'Test', 'now', 'now')").run(tempDir);

    const terminalPromise = waitForTerminalState(svc);
    svc.start();
    const result = await terminalPromise;

    expect(result.state).toBe("completed");
  });

  it("agentService construction dependency is optional (typecheck smoke)", () => {
    // Verify the service constructs with and without agentService
    const svc1 = makeService(undefined);
    expect(svc1).toBeDefined();

    const svc2 = makeService(new AgentResolutionService({
      chatModel: null,
      getApiKey: async () => null,
    }));
    expect(svc2).toBeDefined();
  });
});
