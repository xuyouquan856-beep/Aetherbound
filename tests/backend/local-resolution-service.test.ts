import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type OpenedDatabase } from "../../src/backend/storage/database.js";
import { LocalResolutionService } from "../../src/backend/library-scan/local-resolution-service.js";
import { FileInventoryRepository } from "../../src/backend/library-scan/file-inventory-repository.js";
import { loadLibraryLinks } from "../../src/backend/library-scan/library-link.js";
import { fullContentHash, quickFingerprint } from "../../src/backend/library/fingerprint.js";

describe("LocalResolutionService", () => {
  let tempDir: string;
  let rootDir: string;
  let opened: OpenedDatabase;
  let inventory: FileInventoryRepository;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "reader-lrs-test-"));
    rootDir = join(tempDir, "root");
    await mkdir(rootDir, { recursive: true });
    opened = openDatabase(tempDir);
    inventory = new FileInventoryRepository(opened.db);
    opened.db.prepare("INSERT INTO library_roots(id, root_path, display_name, created_at, updated_at) VALUES ('r1', ?, 'Test', 'now', 'now')").run(rootDir);
    opened.db.prepare("INSERT INTO scan_jobs(id, root_id, state, phase, cursor_json, counters_json, started_at, last_heartbeat_at) VALUES ('j1', 'r1', 'running', 'local_resolution', '{}', '{}', 'now', 'now')").run();
  });

  afterEach(async () => {
    opened.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  function makeContext() {
    return { libraryLink: loadLibraryLinks(opened.db), inventory };
  }

  async function createTxtFile(name: string, content: string): Promise<{ path: string; invId: string }> {
    const path = join(rootDir, name);
    await writeFile(path, content);
    const fp = await quickFingerprint(path);
    const invId = randomUUID();
    opened.db.prepare(
      `INSERT INTO file_inventory(id, root_id, relative_path, format, file_size, modified_at, inventory_status, metadata_state, resolution_state, updated_at, quick_fingerprint_version, quick_fingerprint)
       VALUES (?, 'r1', ?, 'txt', ?, ?, 'discovered', 'ready', 'pending', ?, ?, ?)`,
    ).run(invId, name, fp.fileSize, fp.modifiedAt, new Date().toISOString(), fp.version, fp.fingerprint);
    return { path, invId };
  }

  /** Registers a file as an existing library book, so correlation can find it. */
  function registerBook(path: string, title: string) {
    const bookId = randomUUID();
    const sourceRevision = randomUUID();
    opened.db.prepare("INSERT INTO books(id, format, title, author, created_at, updated_at) VALUES (?,'txt',?,NULL,'now','now')").run(bookId, title);
    opened.db.prepare(
      `INSERT INTO book_sources(id, book_id, source_path, quick_fingerprint_version, quick_fingerprint,
        full_content_hash_algorithm, full_content_hash, file_size, modified_at, source_revision, availability_status, verified_at)
       VALUES (?,?,?,1,'fp','sha256','hash',10,'now',?, 'available','now')`,
    ).run(randomUUID(), bookId, path, sourceRevision);
    return bookId;
  }

  it("generates exact_duplicate:new for same-hash files without volume conflict", async () => {
    const content = "Same content here";
    await createTxtFile("dup-a.txt", content);
    await createTxtFile("dup-b.txt", content);

    const service = new LocalResolutionService(opened.db);
    const result = await service.runLocalResolution({
      rootId: "r1",
      jobId: "j1",
      rootPath: rootDir,
      computeFullHash: fullContentHash,
      now: "2026-07-24T00:00:00.000Z",
      ...makeContext(),
    });

    const dupFindings = result.findings.filter((f) => f.kind === "exact_duplicate");
    expect(dupFindings.length).toBeGreaterThanOrEqual(1);
    expect(dupFindings[0].status).toBe("new");
  });

  it("sets exact_duplicate:needs_review when same hash but different volumes", async () => {
    const content = "Same content different volumes";
    await createTxtFile("小说 第1卷.txt", content);
    await createTxtFile("小说 第2卷.txt", content);

    const service = new LocalResolutionService(opened.db);
    const result = await service.runLocalResolution({
      rootId: "r1",
      jobId: "j1",
      rootPath: rootDir,
      computeFullHash: fullContentHash,
      now: "2026-07-24T00:00:00.000Z",
      ...makeContext(),
    });

    const dupFindings = result.findings.filter((f) => f.kind === "exact_duplicate");
    expect(dupFindings.length).toBeGreaterThanOrEqual(1);
    expect(dupFindings[0].status).toBe("needs_review");
    expect(dupFindings[0].evidence).toMatchObject({ volumeConflict: true });
  });

  it("generates series_volume findings for multi-volume series", async () => {
    await createTxtFile("刀剑神域 第1卷.txt", "第一卷内容");
    await createTxtFile("刀剑神域 第2卷.txt", "第二卷内容");

    const service = new LocalResolutionService(opened.db);
    const result = await service.runLocalResolution({
      rootId: "r1",
      jobId: "j1",
      rootPath: rootDir,
      computeFullHash: fullContentHash,
      now: "2026-07-24T00:00:00.000Z",
      ...makeContext(),
    });

    const seriesFindings = result.findings.filter((f) => f.kind === "series_volume");
    expect(seriesFindings.length).toBe(1);
    expect(seriesFindings[0].evidence).toMatchObject({ normalizedSeries: "刀剑神域" });
    expect(seriesFindings[0].candidateIds).toHaveLength(2);
  });

  it("does not call two identically named files a series", async () => {
    // Neither file has a volume marker, so `normalizedSeries` falls back to the title
    // for both. Grouping on that alone reported every such pair as a series.
    await createTxtFile("某本书.txt", "文字甲");
    await createTxtFile("某本书.epub", "文字乙");

    const service = new LocalResolutionService(opened.db);
    const result = await service.runLocalResolution({
      rootId: "r1",
      jobId: "j1",
      rootPath: rootDir,
      computeFullHash: fullContentHash,
      now: "2026-07-24T00:00:00.000Z",
      ...makeContext(),
    });

    expect(result.findings.filter((f) => f.kind === "series_volume")).toHaveLength(0);
  });

  it("does not call two copies of one volume a series", async () => {
    await createTxtFile("某系列 第1卷.txt", "第一卷内容");
    await createTxtFile("某系列 第1卷 副本.txt", "第一卷内容副本");

    const service = new LocalResolutionService(opened.db);
    const result = await service.runLocalResolution({
      rootId: "r1",
      jobId: "j1",
      rootPath: rootDir,
      computeFullHash: fullContentHash,
      now: "2026-07-24T00:00:00.000Z",
      ...makeContext(),
    });

    expect(result.findings.filter((f) => f.kind === "series_volume")).toHaveLength(0);
  });

  it("finds the volume in the file name when the title does not have one", async () => {
    // A TXT whose first line reads like a title gets that line as its title, and the line
    // is usually not where the volume number is. Detection that only looked at the title
    // silently missed these entirely.
    const first = await createTxtFile("刀剑神域 第1卷.txt", "正文内容。");
    const second = await createTxtFile("刀剑神域 第2卷.txt", "正文内容。");
    for (const file of [first, second]) {
      opened.db.prepare("UPDATE file_inventory SET metadata_json = ? WHERE id = ?").run(
        JSON.stringify({
          metadataVersion: 1,
          title: "序章 某个少年的故事",
          author: null,
          language: null,
          identifier: null,
          source: "txt-head",
        }),
        file.invId,
      );
    }

    const service = new LocalResolutionService(opened.db);
    const result = await service.runLocalResolution({
      rootId: "r1",
      jobId: "j1",
      rootPath: rootDir,
      computeFullHash: fullContentHash,
      now: "2026-07-24T00:00:00.000Z",
      ...makeContext(),
    });

    const series = result.findings.filter((f) => f.kind === "series_volume");
    expect(series).toHaveLength(1);
    expect(series[0].evidence).toMatchObject({ normalizedSeries: "刀剑神域" });
  });

  it("prefers a volume marker in the title over one in the file name", async () => {
    // When both carry one, the title is the more deliberate name.
    const first = await createTxtFile("dragon_01.txt", "正文。");
    const second = await createTxtFile("dragon_02.txt", "正文。");
    for (const [index, file] of [first, second].entries()) {
      opened.db.prepare("UPDATE file_inventory SET metadata_json = ? WHERE id = ?").run(
        JSON.stringify({
          metadataVersion: 1,
          title: `龙族 第${index + 1}卷`,
          author: null,
          language: null,
          identifier: null,
          source: "epub-opf",
        }),
        file.invId,
      );
    }

    const service = new LocalResolutionService(opened.db);
    const result = await service.runLocalResolution({
      rootId: "r1",
      jobId: "j1",
      rootPath: rootDir,
      computeFullHash: fullContentHash,
      now: "2026-07-24T00:00:00.000Z",
      ...makeContext(),
    });

    expect(result.findings.filter((f) => f.kind === "series_volume")[0].evidence)
      .toMatchObject({ normalizedSeries: "龙族" });
  });

  it("records which files the library already owns", async () => {
    const imported = await createTxtFile("已有.txt", "已入库内容");
    const fresh = await createTxtFile("新书.txt", "未入库内容");
    const bookId = registerBook(imported.path, "已有");

    const service = new LocalResolutionService(opened.db);
    await service.runLocalResolution({
      rootId: "r1",
      jobId: "j1",
      rootPath: rootDir,
      computeFullHash: fullContentHash,
      now: "2026-07-24T00:00:00.000Z",
      ...makeContext(),
    });

    // Correlation is by path, so a book admitted from this exact file is found...
    expect(loadLibraryLinks(opened.db).get(imported.path)?.bookId).toBe(bookId);
    // ...and a file the library has never seen is not.
    expect(loadLibraryLinks(opened.db).get(fresh.path)).toBeUndefined();
  });

  it("persists the content hashes it computed", async () => {
    const content = "Dedup content";
    const a = await createTxtFile("a.txt", content);
    const b = await createTxtFile("b.txt", content);

    const service = new LocalResolutionService(opened.db);
    await service.runLocalResolution({
      rootId: "r1",
      jobId: "j1",
      rootPath: rootDir,
      computeFullHash: fullContentHash,
      now: "2026-07-24T00:00:00.000Z",
      ...makeContext(),
    });

    const expected = await fullContentHash(a.path);
    expect(inventory.getById(a.invId)?.fullContentHash).toBe(expected);
    expect(inventory.getById(b.invId)?.fullContentHash).toBe(expected);
  });

  it("re-running same input does not increase finding count", async () => {
    const content = "Dedup content";
    await createTxtFile("a.txt", content);
    await createTxtFile("b.txt", content);

    const service = new LocalResolutionService(opened.db);

    const r1 = await service.runLocalResolution({ rootId: "r1", jobId: "j1", rootPath: rootDir, computeFullHash: fullContentHash, now: "2026-07-24T00:00:00.000Z", ...makeContext() });
    const count1 = r1.findings.length;

    const r2 = await service.runLocalResolution({ rootId: "r1", jobId: "j1", rootPath: rootDir, computeFullHash: fullContentHash, now: "2026-07-24T00:01:00.000Z", ...makeContext() });
    const count2 = r2.findings.length;

    expect(count2).toBe(count1);
  });
});
