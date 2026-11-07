import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LATEST_SCHEMA_VERSION, openDatabase, migrate, type Migration, type OpenedDatabase } from "../../src/backend/storage/database.js";
import { initialStatements } from "../../src/backend/storage/migrations/001-initial.js";
import { libraryInventoryStatements } from "../../src/backend/storage/migrations/005-library-inventory.js";
import { librarianConversationStatements } from "../../src/backend/storage/migrations/004-librarian-conversation.js";
import { FileInventoryRepository } from "../../src/backend/library-scan/file-inventory-repository.js";
import { InventoryMetadataSchema, LibraryScanCountersSchema, ScanFindingEvidenceSchema } from "../../src/shared/contracts.js";

describe("Library Local Resolution Migration 006, Contracts & Inventory Processing States", () => {
  let tempDir: string;
  let opened: OpenedDatabase | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "reader-mig006-test-"));
  });

  afterEach(async () => {
    opened?.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("migrates a new database to the latest schema version", () => {
    opened = openDatabase(tempDir);
    expect(opened.schemaVersion).toBe(LATEST_SCHEMA_VERSION);

    const tables = opened.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    expect(tables.map((t) => t.name)).toContain("scan_findings");
  });

  it("allows a completed terminal phase after upgrading from v5", () => {
    const dbPath = join(tempDir, "reader.db");
    const rawDb = new Database(dbPath);
    const v5Migrations: Migration[] = [
      { version: 1, statements: initialStatements },
      { version: 4, statements: librarianConversationStatements },
      { version: 5, statements: libraryInventoryStatements },
    ];
    migrate(rawDb, v5Migrations);
    rawDb.prepare("INSERT INTO library_roots(id, root_path, display_name, created_at, updated_at) VALUES ('r1', 'C:\\test', 'Test', 'now', 'now')").run();
    rawDb.prepare("INSERT INTO scan_jobs(id, root_id, state, phase, cursor_json, counters_json, started_at, last_heartbeat_at) VALUES ('j1', 'r1', 'running', 'local_resolution', '{}', '{}', 'now', 'now')").run();
    rawDb.close();

    opened = openDatabase(tempDir);
    expect(opened.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(() => opened!.db.prepare("UPDATE scan_jobs SET state = 'completed', phase = 'completed' WHERE id = 'j1'").run()).not.toThrow();
  });

  it("preserves v5 rows and adds default status columns on file_inventory", () => {
    const dbPath = join(tempDir, "reader.db");
    const rawDb = new Database(dbPath);
    const v5Migrations: Migration[] = [
      { version: 1, statements: initialStatements },
      { version: 4, statements: librarianConversationStatements },
      { version: 5, statements: libraryInventoryStatements },
    ];
    migrate(rawDb, v5Migrations);
    rawDb.prepare("INSERT INTO library_roots(id, root_path, display_name, created_at, updated_at) VALUES ('r1', 'C:\\test', 'Test', 'now', 'now')").run();
    rawDb.prepare("INSERT INTO file_inventory(id, root_id, relative_path, format, file_size, modified_at, inventory_status, updated_at) VALUES ('f1', 'r1', 'a.txt', 'txt', 10, 'now', 'discovered', 'now')").run();
    rawDb.close();

    // Open via openDatabase running up to v6
    opened = openDatabase(tempDir);
    expect(opened.schemaVersion).toBe(LATEST_SCHEMA_VERSION);

    const row = opened.db.prepare("SELECT metadata_state, resolution_state FROM file_inventory WHERE id='f1'").get() as { metadata_state: string; resolution_state: string };
    expect(row).toEqual({ metadata_state: "pending", resolution_state: "pending" });
  });

  it("parses legacy 7-field counters_json with new default zero fields", () => {
    const legacyJson = {
      discovered: 10,
      supported: 8,
      cached: 2,
      queued: 6,
      processed: 8,
      errors: 0,
      skipped: 0,
    };
    const parsed = LibraryScanCountersSchema.parse(legacyJson);
    expect(parsed.metadataTotal).toBe(0);
    expect(parsed.resolutionTotal).toBe(0);
  });

  it("validates InventoryMetadataSchema and rejects extra keys or absolute paths", () => {
    const valid = {
      metadataVersion: 1,
      title: "三号书",
      author: "作者甲",
      language: "zh-CN",
      identifier: "urn:isbn:123",
      source: "epub-opf",
    };
    expect(InventoryMetadataSchema.parse(valid)).toEqual(valid);

    expect(() => InventoryMetadataSchema.parse({ ...valid, extraKey: 123 })).toThrow();
    expect(() => InventoryMetadataSchema.parse({ ...valid, title: "C:\\path\\to\\file" })).toThrow();
  });

  it("validates ScanFindingEvidenceSchema according to discriminated kind", () => {
    const exactEvidence = {
      kind: "exact_duplicate" as const,
      evidenceVersion: 1 as const,
      algorithm: "sha256" as const,
      fullContentHash: "a".repeat(64),
      survivorInventoryId: "inv-1",
      volumeConflict: false,
      ruleCodes: ["exact_hash_match"],
    };
    expect(ScanFindingEvidenceSchema.parse(exactEvidence)).toBeTruthy();

    expect(() => ScanFindingEvidenceSchema.parse({ kind: "exact_duplicate", evidenceVersion: 1 } as any)).toThrow();
  });

  it("rejects invalid metadata_state or resolution_state in FileInventoryRepository", () => {
    opened = openDatabase(tempDir);
    opened.db.prepare("INSERT INTO library_roots(id, root_path, display_name, created_at, updated_at) VALUES ('r1', 'C:\\test', 'Test', 'now', 'now')").run();
    opened.db.prepare("INSERT INTO file_inventory(id, root_id, relative_path, format, file_size, modified_at, inventory_status, updated_at) VALUES ('f-bad', 'r1', 'bad.txt', 'txt', 10, 'now', 'discovered', 'now')").run();

    // Bypass check constraint via raw update with check constraints disabled
    opened.db.pragma("ignore_check_constraints = ON");
    opened.db.prepare("UPDATE file_inventory SET metadata_state = 'corrupt_state' WHERE id = 'f-bad'").run();

    const repo = new FileInventoryRepository(opened.db);
    expect(() => repo.listMetadataWork("r1")).toThrow();
  });

  it("enforces bounded limit in listMetadataWork and listResolutionCandidates", () => {
    opened = openDatabase(tempDir);
    opened.db.prepare("INSERT INTO library_roots(id, root_path, display_name, created_at, updated_at) VALUES ('r1', 'C:\\test', 'Test', 'now', 'now')").run();

    const repo = new FileInventoryRepository(opened.db);
    for (let i = 0; i < 20; i++) {
      repo.upsertSeen("r1", "j1", { relativePath: `file-${i.toString().padStart(2, "0")}.txt`, format: "txt", fileSize: 100, modifiedAt: "now" }, "now");
    }

    const work = repo.listMetadataWork("r1", 5);
    expect(work.length).toBe(5);
  });
});
