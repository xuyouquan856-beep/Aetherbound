import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { detectRasterCoverMediaType } from "../../formats/epub/cover.js";
import { COVER_THUMBNAIL_FILE, type CoverThumbnailer } from "./epub-preparation-service.js";

type BackfillDependencies = {
  db: Database.Database;
  dataRoot: string;
  createCoverThumbnail: CoverThumbnailer;
  /** Bounded per run so a large library does not stall startup. */
  limit?: number;
};

/**
 * Libraries prepared before thumbnails existed only have the full-size cover, and
 * re-importing every book just to gain a thumbnail is not acceptable. Generate the
 * missing thumbnails in the background from the covers already in the cache.
 *
 * Deliberately reads the prepared cover rather than the user's original EPUB: it
 * touches nothing the user owns and needs no archive parsing.
 */
export async function backfillCoverThumbnails({
  db,
  dataRoot,
  createCoverThumbnail,
  limit = 500,
}: BackfillDependencies): Promise<number> {
  const books = db.prepare(
    `SELECT b.id AS id, s.source_revision AS source_revision
     FROM books b
     JOIN book_sources s ON s.book_id = b.id
     WHERE b.format = 'epub' AND s.availability_status = 'available'
     ORDER BY b.created_at ASC, b.id ASC
     LIMIT ?`,
  ).all(limit) as Array<{ id: string; source_revision: string }>;

  let created = 0;
  for (const book of books) {
    const directory = join(dataRoot, "publications", book.id, book.source_revision);
    const coverPath = join(directory, "cover");
    const thumbnailPath = join(directory, COVER_THUMBNAIL_FILE);
    if (existsSync(thumbnailPath) || !existsSync(coverPath)) continue;
    try {
      const cover = new Uint8Array(await readFile(coverPath));
      const mediaType = detectRasterCoverMediaType(cover);
      if (!mediaType) continue;
      const thumbnail = await createCoverThumbnail(cover, mediaType).catch(() => null);
      if (!thumbnail || thumbnail.byteLength === 0) continue;
      await writeFile(thumbnailPath, thumbnail);
      created += 1;
    } catch {
      // Best effort: a book that cannot be thumbnailed keeps using its cover.
    }
  }
  return created;
}
