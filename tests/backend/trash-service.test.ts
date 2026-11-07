import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../src/backend/storage/database.js";
import { TrashBinService } from "../../src/backend/library/trash-service.js";

describe("TrashBinService", () => {
  let rootDir: string;
  let db: Database.Database;
  let svc: TrashBinService;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "reader-trash-test-"));
    db = new Database(":memory:");
    migrate(db);
    svc = new TrashBinService(db, rootDir);
  });

  afterEach(async () => {
    db.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  it("trashFile moves a file to .aether-trash and records it", async () => {
    const src = join(rootDir, "test.txt");
    await writeFile(src, "hello world");
    const record = await svc.trashFile(rootDir, src);
    expect(record.originalPath).toBe(src);
    expect(record.trashPath).toContain(".aether-trash");
    const { stat } = await import("node:fs/promises");
    await expect(stat(src)).rejects.toThrow();
  });

  it("listTrash returns deleted files", async () => {
    const src = join(rootDir, "test.txt");
    await writeFile(src, "hello");
    await svc.trashFile(rootDir, src);
    const items = svc.listTrash();
    expect(items).toHaveLength(1);
    expect(items[0].originalPath).toBe(src);
  });

  it("restoreFile moves file back to original path", async () => {
    const src = join(rootDir, "test.txt");
    await writeFile(src, "hello");
    const record = await svc.trashFile(rootDir, src);
    const result = await svc.restoreFile(record.id);
    expect(result.success).toBe(true);
    const { stat } = await import("node:fs/promises");
    await expect(stat(src)).resolves.toBeTruthy();
  });

  it("restoreFile returns conflict when original path is occupied", async () => {
    const src = join(rootDir, "test.txt");
    await writeFile(src, "original");
    const record = await svc.trashFile(rootDir, src);
    await writeFile(src, "replacement");
    const result = await svc.restoreFile(record.id);
    expect(result.success).toBe(false);
    expect(result.conflict).toBe(true);
  });

  it("rejects paths outside authorized root", async () => {
    // Use a path unambiguously outside the test root
    const src = join(rootDir, "..", "..", "outside.txt");
    try { await svc.trashFile(rootDir, src); expect.fail("should have thrown"); } catch (e: any) { expect(e.message).toContain("不在授权根目录"); }
  });

  it("trashFile re-verifies file exists before moving", async () => {
    const src = join(rootDir, "no-such.txt");
    try { await svc.trashFile(rootDir, src); expect.fail("should have thrown"); } catch (e: any) { expect(e.code).toBe("INVALID_PACKAGE"); }
  });

  it("trashFile is idempotent — same path twice is safe", async () => {
    const src = join(rootDir, "dup.txt");
    await writeFile(src, "test");
    await svc.trashFile(rootDir, src);
    // Second trash of same (now-missing) path should throw INVALID_PACKAGE
    try { await svc.trashFile(rootDir, src); expect.fail("should have thrown"); } catch (e: any) { expect(e.code).toBe("INVALID_PACKAGE"); }
  });

  it("trashFile records file size and hash", async () => {
    const src = join(rootDir, "test.txt");
    await writeFile(src, "hello world");
    const record = await svc.trashFile(rootDir, src);
    expect(record.fileSize).toBe(11);
    expect(record.contentHash).toBeTruthy();
  });

  it("restoreFile updates restored_at timestamp", async () => {
    const src = join(rootDir, "test.txt");
    await writeFile(src, "hello");
    const record = await svc.trashFile(rootDir, src);
    await svc.restoreFile(record.id);
    const updated = db.prepare("SELECT restored_at FROM trash_records WHERE id = ?").get(record.id) as { restored_at: string };
    expect(updated.restored_at).toBeTruthy();
  });

  it("listTrash returns empty array when nothing is deleted", () => {
    expect(svc.listTrash()).toEqual([]);
  });
});
