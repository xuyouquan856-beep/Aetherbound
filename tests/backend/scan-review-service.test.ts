import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type OpenedDatabase } from "../../src/backend/storage/database.js";
import { FileInventoryRepository } from "../../src/backend/library-scan/file-inventory-repository.js";
import { LibraryRootRepository } from "../../src/backend/library-scan/library-root-repository.js";
import { ScanFindingRepository } from "../../src/backend/library-scan/scan-finding-repository.js";
import { ScanOperationRepository } from "../../src/backend/library-scan/operation-repository.js";
import { DuplicateRecycleService } from "../../src/backend/library-scan/duplicate-recycle-service.js";
import { ScanReviewService } from "../../src/backend/library-scan/scan-review-service.js";
import { CustomCollectionService } from "../../src/backend/library/custom-collection-service.js";
import { BookRepository } from "../../src/backend/storage/book-repository.js";
import { fullContentHash, quickFingerprint } from "../../src/backend/library/fingerprint.js";
import type { LibraryImportItemResult } from "../../src/shared/contracts.js";

/**
 * ScanReviewService is where a scan's conclusions turn into actions on the user's
 * books. The tests below are written around the two promises the review screen makes:
 * an action happens only for the finding the user decided on, and accepting a
 * duplicate never removes the last copy of anything.
 */
