import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";
import {
  PublicationViewSchema,
  type BookSummary,
  type PublicationView,
} from "../../shared/contracts.js";
import { ReaderError, type ReaderErrorCode } from "../../shared/errors.js";
import { EpubBookFormatAdapter } from "../../formats/epub/adapter.js";
import {
  isDeclaredRasterCover,
  type RasterCoverMediaType,
} from "../../formats/epub/cover.js";
import { EpubPolicyError } from "../../formats/epub/errors.js";
import { prepareEpub } from "../../formats/epub/prepare.js";
import { BookRepository } from "../storage/book-repository.js";
import { quickFingerprint } from "./fingerprint.js";

type PrepareEpubResult = Awaited<ReturnType<typeof prepareEpub>>;
type QuickFacts = Awaited<ReturnType<typeof quickFingerprint>>;

/**
 * Publication covers are commonly 1000-3000px wide. The UI paints them at
 * 58-260px, so shipping the original meant Chromium decoded several megapixels
 * per cover on every paint. This downscales once, at preparation time.
 * Returning null means "no thumbnail"; the full cover stays the fallback.
 */
export type CoverThumbnailer = (
  bytes: Uint8Array,
  mediaType: "image/jpeg" | "image/png" | "image/webp",
) => Promise<Uint8Array | null>;

/**
 * Cache file name for the downscaled cover. The version suffix is deliberate: the
 * file name is the only marker of which encoder produced it, so bumping the suffix
 * makes existing caches look empty and the startup backfill regenerates them. v1
 * was lossless PNG at 480x640 and averaged 470 KB; see the constants below.
 */
export const COVER_THUMBNAIL_FILE = "cover-thumb-v2";

/**
 * Sized for the largest place a cover is painted: a comfortable-mode grid tile
 * around 260px wide at 2x device pixel ratio. The collections stacks and list rows
 * are much smaller (116x160 and 62x80) and downscale from this cheaply.
 *
 * Encoded as JPEG. Measured on a real 281-book library, PNG output averaged 470 KB
 * per thumbnail against 771 KB for the untouched source — barely worth the work.
 * Calibre reaches the same conclusion: its `scale_image` defaults to JPEG.
 */
export const COVER_THUMBNAIL_MAX_WIDTH = 320;
export const COVER_THUMBNAIL_MAX_HEIGHT = 480;
export const COVER_THUMBNAIL_JPEG_QUALITY = 82;

type PreparationRuntime = {
  prepareEpub(
    sourcePath: string,
    destinationPath: string,
    signal?: AbortSignal,
  ): Promise<PrepareEpubResult>;
  quickFingerprint(path: string): Promise<QuickFacts>;
  createCoverThumbnail: CoverThumbnailer;
  createId(): string;
  now(): string;
};

export type PrepareResult = {
  book: BookSummary;
  publication: PublicationView;
  fullContentHash: string;
};

function adapterErrorCode(
  code: import("../../formats/epub/errors.js").AdapterErrorCode,
): ReaderErrorCode {
  return code === "UNSUPPORTED_FORMAT" ? "FORMAT_NOT_SUPPORTED" : code;
}

export class EpubPreparationService {
  private readonly books: BookRepository;
  private readonly runtime: PreparationRuntime;

  constructor(
    private readonly db: Database.Database,
    private readonly dataRoot: string,
    runtime: Partial<PreparationRuntime> = {},
  ) {
    this.books = new BookRepository(db);
    this.runtime = {
      prepareEpub: runtime.prepareEpub ?? prepareEpub,
      quickFingerprint: runtime.quickFingerprint ?? quickFingerprint,
      createCoverThumbnail: runtime.createCoverThumbnail ?? (async () => null),
      createId: runtime.createId ?? randomUUID,
      now: runtime.now ?? (() => new Date().toISOString()),
    };
  }

