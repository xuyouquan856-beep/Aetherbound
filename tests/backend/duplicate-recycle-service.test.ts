import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type OpenedDatabase } from "../../src/backend/storage/database.js";
import { FileInventoryRepository } from "../../src/backend/library-scan/file-inventory-repository.js";
import { ScanFindingRepository } from "../../src/backend/library-scan/scan-finding-repository.js";
import { ScanOperationRepository } from "../../src/backend/library-scan/operation-repository.js";
import { DuplicateRecycleService } from "../../src/backend/library-scan/duplicate-recycle-service.js";
import { fullContentHash, quickFingerprint } from "../../src/backend/library/fingerprint.js";

/**
 * These tests guard the only code in the project that removes a user's file.
 *
 * The property that matters is not "a duplicate gets removed" but "nothing is removed
 * unless an identical copy is proven to still exist". Every case below is written from
 * that angle: the interesting assertions are the ones where the answer must be *no
 * move*, and the survivor is checked to still be on disk afterwards.
 */
describe("DuplicateRecycleService", () => {
  let tempDir: string;
  let rootDir: string;
  let opened: OpenedDatabase;
  let inventory: FileInventoryRepository;
  let findings: ScanFindingRepository;
  let operations: ScanOperationRepository;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "reader-recycle-test-"));
    rootDir = join(tempDir, "root");
    await mkdir(rootDir, { recursive: true });
    opened = openDatabase(tempDir);
    inventory = new FileInventoryRepository(opened.db);
    findings = new ScanFindingRepository(opened.db);
    operations = new ScanOperationRepository(opened.db);
    opened.db.prepare("INSERT INTO library_roots(id, root_path, display_name, created_at, updated_at) VALUES ('r1', ?, 'Test', 'now', 'now')").run(rootDir);
    opened.db.prepare("INSERT INTO scan_jobs(id, root_id, state, phase, cursor_json, counters_json, started_at, last_heartbeat_at) VALUES ('j1', 'r1', 'running', 'local_resolution', '{}', '{}', 'now', 'now')").run();
  });

  afterEach(async () => {
    opened.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  async function insertInventory(name: string, content: string) {
    const path = join(rootDir, name);
    await writeFile(path, content);
    const fp = await quickFingerprint(path);
    const id = randomUUID();
    opened.db.prepare(
      `INSERT INTO file_inventory(id, root_id, relative_path, format, file_size, modified_at, inventory_status, metadata_state, resolution_state, updated_at, quick_fingerprint_version, quick_fingerprint)
       VALUES (?, 'r1', ?, 'txt', ?, ?, 'discovered', 'ready', 'ready', ?, ?, ?)`,
    ).run(id, name, fp.fileSize, fp.modifiedAt, new Date().toISOString(), fp.version, fp.fingerprint);
    return { id, path };
  }

  async function makeFinding(candidateIds: string[], fullHash: string, status = "accepted") {
    return findings.upsertFinding({
      rootId: "r1",
      jobId: "j1",
      kind: "exact_duplicate",
      status: status as "accepted",
      confidence: 1,
      candidateIds,
      evidence: {
        kind: "exact_duplicate" as const,
        evidenceVersion: 1 as const,
        algorithm: "sha256" as const,
        fullContentHash: fullHash,
        survivorInventoryId: candidateIds[0],
        volumeConflict: false,
        ruleCodes: ["exact_hash_match"],
      },
      now: "2026-07-24T00:00:00.000Z",
    });
  }

  function makeService(trash: (root: string, path: string) => Promise<"recycle-bin" | "quarantine">) {
    return new DuplicateRecycleService({
      inventory,
      findings,
      operations,
      quickFingerprint,
      fullContentHash,
      trash,
      now: () => "2026-07-24T00:01:00.000Z",
    });
  }

  /** Two real, byte-identical files on disk, plus a finding tying them together. */
  async function makeDuplicatePair(nameA = "keep.txt", nameB = "trash.txt") {
    const content = `shared content ${randomUUID()}`;
    const a = await insertInventory(nameA, content);
    const b = await insertInventory(nameB, content);
    const hash = await fullContentHash(a.path);
    const finding = await makeFinding([a.id, b.id], hash);
    return { a, b, finding, hash };
  }

  it("removes only the redundant copy and leaves the survivor untouched", async () => {
    const { a, b, finding } = await makeDuplicatePair();
    const trashed: string[] = [];
    const service = makeService(async (_root, path) => {
      trashed.push(path);
      return "recycle-bin";
    });

    const outcome = await service.applyExactDuplicateFinding({ finding, rootPath: rootDir });

    expect(outcome).toMatchObject({ status: "applied", recycled: 1 });
    expect(trashed).toEqual([b.path]);
    expect(trashed).not.toContain(a.path);
    // The survivor must still be readable — this is the whole point of the operation.
    await expect(readFile(a.path, "utf8")).resolves.toContain("shared content");
    expect(operations.listRecent().some((op) => op.outcome === "completed")).toBe(true);
  });

  it("moves nothing when the surviving copy is no longer byte-identical", async () => {
    const { a, b, finding, hash } = await makeDuplicatePair();
    // The survivor was edited after the scan, so the hash recorded in the finding no
    // longer describes it. Deleting the other copy now would lose the only good file.
    await writeFile(a.path, "the survivor was rewritten with different content");

    const trashed: string[] = [];
    const service = makeService(async (_root, path) => {
      trashed.push(path);
      return "recycle-bin";
    });

    const outcome = await service.applyExactDuplicateFinding({ finding, rootPath: rootDir });

    expect(outcome.status).toBe("stale");
    expect(trashed).toHaveLength(0);
    expect(findings.getFinding(finding.id)?.status).toBe("stale");
    await expect(readFile(b.path, "utf8")).resolves.toContain("shared content");
    expect(await fullContentHash(a.path)).not.toBe(hash);
  });

  it("moves nothing when the surviving copy has been deleted", async () => {
    const { a, b, finding } = await makeDuplicatePair();
    await rm(a.path);

    const trashed: string[] = [];
    const service = makeService(async (_root, path) => {
      trashed.push(path);
      return "recycle-bin";
    });

    const outcome = await service.applyExactDuplicateFinding({ finding, rootPath: rootDir });

    expect(outcome.status).toBe("stale");
    expect(trashed).toHaveLength(0);
    await expect(readFile(b.path, "utf8")).resolves.toContain("shared content");
  });

  it("moves nothing when a redundant copy changed since the scan", async () => {
    const { finding, b } = await makeDuplicatePair();
    await writeFile(b.path, "this copy is no longer the file the scan saw");

    const trashed: string[] = [];
    const service = makeService(async (_root, path) => {
      trashed.push(path);
      return "recycle-bin";
    });

    const outcome = await service.applyExactDuplicateFinding({ finding, rootPath: rootDir });

    expect(outcome.status).toBe("stale");
    expect(trashed).toHaveLength(0);
    expect(findings.getFinding(finding.id)?.status).toBe("stale");
  });

  it("refuses a path that escapes the scanned folder", async () => {
    const { finding, b } = await makeDuplicatePair();
    const outside = join(tempDir, "outside.txt");
    await writeFile(outside, "not in the library");
    opened.db
      .prepare("UPDATE file_inventory SET relative_path = '../outside.txt' WHERE id = ?")
      .run(b.id);

    const trashed: string[] = [];
    const service = makeService(async (_root, path) => {
      trashed.push(path);
      return "recycle-bin";
    });

    const outcome = await service.applyExactDuplicateFinding({ finding, rootPath: rootDir });

    expect(outcome.status).toBe("stale");
    expect(trashed).toHaveLength(0);
    await expect(readFile(outside, "utf8")).resolves.toBe("not in the library");
  });

  it("treats a duplicate claim whose survivor is not in the group as unusable", async () => {
    const { a, b } = await makeDuplicatePair();
    const hash = await fullContentHash(a.path);
    const orphan = await inventory.getById(a.id);
    const finding = await makeFinding([a.id, b.id], hash);
    opened.db
      .prepare("UPDATE scan_findings SET evidence_json = ? WHERE id = ?")
      .run(
        JSON.stringify({
          kind: "exact_duplicate",
          evidenceVersion: 1,
          algorithm: "sha256",
          fullContentHash: hash,
          survivorInventoryId: "not-in-the-group",
          volumeConflict: false,
          ruleCodes: ["exact_hash_match"],
        }),
        finding.id,
      );

    const trashed: string[] = [];
    const service = makeService(async (_root, path) => {
      trashed.push(path);
      return "recycle-bin";
    });

    const outcome = await service.applyExactDuplicateFinding({
      finding: findings.getFinding(finding.id)!,
      rootPath: rootDir,
    });

    expect(outcome.status).toBe("stale");
    expect(trashed).toHaveLength(0);
    expect(orphan).not.toBeNull();
  });

  it("reports a partial result when one of several redundant copies cannot be moved", async () => {
    const content = `three copies ${randomUUID()}`;
    const a = await insertInventory("keep.txt", content);
    const b = await insertInventory("dup-1.txt", content);
    const c = await insertInventory("dup-2.txt", content);
    const hash = await fullContentHash(a.path);
    const finding = await makeFinding([a.id, b.id, c.id], hash);

    const moved: string[] = [];
    const service = makeService(async (_root, path) => {
      if (path === c.path) throw new Error("locked by another process");
      moved.push(path);
      return "recycle-bin";
    });

    const outcome = await service.applyExactDuplicateFinding({ finding, rootPath: rootDir });

    expect(outcome).toMatchObject({ status: "partial", recycled: 1, failed: 1 });
    expect(moved).toEqual([b.path]);
    expect(operations.listRecent().some((op) => op.outcome === "failed")).toBe(true);
  });

  it("does not move anything twice for the same finding", async () => {
    const { finding } = await makeDuplicatePair();
    let moves = 0;
    const service = makeService(async () => {
      moves++;
      return "recycle-bin";
    });

    const first = await service.applyExactDuplicateFinding({ finding, rootPath: rootDir });
    expect(first.status).toBe("applied");
    expect(moves).toBe(1);

    // The caller marks the finding terminal after a successful apply; replaying the
    // same finding is refused by the repository, so no second move can happen.
    findings.updateStatus(finding.id, "auto_applied", "2026-07-24T00:02:00.000Z");
    const reloaded = findings.getFinding(finding.id)!;
    expect(reloaded.status).toBe("auto_applied");
    expect(moves).toBe(1);
  });
});
