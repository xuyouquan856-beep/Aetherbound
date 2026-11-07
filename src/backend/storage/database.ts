import Database from "better-sqlite3";
import { join } from "node:path";
import { ensureDataRoot } from "./data-root.js";
import { initialStatements } from "./migrations/001-initial.js";
import { epubStatements } from "./migrations/002-epub.js";
import { librarianStatements } from "./migrations/003-librarian.js";
import { librarianConversationStatements } from "./migrations/004-librarian-conversation.js";
import { libraryInventoryStatements } from "./migrations/005-library-inventory.js";
import { libraryLocalResolutionStatements } from "./migrations/006-library-local-resolution.js";
import { repairCompletedScanPhaseStatements } from "./migrations/007-repair-completed-scan-phase.js";
import { agentResolutionStatements } from "./migrations/008-agent-resolution.js";
import { fts5SearchStatements } from "./migrations/009-fts5-search.js";
import { fulltextIndexStatements } from "./migrations/010-fulltext-index.js";
import { reviewPersistenceStatements } from "./migrations/011-review-persistence.js";
import { customCollectionStatements } from "./migrations/012-custom-collections.js";
import { bookPreparationStatements } from "./migrations/013-book-preparation-jobs.js";
import { cjkFulltextStatements } from "./migrations/014-cjk-fulltext.js";
import { collectionImportAliasStatements } from "./migrations/015-collection-import-aliases.js";
import { fastFulltextRemovalStatements } from "./migrations/016-fast-fulltext-removal.js";
import { readingRecordStatements } from "./migrations/017-reading-records.js";

export type Migration = {
  version: number;
  statements: readonly string[];
  transaction?: boolean;
};
export const migrations: Migration[] = [
  { version: 1, statements: initialStatements },
  { version: 2, statements: epubStatements },
  { version: 3, statements: librarianStatements },
  { version: 4, statements: librarianConversationStatements },
  { version: 5, statements: libraryInventoryStatements },
  { version: 6, statements: libraryLocalResolutionStatements },
  { version: 7, statements: repairCompletedScanPhaseStatements, transaction: false },
  { version: 8, statements: agentResolutionStatements },
  { version: 9, statements: fts5SearchStatements },
  { version: 10, statements: fulltextIndexStatements },
  { version: 11, statements: reviewPersistenceStatements },
  { version: 12, statements: customCollectionStatements },
  { version: 13, statements: bookPreparationStatements },
  { version: 14, statements: cjkFulltextStatements },
  { version: 15, statements: collectionImportAliasStatements },
  { version: 16, statements: fastFulltextRemovalStatements },
  { version: 17, statements: readingRecordStatements },
];

/** Single source of truth so version assertions do not break on every migration. */
export const LATEST_SCHEMA_VERSION = migrations[migrations.length - 1]!.version;

function ensureMigrationTable(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
}

export function readSchemaVersion(db: Database.Database): number {
  ensureMigrationTable(db);
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as { version: number };
  return row.version;
}

export function migrate(db: Database.Database, planned: Migration[] = migrations): number {
  ensureMigrationTable(db);
  let current = readSchemaVersion(db);
  for (const migration of planned.filter((item) => item.version > current).sort((a, b) => a.version - b.version)) {
    const apply = () => {
      for (const statement of migration.statements) db.exec(statement);
      db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(migration.version, new Date().toISOString());
    };
    if (migration.transaction === false) apply();
    else db.transaction(apply)();
    current = migration.version;
  }
  return current;
}

export function openDatabase(dataRoot: string) {
  const root = ensureDataRoot(dataRoot);
  const db = new Database(join(root, "reader.db"));
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  const schemaVersion = migrate(db);
  return { db, dataRoot: root, schemaVersion, close: () => db.close() };
}

export type OpenedDatabase = ReturnType<typeof openDatabase>;