  async prepare(
    bookId: string,
    sourceRevision: string,
    signal?: AbortSignal,
  ): Promise<PrepareResult> {
    const source = this.books.getSourceForBook(bookId);
    const book = this.books.getBook(bookId);
    if (!source || !book) {
      throw new ReaderError("BOOK_NOT_FOUND", "The book no longer exists.");
    }
    if (book.format !== "epub") {
      throw new ReaderError("FORMAT_NOT_SUPPORTED", "The book is not an EPUB.");
    }
    if (source.sourceRevision !== sourceRevision) {
      throw new ReaderError("SOURCE_CHANGED", "The source revision is obsolete.");
    }

    const before = await this.runtime.quickFingerprint(source.sourcePath)
      .catch(() => null);
    if (!before || !this.matchesStoredSource(source, before)) {
      throw new ReaderError("SOURCE_CHANGED", "The source changed before preparation.");
    }

    const publicationsRoot = join(this.dataRoot, "publications");
    const stagingDir = join(
      publicationsRoot,
      `.staging-${bookId}-${this.runtime.createId()}`,
    );
    const stagingBook = join(stagingDir, "book.epub");
    const finalDir = join(publicationsRoot, bookId, sourceRevision);
    let movedToFinal = false;

    try {
      await mkdir(stagingDir, { recursive: true });
      const prepared = await this.runtime.prepareEpub(
        source.sourcePath,
        stagingBook,
        signal,
      );
      const adapter = new EpubBookFormatAdapter(
        async () => new Uint8Array(await readFile(stagingBook)),
      );
      let publication: PublicationView;
      let cover: { bytes: Uint8Array; mediaType: RasterCoverMediaType } | null = null;
      try {
        const opened = await adapter.openSource({ bookId, sourceRevision });
        if (!opened.ok) {
          throw new ReaderError(
            adapterErrorCode(opened.code),
            opened.detail ?? opened.code,
          );
        }
        publication = PublicationViewSchema.parse(opened.value);
        const readCover = await adapter.readCover();
        if (
          readCover.ok
          && readCover.value
          && isDeclaredRasterCover(readCover.value.mediaType, readCover.value.bytes)
        ) {
          cover = {
            bytes: readCover.value.bytes,
            mediaType: readCover.value.mediaType,
          };
        }
      } finally {
        await adapter.close();
      }

      await writeFile(
        join(stagingDir, "publication.json"),
        JSON.stringify(publication),
        "utf8",
      );
      if (cover) {
        await writeFile(join(stagingDir, "cover"), cover.bytes);
        // Best effort: a failed thumbnail must never fail the import.
        const thumbnail = await this.runtime
          .createCoverThumbnail(cover.bytes, cover.mediaType)
          .catch(() => null);
        if (thumbnail && thumbnail.byteLength > 0) {
          await writeFile(join(stagingDir, COVER_THUMBNAIL_FILE), thumbnail);
        }
      }

      const after = await this.runtime.quickFingerprint(source.sourcePath)
        .catch(() => null);
      if (!after || !this.sameFacts(before, after)) {
        throw new ReaderError("SOURCE_CHANGED", "The source changed during preparation.");
      }

      await mkdir(dirname(finalDir), { recursive: true });
      await rm(finalDir, { recursive: true, force: true });
      await rename(stagingDir, finalDir);
      movedToFinal = true;

      const now = this.runtime.now();
      const committed = this.db.transaction(() => {
        const current = this.books.getSourceForBook(bookId);
        if (
          !current
          || current.sourceRevision !== sourceRevision
          || !this.matchesStoredSource(current, after)
        ) {
          throw new ReaderError("SOURCE_CHANGED", "The source revision became obsolete.");
        }
        const sourceUpdate = this.db.prepare(`
          UPDATE book_sources
          SET full_content_hash_algorithm = 'sha256',
              full_content_hash = ?,
              verified_at = ?
          WHERE book_id = ?
            AND source_revision = ?
            AND file_size = ?
            AND modified_at = ?
            AND quick_fingerprint = ?
        `).run(
          prepared.fullContentHash,
          now,
          bookId,
          sourceRevision,
          after.fileSize,
          after.modifiedAt,
          after.fingerprint,
        );
        if (sourceUpdate.changes !== 1) {
          throw new ReaderError("SOURCE_CHANGED", "The source could not be committed.");
        }
        this.db.prepare(
          "UPDATE books SET title = ?, author = ?, updated_at = ? WHERE id = ?",
        ).run(
          publication.metadata.title,
          publication.metadata.author,
          now,
          bookId,
        );
        return this.books.getBook(bookId);
      })();
      if (!committed) {
        throw new ReaderError("BOOK_NOT_FOUND", "The prepared book was deleted.");
      }
      return {
        book: this.withPreparedCover(committed, sourceRevision, cover !== null),
        publication,
        fullContentHash: prepared.fullContentHash,
      };
    } catch (error) {
      if (movedToFinal) {
        await rm(finalDir, { recursive: true, force: true }).catch(() => undefined);
      }
      if (error instanceof ReaderError) throw error;
      if (error instanceof EpubPolicyError) {
        throw new ReaderError(adapterErrorCode(error.code), error.message);
      }
      throw new ReaderError("INVALID_PACKAGE", "The EPUB package is invalid or damaged.");
    } finally {
      await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private matchesStoredSource(
    source: ReturnType<BookRepository["getSourceForBook"]> & {},
    facts: QuickFacts,
  ) {
    return facts.isFile
      && source.fileSize === facts.fileSize
      && source.modifiedAt === facts.modifiedAt
      && source.quickFingerprint === facts.fingerprint;
  }

  private sameFacts(left: QuickFacts, right: QuickFacts) {
    return left.isFile === right.isFile
      && left.fileSize === right.fileSize
      && left.modifiedAt === right.modifiedAt
      && left.fingerprint === right.fingerprint;
  }

  private withPreparedCover(
    book: BookSummary,
    sourceRevision: string,
    hasCover: boolean,
  ): BookSummary {
    if (!hasCover) return book;
    return {
      ...book,
      coverUrl: `reader-resource://publication/${book.id}/${sourceRevision}/cover`,
    };
  }
}