describe("ScanReviewService", () => {
  let tempDir: string;
  let rootDir: string;
  let opened: OpenedDatabase;
  let roots: LibraryRootRepository;
  let inventory: FileInventoryRepository;
  let findings: ScanFindingRepository;
  let operations: ScanOperationRepository;
  let rootId: string;
  let trashed: string[];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "reader-review-test-"));
    rootDir = join(tempDir, "root");
    await mkdir(rootDir, { recursive: true });
    opened = openDatabase(tempDir);
    roots = new LibraryRootRepository(opened.db);
    inventory = new FileInventoryRepository(opened.db);
    findings = new ScanFindingRepository(opened.db);
    operations = new ScanOperationRepository(opened.db);
    rootId = roots.ensureRoot(rootDir, "我的书库", "2026-07-24T00:00:00.000Z").id;
    opened.db.prepare(
      "INSERT INTO scan_jobs(id, root_id, state, phase, cursor_json, counters_json, started_at, last_heartbeat_at) VALUES ('j1', ?, 'completed', 'completed', '{}', '{}', 'now', 'now')",
    ).run(rootId);
    trashed = [];
  });

  afterEach(async () => {
    opened.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  async function insertInventory(name: string, content: string, format: "txt" | "epub" = "txt") {
    const path = join(rootDir, name);
    await writeFile(path, content);
    const fp = await quickFingerprint(path);
    const id = randomUUID();
    opened.db.prepare(
      `INSERT INTO file_inventory(id, root_id, relative_path, format, file_size, modified_at, inventory_status, metadata_state, resolution_state, updated_at, quick_fingerprint_version, quick_fingerprint, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, 'discovered', 'ready', 'ready', ?, ?, ?, ?)`,
    ).run(
      id,
      rootId,
      name,
      format,
      fp.fileSize,
      fp.modifiedAt,
      "2026-07-24T00:00:00.000Z",
      fp.version,
      fp.fingerprint,
      JSON.stringify({
        metadataVersion: 1,
        title: name.replace(/\.[^.]+$/u, ""),
        author: null,
        language: null,
        identifier: null,
        source: "txt-head",
      }),
    );
    return { id, path };
  }

  function registerBook(path: string, title: string, available = true) {
    const bookId = randomUUID();
    opened.db.prepare("INSERT INTO books(id, format, title, author, created_at, updated_at) VALUES (?,'txt',?,NULL,'now','now')").run(bookId, title);
    opened.db.prepare(
      `INSERT INTO book_sources(id, book_id, source_path, quick_fingerprint_version, quick_fingerprint,
        full_content_hash_algorithm, full_content_hash, file_size, modified_at, source_revision, availability_status, verified_at)
       VALUES (?,?,?,1,'fp','sha256','hash',10,'now',?, ?, 'now')`,
    ).run(randomUUID(), bookId, path, randomUUID(), available ? "available" : "unavailable");
    return bookId;
  }

  function makeService(importerOverrides: {
    importMixedFiles?: (files: ReadonlyArray<{ path: string; format: string }>) => Promise<LibraryImportItemResult[]>;
  } = {}) {
    const books = {
      listBooks: async () => [],
      getBook: (id: string) => new BookRepository(opened.db).getBook(id)!,
    };
    const importer = {
      importMixedFiles: vi.fn(importerOverrides.importMixedFiles ?? (async () => [])),
    };
    const service = new ScanReviewService({
      db: opened.db,
      roots,
      inventory,
      findings,
      operations,
      recycler: new DuplicateRecycleService({
        inventory,
        findings,
        operations,
        quickFingerprint,
        fullContentHash,
        trash: async (_root, path) => {
          trashed.push(path);
          return "recycle-bin";
        },
        now: () => "2026-07-24T00:01:00.000Z",
      }),
      collections: new CustomCollectionService(opened.db, books),
      importer: importer as never,
      now: () => "2026-07-24T00:01:00.000Z",
    });
    return { service, importer };
  }

  async function makeDuplicatePair() {
    const content = `shared ${randomUUID()}`;
    const a = await insertInventory("keep.txt", content);
    const b = await insertInventory("dup.txt", content);
    const hash = await fullContentHash(a.path);
    const finding = findings.upsertFinding({
      rootId,
      jobId: "j1",
      kind: "exact_duplicate",
      status: "new",
      confidence: 1,
      candidateIds: [a.id, b.id],
      evidence: {
        kind: "exact_duplicate",
        evidenceVersion: 1,
        algorithm: "sha256",
        fullContentHash: hash,
        survivorInventoryId: a.id,
        volumeConflict: false,
        ruleCodes: ["exact_hash_match"],
      },
      now: "2026-07-24T00:00:00.000Z",
    });
    return { a, b, finding };
  }

  it("describes what accepting a duplicate would do, before asking", async () => {
    const { a, b } = await makeDuplicatePair();
    const { service } = makeService();

    const list = service.listFindings(rootId, { limit: 30, offset: 0, includeResolved: false });

    expect(list.rootName).toBe("我的书库");
    expect(list.awaitingReview).toBe(1);
    const [detail] = list.findings;
    expect(detail.candidates.map((c) => c.relativePath).sort()).toEqual(["dup.txt", "keep.txt"]);
    expect(detail.proposedAction).toMatchObject({
      kind: "recycle_duplicates",
      survivorInventoryId: a.id,
      victimInventoryIds: [b.id],
    });
  });

  it("moves the redundant copy only after an accept, and marks the finding resolved", async () => {
    const { a, b, finding } = await makeDuplicatePair();
    const { service } = makeService();

    const result = await service.decide(rootId, rootDir, finding.id, "accept");

    expect(result.applied).toBe(true);
    expect(result.status).toBe("auto_applied");
    expect(trashed).toEqual([b.path]);
    expect(findings.getFinding(finding.id)?.status).toBe("auto_applied");
    // The survivor is still on disk and still readable.
    await expect(readFile(a.path, "utf8")).resolves.toContain("shared");
    // Resolved findings drop out of the default list.
    expect(service.listFindings(rootId, { limit: 30, offset: 0, includeResolved: false }).total).toBe(0);
    expect(service.listFindings(rootId, { limit: 30, offset: 0, includeResolved: true }).total).toBe(1);
  });

  it("reports a stale finding instead of acting when a file changed after the scan", async () => {
    const { a, finding } = await makeDuplicatePair();
    await writeFile(a.path, "the survivor was edited after the scan");
    const { service } = makeService();

    const result = await service.decide(rootId, rootDir, finding.id, "accept");

    expect(result.applied).toBe(false);
    expect(result.status).toBe("stale");
    expect(trashed).toEqual([]);
    expect(findings.getFinding(finding.id)?.status).toBe("stale");
  });

  it("records a rejection without touching any file", async () => {
    const { finding } = await makeDuplicatePair();
    const { service } = makeService();

    const result = await service.decide(rootId, rootDir, finding.id, "reject");

    expect(result).toMatchObject({ applied: false, status: "rejected" });
    expect(trashed).toEqual([]);
    expect(operations.listRecent(50)).toEqual([]);
  });

  it("does not re-decide a finding that already has an outcome", async () => {
    const { finding } = await makeDuplicatePair();
    const { service } = makeService();
    await service.decide(rootId, rootDir, finding.id, "accept");
    trashed.length = 0;

    const again = await service.decide(rootId, rootDir, finding.id, "accept");

    expect(again.applied).toBe(false);
    expect(trashed).toEqual([]);
  });

  it("refuses a finding that belongs to a different root", async () => {
    const { finding } = await makeDuplicatePair();
    const { service } = makeService();

    await expect(service.decide("some-other-root", rootDir, finding.id, "accept"))
      .rejects.toThrow("FINDING_NOT_IN_ROOT");
    expect(trashed).toEqual([]);
  });

  it("creates a collection from the imported volumes of a series", async () => {
    const first = await insertInventory("刀剑神域 第1卷.txt", "第一卷");
    const second = await insertInventory("刀剑神域 第2卷.txt", "第二卷");
    const bookA = registerBook(first.path, "刀剑神域 第1卷");
    const bookB = registerBook(second.path, "刀剑神域 第2卷");
    const finding = findings.upsertFinding({
      rootId,
      jobId: "j1",
      kind: "series_volume",
      status: "needs_review",
      confidence: 0.85,
      candidateIds: [first.id, second.id],
      evidence: {
        kind: "series_volume",
        evidenceVersion: 1,
        normalizedSeries: "刀剑神域",
        volumeLabel: "第1卷、第2卷",
        volumeIndex: null,
        ruleCodes: ["series_pattern_match"],
      },
      now: "2026-07-24T00:00:00.000Z",
    });
    const { service } = makeService();

    const list = service.listFindings(rootId, { limit: 30, offset: 0, includeResolved: false });
    expect(list.findings[0].proposedAction).toMatchObject({
      kind: "create_collection",
      name: "刀剑神域",
      bookIds: expect.arrayContaining([bookA, bookB]),
    });

    const result = await service.decide(rootId, rootDir, finding.id, "accept");

    expect(result.applied).toBe(true);
    expect(result.affectedBookIds.sort()).toEqual([bookA, bookB].sort());
    const collections = await new CustomCollectionService(opened.db, {
      listBooks: async () => [],
      getBook: () => {
        throw new Error("not used");
      },
    }).list();
    expect(collections.map((c) => c.name)).toEqual(["刀剑神域"]);
    expect(trashed).toEqual([]);
  });

  it("says so instead of silently doing nothing when no volume is imported yet", async () => {
    const first = await insertInventory("某系列 第1卷.txt", "第一卷");
    const second = await insertInventory("某系列 第2卷.txt", "第二卷");
    const finding = findings.upsertFinding({
      rootId,
      jobId: "j1",
      kind: "series_volume",
      status: "needs_review",
      confidence: 0.85,
      candidateIds: [first.id, second.id],
      evidence: {
        kind: "series_volume",
        evidenceVersion: 1,
        normalizedSeries: "某系列",
        volumeLabel: "第1卷、第2卷",
        volumeIndex: null,
        ruleCodes: ["series_pattern_match"],
      },
      now: "2026-07-24T00:00:00.000Z",
    });
    const { service } = makeService();

    const list = service.listFindings(rootId, { limit: 30, offset: 0, includeResolved: false });
    expect(list.findings[0].proposedAction).toEqual({ kind: "none", reason: "nothing_imported" });

    const result = await service.decide(rootId, rootDir, finding.id, "accept");

    expect(result.applied).toBe(false);
    expect(result.summary).toContain("还没有进入书库");
    // Still waiting for the user, not quietly resolved.
    expect(findings.getFinding(finding.id)?.status).toBe("needs_review");
    expect(await new CustomCollectionService(opened.db, {
      listBooks: async () => [],
      getBook: () => {
        throw new Error("not used");
      },
    }).list()).toEqual([]);
  });

  it("lists folder contents with their library status", async () => {
    const imported = await insertInventory("已有.txt", "已入库");
    await insertInventory("新书.txt", "未入库");
    registerBook(imported.path, "已有");
    const { service } = makeService();

    const all = service.listFiles(rootId, rootDir, { limit: 50, offset: 0, onlyUnimported: false });
    expect(all.total).toBe(2);
    expect(all.inLibrary).toBe(1);
    expect(all.files.find((f) => f.inventoryId === imported.id)?.bookId).not.toBeNull();

    const pending = service.listFiles(rootId, rootDir, { limit: 50, offset: 0, onlyUnimported: true });
    expect(pending.total).toBe(1);
    expect(pending.files[0].title).toBe("新书");
  });

  it("hides a source whose file is no longer usable from the library status", async () => {
    const gone = await insertInventory("失效.txt", "内容");
    registerBook(gone.path, "失效", false);
    const { service } = makeService();

    const listed = service.listFiles(rootId, rootDir, { limit: 50, offset: 0, onlyUnimported: false });
    // An unavailable source is not "already in the library" — offering to import it is
    // exactly what the user wants.
    expect(listed.files[0].bookId).toBeNull();
  });

  it("resolves selected inventory ids into importable paths", async () => {
    const a = await insertInventory("一.txt", "甲");
    const b = await insertInventory("二.txt", "乙");
    const { service } = makeService();

    const files = service.resolveImportFiles(rootId, rootDir, [a.id, b.id]);

    expect(files.map((file) => file.path).sort()).toEqual([a.path, b.path].sort());
    expect(files.every((file) => file.format === "txt")).toBe(true);
  });

  it("drops inventory ids that are unknown or already gone from disk", async () => {
    const keep = await insertInventory("在.txt", "内容");
    const gone = await insertInventory("没了.txt", "内容");
    await writeFile(gone.path, "内容");
    opened.db.prepare("UPDATE file_inventory SET inventory_status = 'missing' WHERE id = ?").run(gone.id);
    const { service } = makeService();

    const files = service.resolveImportFiles(rootId, rootDir, [keep.id, gone.id, "does-not-exist"]);

    // A file can vanish between the scan and the import; losing the whole request over
    // it would be absurd.
    expect(files.map((file) => file.inventoryId)).toEqual([keep.id]);
  });
});

