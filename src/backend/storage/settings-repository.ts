import type Database from "better-sqlite3";
import {
  DefaultReaderShortcutProfile,
  DefaultReadingAppearance,
  ReaderShortcutProfileSchema,
  ReadingAppearanceSchema,
  type ReaderShortcutProfileV1,
  type ReadingAppearance,
} from "../../shared/contracts.js";

export class SettingsRepository {
  constructor(private readonly db: Database.Database) {}

  private read(key: string): unknown {
    const row = this.db.prepare(
      "SELECT value_json FROM settings WHERE key=?",
    ).get(key) as { value_json: string } | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.value_json);
    } catch {
      return undefined;
    }
  }

  private write(key: string, value: unknown) {
    this.db.prepare(`INSERT INTO settings(key,value_json,updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
      .run(key, JSON.stringify(value), new Date().toISOString());
  }

  getAppearance(): ReadingAppearance {
    const parsed = ReadingAppearanceSchema.safeParse(this.read("readingAppearance"));
    return parsed.success ? parsed.data : DefaultReadingAppearance;
  }

  saveAppearance(value: ReadingAppearance): ReadingAppearance {
    const valid = ReadingAppearanceSchema.parse(value);
    this.write("readingAppearance", valid);
    return valid;
  }

  getShortcuts(): ReaderShortcutProfileV1 {
    const parsed = ReaderShortcutProfileSchema.safeParse(this.read("readerShortcuts"));
    return parsed.success ? parsed.data : DefaultReaderShortcutProfile;
  }

  saveShortcuts(value: ReaderShortcutProfileV1): ReaderShortcutProfileV1 {
    const valid = ReaderShortcutProfileSchema.parse(value);
    this.write("readerShortcuts", valid);
    return valid;
  }

  getManagedFolderPath(): string | null {
    const value = this.read("librarianManagedFolder");
    return typeof value === "string" && value ? value : null;
  }

  saveManagedFolderPath(value: string) {
    this.write("librarianManagedFolder", value);
  }
}
