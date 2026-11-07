import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { LibraryRootRecord } from "./types.js";

type LibraryRootRow = {
  id: string;
  display_name: string;
  root_path: string;
  enabled: number;
};

export class LibraryRootRepository {
  constructor(private readonly db: Database.Database) {}

  ensureRoot(rootPath: string, displayName: string, now: string): LibraryRootRecord {
    return this.db.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM library_roots WHERE root_path = ?").get(rootPath) as LibraryRootRow | undefined;
      if (existing) {
        this.db.prepare("UPDATE library_roots SET display_name = ?, enabled = 1, updated_at = ? WHERE id = ?").run(
          displayName,
          now,
          existing.id,
        );
        return {
          id: existing.id,
          displayName,
          rootPath: existing.root_path,
          enabled: true,
        };
      }

      const id = randomUUID();
      this.db.prepare(
        "INSERT INTO library_roots (id, display_name, root_path, enabled, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
      ).run(id, displayName, rootPath, now, now);

      return {
        id,
        displayName,
        rootPath,
        enabled: true,
      };
    })();
  }

  getById(id: string): LibraryRootRecord | null {
    const row = this.db.prepare("SELECT * FROM library_roots WHERE id = ?").get(id) as LibraryRootRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      displayName: row.display_name,
      rootPath: row.root_path,
      enabled: row.enabled === 1,
    };
  }

  getByPath(rootPath: string): LibraryRootRecord | null {
    const row = this.db.prepare("SELECT * FROM library_roots WHERE root_path = ?").get(rootPath) as LibraryRootRow | undefined;
    return row ? this.mapRow(row) : null;
  }

  /**
   * The folder the scan should act on when the user starts one without picking again.
   *
   * `ensureRoot` touches `updated_at` every time a folder is chosen, so the most
   * recently chosen folder is the active one. Keeping this in the roots table rather
   * than a settings key means there is exactly one place that knows which folders the
   * user has authorized.
   */
  getMostRecent(): LibraryRootRecord | null {
    const row = this.db.prepare(
      "SELECT * FROM library_roots WHERE enabled = 1 ORDER BY updated_at DESC, created_at DESC, id ASC LIMIT 1",
    ).get() as LibraryRootRow | undefined;
    return row ? this.mapRow(row) : null;
  }

  listEnabled(): LibraryRootRecord[] {
    const rows = this.db.prepare(
      "SELECT * FROM library_roots WHERE enabled = 1 ORDER BY updated_at DESC, created_at DESC, id ASC",
    ).all() as LibraryRootRow[];
    return rows.map((row) => this.mapRow(row));
  }

  countForPath(rootPath: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM library_roots WHERE root_path = ?").get(rootPath) as { count: number };
    return row.count;
  }

  private mapRow(row: LibraryRootRow): LibraryRootRecord {
    return {
      id: row.id,
      displayName: row.display_name,
      rootPath: row.root_path,
      enabled: row.enabled === 1,
    };
  }
}