/**
 * A series the user has already dealt with.
 *
 * This is the reported case: books were filed into a collection by hand — under a name
 * the user chose, not the one derived from the filename — and the suggestion stayed in
 * the queue, offering to create a collection that would have been a second copy under
 * the wrong name.
 */
describe("ScanReviewService — series already organized", () => {
  let tempDir: string;
  let rootDir: string;
  let opened: OpenedDatabase;
  let roots: LibraryRootRepository;
  let inventory: FileInventoryRepository;
  let findings: ScanFindingRepository;
  let collections: CustomCollectionService;
  let rootId: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "reader-organized-test-"));
    rootDir = join(tempDir, "root");
    await mkdir(rootDir, { recursive: true });
    opened = openDatabase(tempDir);
    roots = new LibraryRootRepository(opened.db);
    inventory = new FileInventoryRepository(opened.db);
    findings = new ScanFindingRepository(opened.db);
    rootId = roots.ensureRoot(rootDir, "我的书库", "2026-07-24T00:00:00.000Z").id;
    opened.db.prepare(
      "INSERT INTO scan_jobs(id, root_id, state, phase, cursor_json, counters_json, started_at, last_heartbeat_at) VALUES ('j1', ?, 'completed', 'completed', '{}', '{}', 'now', 'now')",
    ).run(rootId);
    collections = new CustomCollectionService(opened.db, {
      listBooks: async () => [],
      getBook: (id: string) => new BookRepository(opened.db).getBook(id)!,
    });
  });

  afterEach(async () => {
    opened.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  async function insertInventory(name: string) {
    const path = join(rootDir, name);
    await writeFile(path, `content of ${name}`);
    const fp = await quickFingerprint(path);
    const id = randomUUID();
    opened.db.prepare(
      `INSERT INTO file_inventory(id, root_id, relative_path, format, file_size, modified_at, inventory_status, metadata_state, resolution_state, updated_at, quick_fingerprint_version, quick_fingerprint)
       VALUES (?, ?, ?, 'txt', ?, ?, 'discovered', 'ready', 'ready', ?, ?, ?)`,
    ).run(id, rootId, name, fp.fileSize, fp.modifiedAt, "2026-07-24T00:00:00.000Z", fp.version, fp.fingerprint);
    return { id, path };
  }

  function registerBook(path: string, title: string) {
    const bookId = randomUUID();
    opened.db.prepare("INSERT INTO books(id, format, title, author, created_at, updated_at) VALUES (?,'txt',?,NULL,'now','now')").run(bookId, title);
    opened.db.prepare(
      `INSERT INTO book_sources(id, book_id, source_path, quick_fingerprint_version, quick_fingerprint,
        full_content_hash_algorithm, full_content_hash, file_size, modified_at, source_revision, availability_status, verified_at)
       VALUES (?,?,?,1,'fp','sha256','hash',10,'now',?, 'available','now')`,
    ).run(randomUUID(), bookId, path, randomUUID());
    return bookId;
  }

  /** The series the user reported, kept verbatim as the fixture name. */
  const SERIES_NAME = "転生したらチートだけど美少女に性転換ですョ(ToT)";
  /** What they actually called the collection. Deliberately different. */
  const USER_COLLECTION_NAME = "性转合集";

  function makeService() {
    return new ScanReviewService({
      db: opened.db,
      roots,
      inventory,
      findings,
      operations: new ScanOperationRepository(opened.db),
      recycler: new DuplicateRecycleService({
        inventory,
        findings,
        operations: new ScanOperationRepository(opened.db),
        quickFingerprint,
        fullContentHash,
        trash: async () => "recycle-bin",
        now: () => "2026-07-24T00:01:00.000Z",
      }),
      collections,
      importer: { importMixedFiles: async () => [] } as never,
      now: () => "2026-07-24T00:01:00.000Z",
    });
  }

  async function makeSeries(volumeCount = 2, options: { importAll?: boolean } = {}) {
    const files = [];
    for (let index = 1; index <= volumeCount; index += 1) {
      files.push(await insertInventory(`${SERIES_NAME} 第${index}卷.txt`));
    }
    const bookIds = options.importAll === false
      ? []
      : files.map((file, index) => registerBook(file.path, `${SERIES_NAME} 第${index + 1}卷`));
    const finding = findings.upsertFinding({
      rootId,
      jobId: "j1",
      kind: "series_volume",
      status: "needs_review",
      confidence: 0.85,
      candidateIds: files.map((file) => file.id),
      evidence: {
        kind: "series_volume",
        evidenceVersion: 1,
        normalizedSeries: SERIES_NAME,
        volumeLabel: files.map((_file, index) => `第${index + 1}卷`).join("、"),
        volumeIndex: null,
        ruleCodes: ["series_pattern_match"],
      },
      now: "2026-07-24T00:00:00.000Z",
    });
    return { files, bookIds, finding };
  }

  it("stops suggesting a series once its books are filed together under the user's own name", async () => {
    const { bookIds, finding } = await makeSeries();
    const collection = await collections.create(USER_COLLECTION_NAME);
    await collections.addBooks(collection.id, bookIds);
    const service = makeService();

    const list = service.listFindings(rootId, { limit: 30, offset: 0, includeResolved: false });

    expect(list.findings).toEqual([]);
    expect(list.total).toBe(0);
    expect(list.awaitingReview).toBe(0);
    // The finding is untouched — it is filtered out of the queue, not resolved behind
    // the user's back, so removing the books from the collection brings it back.
    expect(findings.getFinding(finding.id)?.status).toBe("needs_review");
  });

  it("does not count an organized series as pending work in the summary", async () => {
    const { bookIds } = await makeSeries();
    const collection = await collections.create(USER_COLLECTION_NAME);
    await collections.addBooks(collection.id, bookIds);
    const service = makeService();

    const summary = service.overview(rootId, rootDir);

    expect(summary.seriesGroups).toBe(0);
    expect(summary.seriesReadyToCollect).toBe(0);
    expect(summary.seriesPendingImport).toBe(0);
  });

  it("brings the suggestion back if the books leave the collection", async () => {
    const { bookIds } = await makeSeries();
    const collection = await collections.create(USER_COLLECTION_NAME);
    await collections.addBooks(collection.id, bookIds);
    const service = makeService();
    expect(service.listFindings(rootId, { limit: 30, offset: 0, includeResolved: false }).total).toBe(0);

    await collections.removeBooks(collection.id, bookIds);

    expect(service.listFindings(rootId, { limit: 30, offset: 0, includeResolved: false }).total).toBe(1);
  });

  it("still suggests a series whose volumes are split across collections", async () => {
    const { bookIds } = await makeSeries();
    const first = await collections.create("合集甲");
    const second = await collections.create("合集乙");
    await collections.addBooks(first.id, [bookIds[0]]);
    await collections.addBooks(second.id, [bookIds[1]]);
    const service = makeService();

    // Not filed together, so there is still something to decide.
    expect(service.listFindings(rootId, { limit: 30, offset: 0, includeResolved: false }).total).toBe(1);
  });

  it("still suggests a series with an unimported volume", async () => {
    const { bookIds } = await makeSeries(3, { importAll: false });
    const collection = await collections.create(USER_COLLECTION_NAME);
    // Only the first volume made it into the library and the collection.
    const onlyBook = registerBook(
      join(rootDir, `${SERIES_NAME} 第1卷.txt`),
      `${SERIES_NAME} 第1卷`,
    );
    await collections.addBooks(collection.id, [onlyBook]);
    const service = makeService();

    const list = service.listFindings(rootId, { limit: 30, offset: 0, includeResolved: false });

    // There are still two files to import, so the suggestion is worth keeping.
    expect(list.total).toBe(1);
    expect(bookIds).toEqual([]);
  });

  it("refuses to file into a second collection when the books are already shelved", async () => {
    const { bookIds, finding } = await makeSeries();
    const collection = await collections.create(USER_COLLECTION_NAME);
    await collections.addBooks(collection.id, bookIds);
    const service = makeService();

    // A screen rendered before the books were filed can still send this.
    const result = await service.decide(rootId, rootDir, finding.id, "accept");

    expect(result.applied).toBe(false);
    expect(result.summary).toContain(USER_COLLECTION_NAME);
    const all = await collections.list();
    // The filename-derived name never became a collection.
    expect(all.map((item) => item.name)).toEqual([USER_COLLECTION_NAME]);
  });

  it("aims a partly shelved series at the collection it is already in", async () => {
    // Two volumes imported and filed, a third imported later: the suggestion is still
    // live (a new volume needs a home) but must not spawn a duplicate collection under
    // the filename.
    const { bookIds, files } = await makeSeries();
    const collection = await collections.create(USER_COLLECTION_NAME);
    await collections.addBooks(collection.id, bookIds);

    const extra = await insertInventory(`${SERIES_NAME} 第3卷.txt`);
    const extraBook = registerBook(extra.path, `${SERIES_NAME} 第3卷`);
    findings.upsertFinding({
      rootId,
      jobId: "j1",
      kind: "series_volume",
      status: "needs_review",
      confidence: 0.85,
      candidateIds: [...files.map((file) => file.id), extra.id],
      evidence: {
        kind: "series_volume",
        evidenceVersion: 1,
        normalizedSeries: SERIES_NAME,
        volumeLabel: "第1卷、第2卷、第3卷",
        volumeIndex: null,
        ruleCodes: ["series_pattern_match"],
      },
      now: "2026-07-24T00:00:00.000Z",
    });
    const service = makeService();

    const list = service.listFindings(rootId, {
      limit: 30, offset: 0, includeResolved: false, kind: "series_volume",
    });

    // The old finding key (2 volumes) is satisfied and hidden; the new one (3 volumes)
    // is shown, and it points at the collection the user already made.
    expect(list.findings.map((item) => item.proposedAction)).toEqual([
      { kind: "create_collection", name: USER_COLLECTION_NAME, bookIds: expect.arrayContaining([extraBook]) },
    ]);
  });

  it("leaves duplicate findings alone", async () => {
    // The filter is about series. A duplicate that happens to share a collection with
    // something must still be offered.
    const a = await insertInventory("a.txt");
    const b = await insertInventory("b.txt");
    const bookId = registerBook(a.path, "a");
    const collection = await collections.create("随便");
    await collections.addBooks(collection.id, [bookId]);
    findings.upsertFinding({
      rootId,
      jobId: "j1",
      kind: "exact_duplicate",
      status: "new",
      confidence: 1,
      candidateIds: [a.id, b.id],
      evidence: {
        kind: "exact_duplicate",
        evidenceVersion: 1,
        algorithm: "sha256",
        fullContentHash: "a".repeat(64),
        survivorInventoryId: a.id,
        volumeConflict: false,
        ruleCodes: ["exact_hash_match"],
      },
      now: "2026-07-24T00:00:00.000Z",
    });
    const service = makeService();

    const list = service.listFindings(rootId, {
      limit: 30, offset: 0, includeResolved: false, kind: "exact_duplicate",
    });

    expect(list.total).toBe(1);
  });
});
