import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LATEST_SCHEMA_VERSION, openDatabase } from "../../src/backend/storage/database.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) =>
    rm(path, { recursive: true, force: true }),
  ));
});

describe("book preparation migration", () => {
  it("creates the current schema with constrained persistent jobs and delete cascade", async () => {
    const root = await mkdtemp(join(tmpdir(), "reader-preparation-migration-"));
    cleanup.push(root);
    const opened = openDatabase(root);
    const now = "2026-07-29T00:00:00.000Z";

    expect(opened.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(opened.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='book_preparation_jobs'",
    ).get()).toEqual({ name: "book_preparation_jobs" });

    opened.db.prepare(
      "INSERT INTO books(id,format,title,author,created_at,updated_at) VALUES (?,'epub',?,NULL,?,?)",
    ).run("book-1", "Queued", now, now);
    expect(() => opened.db.prepare(`
      INSERT INTO book_preparation_jobs(
        book_id, source_revision, state, priority, attempt_count,
        error_code, created_at, updated_at, started_at, completed_at
      ) VALUES (?,?, 'queued', 'background', 0, NULL, ?, ?, NULL, NULL)
    `).run("book-1", "revision-1", now, now)).not.toThrow();

    expect(() => opened.db.prepare(`
      INSERT INTO book_preparation_jobs(
        book_id, source_revision, state, priority, attempt_count,
        error_code, created_at, updated_at
      ) VALUES (?,?, 'unknown', 'background', 0, NULL, ?, ?)
    `).run("book-2", "revision-2", now, now)).toThrow();
    expect(() => opened.db.prepare(
      "UPDATE book_preparation_jobs SET priority='urgent' WHERE book_id='book-1'",
    ).run()).toThrow();

    opened.db.prepare("DELETE FROM books WHERE id='book-1'").run();
    expect(opened.db.prepare(
      "SELECT book_id FROM book_preparation_jobs WHERE book_id='book-1'",
    ).get()).toBeUndefined();
    opened.close();
  });
});
