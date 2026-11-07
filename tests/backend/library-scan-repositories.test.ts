import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileInventoryRepository } from "../../src/backend/library-scan/file-inventory-repository.js";
import { LibraryRootRepository } from "../../src/backend/library-scan/library-root-repository.js";
import { ScanJobRepository } from "../../src/backend/library-scan/scan-job-repository.js";
import { openDatabase } from "../../src/backend/storage/database.js";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("library scan repositories", () => {
  it("ensureRoot returns the same ID for the same canonical path", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "repo-test-"));
    cleanup.push(rootDir);
    const opened = openDatabase(rootDir);
    const roots = new LibraryRootRepository(opened.db);

    const now = new Date().toISOString();
    const r1 = roots.ensureRoot("E:\\epub", "epub", now);
    const r2 = roots.ensureRoot("E:\\epub", "epub-renamed", now);

    expect(r1.id).toBe(r2.id);
    expect(r2.displayName).toBe("epub-renamed");
    opened.close();
  });

  it("upsertSeen returns discovered for new/changed file, cached for unchanged file, and beginScan marks old entries missing", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "repo-test-"));
    cleanup.push(rootDir);
    const opened = openDatabase(rootDir);
    const roots = new LibraryRootRepository(opened.db);
    const inventory = new FileInventoryRepository(opened.db);
    const now = new Date().toISOString();

    const root = roots.ensureRoot("E:\\epub", "epub", now);
    const entry1 = { relativePath: "book1.epub", format: "epub" as const, fileSize: 100, modifiedAt: now };

    // Initial upsert -> discovered
    const d1 = inventory.upsertSeen(root.id, "job-1", entry1, now);
    expect(d1).toBe("discovered");

    // Same entry -> cached
    const d2 = inventory.upsertSeen(root.id, "job-1", entry1, now);
    expect(d2).toBe("cached");

    // Changed file size -> discovered & clears stale columns
    const entry1Changed = { relativePath: "book1.epub", format: "epub" as const, fileSize: 200, modifiedAt: now };
    const d3 = inventory.upsertSeen(root.id, "job-1", entry1Changed, now);
    expect(d3).toBe("discovered");

    // beginScan marks entries missing
    inventory.beginScan(root.id, now);
    const counts = inventory.countByStatus(root.id);
    expect(counts.missing).toBe(1);

    opened.close();
  });

  it("create refuses a second active job for the same root", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "repo-test-"));
    cleanup.push(rootDir);
    const opened = openDatabase(rootDir);
    const roots = new LibraryRootRepository(opened.db);
    const jobs = new ScanJobRepository(opened.db);
    const now = new Date().toISOString();

    const root = roots.ensureRoot("E:\\epub", "epub", now);
    const job1 = jobs.create(root.id, now);
    expect(job1.id).toBeDefined();

    expect(() => jobs.create(root.id, now)).toThrow();
    opened.close();
  });

  it("markInterruptedRecoverable changes running/paused jobs to recoverable", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "repo-test-"));
    cleanup.push(rootDir);
    const opened = openDatabase(rootDir);
    const roots = new LibraryRootRepository(opened.db);
    const jobs = new ScanJobRepository(opened.db);
    const now = new Date().toISOString();

    const root = roots.ensureRoot("E:\\epub", "epub", now);
    const job = jobs.create(root.id, now);
    jobs.update(job.id, { state: "running", lastHeartbeatAt: now });

    const count = jobs.markInterruptedRecoverable(now);
    expect(count).toBe(1);

    const updated = jobs.get(job.id);
    expect(updated?.state).toBe("recoverable");
    opened.close();
  });

  it("public snapshot contains display_name, never root_path", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "repo-test-"));
    cleanup.push(rootDir);
    const opened = openDatabase(rootDir);
    const roots = new LibraryRootRepository(opened.db);
    const jobs = new ScanJobRepository(opened.db);
    const now = new Date().toISOString();

    const root = roots.ensureRoot("E:\\epub", "my-epub", now);
    const job = jobs.create(root.id, now);

    const snap = jobs.toPublicSnapshot(job, root.displayName);
    expect(snap.rootName).toBe("my-epub");
    expect(JSON.stringify(snap)).not.toContain("E:\\epub");
    opened.close();
  });
});
