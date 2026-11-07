import type Database from "better-sqlite3";
import { pathKey } from "./path-key.js";

/**
 * What the library already knows about a file found on disk.
 *
 * The reader stores books in place — `book_sources.source_path` is the user's own
 * file, not a copy — so a scanned file and a library book can be correlated exactly,
 * by path. That is what turns a folder listing into something actionable: "you own
 * this already", "this duplicate's surviving copy is the imported one", "this volume
 * can be added to a collection".
 */
export type LibraryLink = {
  bookId: string;
  /** False when the library row exists but its file is no longer usable. */
  available: boolean;
};

export type LibraryLinkIndex = {
  get(absolutePath: string): LibraryLink | undefined;
  size: number;
};

type SourceRow = {
  book_id: string;
  source_path: string;
  availability_status: string;
};

/**
 * Indexes every library source by canonical path.
 *
 * Rows are ordered newest-verified-first so that, if a path somehow appears twice, the
 * most recently confirmed source wins rather than an arbitrary one.
 */
export function loadLibraryLinks(db: Database.Database): LibraryLinkIndex {
  const rows = db.prepare(
    `SELECT book_id, source_path, availability_status
     FROM book_sources
     ORDER BY verified_at DESC, id ASC`,
  ).all() as SourceRow[];

  const byPath = new Map<string, LibraryLink>();
  for (const row of rows) {
    const key = pathKey(row.source_path);
    if (byPath.has(key)) continue;
    byPath.set(key, {
      bookId: row.book_id,
      available: row.availability_status === "available",
    });
  }

  return {
    get: (absolutePath: string) => byPath.get(pathKey(absolutePath)),
    size: byPath.size,
  };
}
