import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ScanOperationRepository } from "../../src/backend/library-scan/operation-repository.js";
import { LATEST_SCHEMA_VERSION, openDatabase } from "../../src/backend/storage/database.js";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("scan operation log", () => {
  it("persists enough local evidence to audit a recycle or replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "aetherbound-scan-log-"));
    cleanup.push(root);
    const opened = openDatabase(root);
    const operations = new ScanOperationRepository(opened.db);

    operations.record({
      reviewId: "review-1",
      actionId: "action-1",
      kind: "replace",
      bookId: "book-1",
      candidatePath: "E:\\小说\\新版.txt",
      priorSourcePath: "E:\\小说\\旧版.txt",
      contentHash: "a".repeat(64),
      reason: "同一 WEB 连载更新",
      outcome: "completed",
    });

    expect(operations.listRecent(1)).toEqual([expect.objectContaining({
      kind: "replace",
      bookId: "book-1",
      contentHash: "a".repeat(64),
      outcome: "completed",
    })]);
    expect(opened.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    opened.close();
  });
});
