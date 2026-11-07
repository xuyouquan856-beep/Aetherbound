import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyMoveBatch,
  recoverInterruptedMoves,
  rollbackBatch,
} from "../../../scripts/library-recovery/executor.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "recovery-executor-"));
  const audit = await mkdtemp(join(tmpdir(), "recovery-journal-"));
  roots.push(root, audit);
  const source = join(root, "book.epub");
  await writeFile(source, "book-content");
  const facts = await stat(source);
  const sha256 = createHash("sha256").update("book-content").digest("hex");
  const preview = {
    previewVersion: 1,
    baselineDigest: "d".repeat(64),
    createdAt: "2026-07-30T00:00:00.000Z",
    actions: [{
      actionId: "move:book",
      kind: "move",
      status: "confirmed",
      sourceRelativePath: "book.epub",
      proposedRelativePath: "Series/book.epub",
      seriesCanonicalName: "Series",
      editionLabels: [],
      volumeLabel: null,
      title: "Book",
      creator: null,
      evidenceCodes: ["OPF_SERIES_EXACT"],
      evidenceSummary: "exact",
      fileSize: facts.size,
      modifiedAt: facts.mtime.toISOString(),
      sha256,
    }],
  };
  const text = `${JSON.stringify(preview, null, 2)}\n`;
  const previewPath = join(audit, "preview.json");
  await writeFile(previewPath, text);
  return {
    root,
    audit,
    source,
    destination: join(root, "Series", "book.epub"),
    previewPath,
    digest: createHash("sha256").update(text).digest("hex"),
    journalPath: join(audit, "moves.jsonl"),
    sha256,
  };
}

describe("hash-verified recovery executor", () => {
  it("rejects unsafe batch limits before touching files", async () => {
    const fixture = await setup();
    await expect(applyMoveBatch({ ...fixture, expectedPreviewDigest: fixture.digest, limit: 6, firstBatch: true }))
      .rejects.toThrow(/first batch/i);
    await expect(applyMoveBatch({ ...fixture, expectedPreviewDigest: fixture.digest, limit: 21, firstBatch: false }))
      .rejects.toThrow(/20/);
    await expect(readFile(fixture.source, "utf8")).resolves.toBe("book-content");
  });

  it("rejects preview digest and source hash changes", async () => {
    const fixture = await setup();
    await expect(applyMoveBatch({ ...fixture, expectedPreviewDigest: "f".repeat(64), limit: 1, firstBatch: true }))
      .rejects.toThrow(/digest/i);
    await writeFile(fixture.source, "changed");
    await expect(applyMoveBatch({ ...fixture, expectedPreviewDigest: fixture.digest, limit: 1, firstBatch: true }))
      .rejects.toThrow(/source/i);
  });

  it("never overwrites a destination collision", async () => {
    const fixture = await setup();
    await mkdir(join(fixture.root, "Series"));
    await writeFile(fixture.destination, "existing");
    await expect(applyMoveBatch({ ...fixture, expectedPreviewDigest: fixture.digest, limit: 1, firstBatch: true }))
      .rejects.toThrow(/destination/i);
    await expect(readFile(fixture.destination, "utf8")).resolves.toBe("existing");
    await expect(readFile(fixture.source, "utf8")).resolves.toBe("book-content");
  });

  it("moves with a write-ahead journal and rolls back in reverse", async () => {
    const fixture = await setup();
    const result = await applyMoveBatch({ ...fixture, expectedPreviewDigest: fixture.digest, limit: 1, firstBatch: true });
    expect(result.moved).toBe(1);
    await expect(readFile(fixture.destination, "utf8")).resolves.toBe("book-content");
    const journal = (await readFile(fixture.journalPath, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line));
    expect(journal.map((entry) => entry.phase)).toEqual(["started", "completed"]);
    expect(journal[1].sha256After).toBe(fixture.sha256);

    const rollback = await rollbackBatch({ root: fixture.root, journalPath: fixture.journalPath, batchId: result.batchId });
    expect(rollback.rolledBack).toBe(1);
    await expect(readFile(fixture.source, "utf8")).resolves.toBe("book-content");
  });

  it("stops rollback if moved content changed", async () => {
    const fixture = await setup();
    const result = await applyMoveBatch({ ...fixture, expectedPreviewDigest: fixture.digest, limit: 1, firstBatch: true });
    await writeFile(fixture.destination, "changed-after-move");
    await expect(rollbackBatch({ root: fixture.root, journalPath: fixture.journalPath, batchId: result.batchId }))
      .rejects.toThrow(/changed/i);
  });

  it("recovers a crash after the file moved but before completion was journaled", async () => {
    const fixture = await setup();
    await mkdir(join(fixture.root, "Series"));
    const started = {
      journalVersion: 1,
      actionId: "move:book",
      batchId: "crashed-batch",
      phase: "started",
      recordedAt: "2026-07-30T00:00:00.000Z",
      sourceAbsolutePath: fixture.source,
      destinationAbsolutePath: fixture.destination,
      fileSize: 12,
      modifiedAt: (await stat(fixture.source)).mtime.toISOString(),
      sha256Before: fixture.sha256,
      sha256After: null,
    };
    await writeFile(fixture.journalPath, `${JSON.stringify(started)}\n`);
    await rename(fixture.source, fixture.destination);

    await expect(recoverInterruptedMoves({
      root: fixture.root,
      journalPath: fixture.journalPath,
    })).resolves.toEqual({ recovered: 1, untouched: 0 });
    const phases = (await readFile(fixture.journalPath, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line).phase);
    expect(phases).toEqual(["started", "completed"]);
  });
});
