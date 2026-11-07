import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { LATEST_SCHEMA_VERSION, migrate, openDatabase, readSchemaVersion, type Migration } from "../../src/backend/storage/database.js";
import { SettingsRepository } from "../../src/backend/storage/settings-repository.js";
import {
  DefaultReaderShortcutProfile,
  DefaultReadingAppearance,
} from "../../src/shared/contracts.js";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("reader storage", () => {
  it("creates the current schema once and reopens at the latest version", async () => {
    const root = await mkdtemp(join(tmpdir(), "reader-storage-"));
    cleanup.push(root);
    const first = openDatabase(root);
    expect(first.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(first.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "books" }),
      expect.objectContaining({ name: "book_sources" }),
      expect.objectContaining({ name: "reading_progress" }),
      expect.objectContaining({ name: "reading_sessions" }),
      expect.objectContaining({ name: "settings" }),
      expect.objectContaining({ name: "librarian_operations" }),
      expect.objectContaining({ name: "librarian_conversations" }),
      expect.objectContaining({ name: "librarian_messages" }),
      expect.objectContaining({ name: "library_roots" }),
      expect.objectContaining({ name: "file_inventory" }),
      expect.objectContaining({ name: "scan_jobs" }),
    ]));
    first.close();
    const second = openDatabase(root);
    expect(second.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    second.close();
  });

  it("rolls back all statements from a failed migration", () => {
    const db = new Database(":memory:");
    const migrations: Migration[] = [{ version: 1, statements: ["CREATE TABLE partial(id TEXT)", "INVALID SQL"] }];
    expect(() => migrate(db, migrations)).toThrow();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='partial'").get()).toBeUndefined();
    expect(readSchemaVersion(db)).toBe(0);
    db.close();
  });

  it("persists the complete reading appearance across a database reopen", async () => {
    const root = await mkdtemp(join(tmpdir(), "reader-settings-"));
    cleanup.push(root);
    const appearance = {
      theme: "night" as const,
      fontFamily: "sans" as const,
      fontSize: 24,
      lineHeight: 2.05,
      measure: 840,
      brightness: 65,
      epubFlow: "scrolled" as const,
      epubColumns: "single" as const,
      paragraphSpacing: 0.75,
      firstLineIndent: "none" as const,
      letterSpacing: 0.08,
    };

    const first = openDatabase(root);
    new SettingsRepository(first.db).saveAppearance(appearance);
    first.close();

    const second = openDatabase(root);
    expect(new SettingsRepository(second.db).getAppearance()).toEqual(appearance);
    second.close();
  });

  it("backfills a legacy appearance row without a database migration", async () => {
    const root = await mkdtemp(join(tmpdir(), "reader-legacy-settings-"));
    cleanup.push(root);
    const opened = openDatabase(root);
    opened.db.prepare(
      "INSERT INTO settings(key,value_json,updated_at) VALUES (?,?,?)",
    ).run("readingAppearance", JSON.stringify({
      theme: "night",
      fontFamily: "sans",
      fontSize: 22,
      lineHeight: 1.9,
      measure: 760,
      brightness: 80,
    }), new Date().toISOString());

    const settings = new SettingsRepository(opened.db);
    const restored = settings.getAppearance();
    expect(restored).toEqual({
      ...DefaultReadingAppearance,
      theme: "night",
      fontFamily: "sans",
      fontSize: 22,
      lineHeight: 1.9,
      measure: 760,
      brightness: 80,
    });
    expect(settings.saveAppearance(restored)).toEqual(restored);
    expect(JSON.parse((opened.db.prepare(
      "SELECT value_json FROM settings WHERE key='readingAppearance'",
    ).get() as { value_json: string }).value_json)).toEqual(restored);
    opened.close();
  });

  it("persists shortcuts and falls back from damaged shortcut JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "reader-shortcuts-"));
    cleanup.push(root);
    const opened = openDatabase(root);
    const settings = new SettingsRepository(opened.db);
    const custom = structuredClone(DefaultReaderShortcutProfile);
    custom.bindings["reader.page.next"] = [{
      code: "Space",
      ctrl: false,
      alt: false,
      shift: false,
      meta: false,
    }];

    expect(settings.saveShortcuts(custom)).toEqual(custom);
    expect(settings.getShortcuts()).toEqual(custom);
    opened.db.prepare(
      "UPDATE settings SET value_json=? WHERE key='readerShortcuts'",
    ).run("{broken");
    expect(settings.getShortcuts()).toEqual(DefaultReaderShortcutProfile);
    opened.close();
  });
});
