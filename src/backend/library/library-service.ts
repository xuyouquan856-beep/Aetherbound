import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import type Database from "better-sqlite3";
import {
  ControlledCoverUrlSchema,
  PublicationViewSchema,
  type BookSummary,
  type ChapterContent,
  type PublicationView,
} from "../../shared/contracts.js";
import { ReaderError, type ReaderErrorCode } from "../../shared/errors.js";
import { openTxt } from "../../formats/txt/adapter.js";
import { EpubBookFormatAdapter } from "../../formats/epub/adapter.js";
import { BookRepository } from "../storage/book-repository.js";
import { BookPreparationJobRepository } from "./book-preparation-job-repository.js";
import {
  COVER_THUMBNAIL_FILE,
  EpubPreparationService,
  type CoverThumbnailer,
} from "./epub-preparation-service.js";
import { LibraryAdmissionService } from "./library-admission-service.js";
async function isRegularFile(path: string | null) {
  if (!path) return false;
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

import { fullContentHash, quickFingerprint } from "./fingerprint.js";

function readerErrorCode(code: import("../../formats/epub/errors.js").AdapterErrorCode): ReaderErrorCode {
  return code === "UNSUPPORTED_FORMAT" ? "FORMAT_NOT_SUPPORTED" : code;
}

export class LibraryService {
  private readonly books: BookRepository;
  /**
   * Resolved cover URL per book, together with the source revision it was resolved
   * for.
   *
   * Listing the library called presentBook once per book, and each call issued two
   * synchronous SQLite lookups plus existsSync, so the answer is remembered. Two
   * details make that safe:
   *
   *  - The revision is part of the entry. The URL contains the revision, so an entry
   *    from a previous revision would point at a directory that no longer exists.
   *  - Only a *found* cover is remembered. A book that is still being prepared has no
   *    cover file yet, and remembering that "no" is how an EPUB imported in the app
   *    ended up without its cover until the next restart: the shelf was listed while
   *    preparation was queued, and the negative answer outlived the reason for it.
   */
  private readonly coverUrlsByBook = new Map<string, { sourceRevision: string; coverUrl: string }>();
  /**
   * The app loads the shelf and the collections together on startup, and the
   * collection service lists books for its previews. Each listBooks() call resolves
   * a cover per book, so coalescing concurrent callers removes a whole redundant
   * pass over the library.
   */
  private listBooksInFlight: Promise<BookSummary[]> | null = null;
  private cachedTxtDocument: {
    bookId: string;
    sourceRevision: string;
    quickFingerprint: string;
    fileSize: number;
    modifiedAt: string;
    document: Awaited<ReturnType<typeof openTxt>>;
  } | null = null;
  constructor(
    private readonly db: Database.Database,
    private readonly dataRoot?: string,
    private readonly createCoverThumbnail?: CoverThumbnailer,
  ) {
    this.books = new BookRepository(db);
  }

  private forgetCover(bookId: string) {
    this.coverUrlsByBook.delete(bookId);
    if (this.cachedTxtDocument?.bookId === bookId) {
      this.cachedTxtDocument = null;
    }
  }

  /** Cover URLs can change when thumbnails appear; drop every memoised value. */
  resetCoverCache() {
    this.coverUrlsByBook.clear();
    this.listBooksInFlight = null;
  }

  /** Any mutation that can add or change a book must drop the coalesced list. */
  private invalidateBookList() {
    this.listBooksInFlight = null;
  }

  async importTxt(path: string, targetBookId?: string): Promise<BookSummary> {
    if (extname(path).toLowerCase() !== ".txt") throw new ReaderError("FORMAT_NOT_SUPPORTED", "v0.1 仅支持 TXT 文件。");
    const quick = await quickFingerprint(path);
    if (!quick.isFile) throw new ReaderError("FILE_NOT_READABLE", "所选项目不是普通文件。");
    if (quick.fileSize > 20 * 1024 * 1024) throw new ReaderError("FILE_TOO_LARGE", "v0.1 暂不导入超过 20 MiB 的 TXT。");
    const hash = await fullContentHash(path);
    const afterHash = await quickFingerprint(path);
    if (afterHash.fingerprint !== quick.fingerprint || afterHash.modifiedAt !== quick.modifiedAt || afterHash.fileSize !== quick.fileSize) {
      throw new ReaderError("FILE_NOT_READABLE", "The source changed while it was being imported. Please try again.");
    }
    const targetSource = targetBookId ? this.books.getSourceForBook(targetBookId) : undefined;
    const targetBook = targetBookId ? this.books.getBook(targetBookId) : undefined;
    if (targetBookId && (!targetSource || targetBook?.format !== "txt")) {
      throw new ReaderError("BOOK_NOT_FOUND", "找不到要更新的 TXT 书目。");
    }
    const identical = this.books.findSourceByHash(hash, "txt");
    if (!targetBookId && identical) {
      this.db.prepare(`UPDATE book_sources SET source_path=?, quick_fingerprint=?, file_size=?, modified_at=?, availability_status='available', verified_at=? WHERE id=?`)
        .run(path, quick.fingerprint, quick.fileSize, quick.modifiedAt, new Date().toISOString(), identical.id);
      this.invalidateBookList();
      return this.presentBook(this.books.getBook(identical.bookId)!);
    }
    const existingPath = this.books.findSourceByPath(path);
    if (targetSource && existingPath && existingPath.bookId !== targetSource.bookId) {
      throw new ReaderError("INVALID_REQUEST", "该文件已经属于另一本书。");
    }
    const existing = targetSource ?? existingPath;
    const bookId = existing?.bookId ?? randomUUID();
    const sourceRevision = randomUUID();
    const document = await openTxt(path, sourceRevision);
    const afterRead = await quickFingerprint(path);
    if (afterRead.fingerprint !== quick.fingerprint || afterRead.modifiedAt !== quick.modifiedAt || afterRead.fileSize !== quick.fileSize) {
      throw new ReaderError("FILE_NOT_READABLE", "The source changed while it was being imported. Please try again.");
    }
    const now = new Date().toISOString();
    this.db.transaction(() => {
      if (existing) {
        this.db.prepare("UPDATE books SET title=?, author=?, updated_at=? WHERE id=?").run(document.title, document.author, now, bookId);
        this.db.prepare(`UPDATE book_sources SET source_path=?, quick_fingerprint_version=?, quick_fingerprint=?, full_content_hash_algorithm='sha256', full_content_hash=?, file_size=?, modified_at=?, source_revision=?, availability_status='available', verified_at=? WHERE id=?`)
          .run(path, quick.version, quick.fingerprint, hash, quick.fileSize, quick.modifiedAt, sourceRevision, now, existing.id);
      } else {
        this.db.prepare("INSERT INTO books(id,format,title,author,created_at,updated_at) VALUES (?,'txt',?,?,?,?)").run(bookId, document.title, document.author, now, now);
        this.db.prepare(`INSERT INTO book_sources(id,book_id,source_path,quick_fingerprint_version,quick_fingerprint,full_content_hash_algorithm,full_content_hash,file_size,modified_at,source_revision,availability_status,verified_at)
          VALUES (?,?,?,?,?,'sha256',?,?,?,?, 'available',?)`).run(randomUUID(), bookId, path, quick.version, quick.fingerprint, hash, quick.fileSize, quick.modifiedAt, sourceRevision, now);
      }
    })();
    this.cachedTxtDocument = {
      bookId,
      sourceRevision,
      quickFingerprint: quick.fingerprint,
      fileSize: quick.fileSize,
      modifiedAt: quick.modifiedAt,
      document,
    };
    this.invalidateBookList();
    return this.presentBook(this.books.getBook(bookId)!);
  }

  async listBooks() {
    if (!this.listBooksInFlight) {
      const pending = Promise.resolve()
        .then(() => this.books.list().map((book) => this.presentBook(book)))
        .finally(() => {
          if (this.listBooksInFlight === pending) this.listBooksInFlight = null;
        });
      this.listBooksInFlight = pending;
    }
    return this.listBooksInFlight;
  }

  async removeBooks(bookIds: string[], options: {
    deleteOriginal?: boolean;
    moveToTrash?: (path: string) => Promise<void>;
  } = {}) {
    const uniqueIds = [...new Set(bookIds)];
    if (!uniqueIds.length || uniqueIds.some((id) => !id || id.length > 128 || /[\\/:]/.test(id))) {
      throw new ReaderError("INVALID_REQUEST", "至少选择一本有效书目。");
    }
    const placeholders = uniqueIds.map(() => "?").join(",");
    const existing = this.db.prepare(`SELECT id,format FROM books WHERE id IN (${placeholders})`)
      .all(...uniqueIds) as Array<{ id: string; format: "txt" | "epub" }>;
    if (!existing.length) return { removed: 0 };

    let removed: typeof existing = existing;
    let failedToDelete = 0;
    if (options.deleteOriginal) {
      if (!options.moveToTrash) throw new ReaderError("INVALID_REQUEST", "系统回收站不可用。");
      removed = [];
      for (const book of existing) {
        const sources = this.db.prepare("SELECT source_path FROM book_sources WHERE book_id = ?")
          .all(book.id) as Array<{ source_path: string }>;
        // A book with multiple source files needs a separate review; never move
        // only one of them while claiming that all originals were deleted.
        if (sources.length !== 1) { failedToDelete += 1; continue; }
        const path = sources[0]!.source_path;
        try {
          const facts = await lstat(path);
          if (!facts.isFile() || facts.isSymbolicLink()
            || extname(path).toLowerCase() !== `.${book.format}`) {
            failedToDelete += 1;
            continue;
          }
          await options.moveToTrash(path);
        } catch {
          failedToDelete += 1;
          continue;
        }
        // The original is now recoverable from the OS recycle bin. Delete its
        // app record only after that succeeds, keeping failed books readable.
        try {
          this.db.prepare("DELETE FROM books WHERE id = ?").run(book.id);
        } catch {
          throw new ReaderError("DATABASE_ERROR", "原文件已进入系统回收站，但书目未能移出，请检查系统回收站。");
        }
        removed.push(book);
      }
    } else {
      this.db.transaction(() => {
        this.db.prepare(`DELETE FROM books WHERE id IN (${placeholders})`).run(...uniqueIds);
      })();
    }
    for (const book of removed) this.forgetCover(book.id);
    this.listBooksInFlight = null;

    if (this.dataRoot) {
      const cacheRoot = this.dataRoot;
      const cacheDirectories = removed
        .filter((book) => book.format === "epub")
        .map((book) => join(cacheRoot, "publications", book.id));
      // Prepared EPUBs can contain many files. Cache cleanup is independent of
      // removing the library record and must not hold the confirmation dialog.
      setImmediate(() => {
        void Promise.all(cacheDirectories.map((path) =>
          rm(path, { recursive: true, force: true }).catch(() => undefined)));
      });
    }
    return failedToDelete > 0
      ? { removed: removed.length, failedToDelete }
      : { removed: removed.length };
  }

  async importEpub(path: string, targetBookId?: string): Promise<BookSummary> {
    try {
      return await this.importEpubInternal(path, targetBookId);
    } finally {
      // admitEpub can add a book or flip a revision; never serve a stale list after.
      this.invalidateBookList();
    }
  }

  private async importEpubInternal(path: string, targetBookId?: string): Promise<BookSummary> {
    if (!this.dataRoot) {
      throw new ReaderError("DATABASE_ERROR", "EPUB cache root is unavailable.");
    }
    const admission = new LibraryAdmissionService(this.db);
    let book = await admission.admitEpub(path, targetBookId);
    let source = this.getSourceForBook(book.id);
    const jobs = new BookPreparationJobRepository(this.db);
    let job = jobs.get(book.id);

    if (
      job?.state === "ready"
      && await isRegularFile(this.getPreparedEpubPath(book.id, source.sourceRevision))
    ) {
      return this.presentBook(book);
    }
    if (job?.state === "ready") {
      book = await admission.admitEpub(path, book.id);
      source = this.getSourceForBook(book.id);
      job = jobs.get(book.id);
    } else if (job?.state === "error") {
      job = jobs.retry(book.id, source.sourceRevision, new Date().toISOString());
    }
    if (!job || job.sourceRevision !== source.sourceRevision) {
      throw new ReaderError("DATABASE_ERROR", "EPUB preparation job is unavailable.");
    }
    if (job.state === "queued" && !jobs.markPreparing(
      book.id,
      source.sourceRevision,
      new Date().toISOString(),
    )) {
      throw new ReaderError("DATABASE_ERROR", "EPUB preparation could not start.");
    }

    try {
      const result = await new EpubPreparationService(
        this.db,
        this.dataRoot,
        this.createCoverThumbnail ? { createCoverThumbnail: this.createCoverThumbnail } : {},
      ).prepare(book.id, source.sourceRevision);
      jobs.markReady(book.id, source.sourceRevision, new Date().toISOString());
      this.forgetCover(book.id);
      return this.presentBook(result.book);
    } catch (error) {
      const code = error instanceof ReaderError ? error.code : "INVALID_PACKAGE";
      jobs.markError(book.id, source.sourceRevision, code, new Date().toISOString());
      throw error;
    }
  }

  getPreparedEpubPath(bookId: string, sourceRevision: string): string | null {
    return this.getPreparedPublicationPath(bookId, sourceRevision, "book");
  }

  getPreparedPublicationPath(
    bookId: string,
    sourceRevision: string,
    resource: "book" | "cover" | "cover-thumb",
  ): string | null {
    if (!this.dataRoot) return null;
    const source = this.books.getSourceForBook(bookId);
    if (!source || source.sourceRevision !== sourceRevision) return null;
    const book = this.books.getBook(bookId);
    return book?.format === "epub" ? this.preparedResourcePath(bookId, sourceRevision, resource) : null;
  }

  async readPublication(bookId: string) {
    let source = this.getSourceForBook(bookId);
    const book = this.books.getBook(bookId);
    if (book?.format !== "epub") throw new ReaderError("FORMAT_NOT_SUPPORTED", "这不是 EPUB 书目。");
    const facts = await quickFingerprint(source.sourcePath).catch(() => null);
    if (!facts) throw new ReaderError("SOURCE_UNAVAILABLE", "EPUB 源文件不可用。");
    if (facts.fingerprint !== source.quickFingerprint || facts.fileSize !== source.fileSize || facts.modifiedAt !== source.modifiedAt) {
      await this.importEpub(source.sourcePath);
      source = this.getSourceForBook(bookId);
    }
    const cachePath = this.getPreparedEpubPath(bookId, source.sourceRevision);
    if (!cachePath) throw new ReaderError("SOURCE_UNAVAILABLE", "EPUB 安全缓存不可用。");
    const metadataPath = this.publicationMetadataPath(bookId, source.sourceRevision);
    const cached = await readFile(metadataPath, "utf8")
      .then((value) => PublicationViewSchema.safeParse(JSON.parse(value)))
      .catch(() => null);
    if (cached?.success) return cached.data;
    const adapter = new EpubBookFormatAdapter(async () => new Uint8Array(await readFile(cachePath)));
    const opened = await adapter.openSource({ bookId, sourceRevision: source.sourceRevision });
    await adapter.close();
    if (!opened.ok) throw new ReaderError(readerErrorCode(opened.code), opened.detail ?? opened.code);
    await this.writePublicationMetadata(opened.value);
    return opened.value;
  }

  getBook(bookId: string) {
    const book = this.books.getBook(bookId);
    if (!book) throw new ReaderError("BOOK_NOT_FOUND", "BOOK_NOT_FOUND");
    return this.presentBook(book);
  }

  updateBookMetadata(bookId: string, input: { title: string; author: string | null }): BookSummary {
    const existing = this.books.getBook(bookId);
    if (!existing) throw new ReaderError("BOOK_NOT_FOUND", "找不到要修改的书目。");
    const nextTitle = input.title.trim();
    if (!nextTitle) throw new ReaderError("INVALID_REQUEST", "书名不能为空。");
    const nextAuthor = input.author?.trim() ? input.author.trim() : null;
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare("UPDATE books SET title=?, author=?, updated_at=? WHERE id=?")
        .run(nextTitle, nextAuthor, now, bookId);
      try {
        this.db.prepare("UPDATE reading_records SET book_title=?, author=? WHERE book_id=?")
          .run(nextTitle, nextAuthor, bookId);
      } catch {
        // reading_records table is optional in older test schemas
      }
    })();
    if (this.cachedTxtDocument?.bookId === bookId) {
      this.cachedTxtDocument = null;
    }
    this.invalidateBookList();
    return this.getBook(bookId);
  }

  setReadingState(bookId: string, state: "unread" | "finished"): BookSummary {
    const existing = this.books.getBook(bookId);
    if (!existing) throw new ReaderError("BOOK_NOT_FOUND", "找不到要更新进度的书目。");
    const source = this.books.getSourceForBook(bookId);
    if (!source) throw new ReaderError("BOOK_NOT_FOUND", "找不到该书目的源文件记录。");
    const now = new Date().toISOString();
    if (state === "unread") {
      this.db.prepare("DELETE FROM reading_progress WHERE book_id=?").run(bookId);
    } else {
      const currentRow = this.db.prepare("SELECT locator_json FROM reading_progress WHERE book_id=?").get(bookId) as { locator_json: string } | undefined;
      let locationObj: Record<string, unknown> | null = null;
      if (currentRow?.locator_json) {
        try {
          const parsed = JSON.parse(currentRow.locator_json) as Record<string, unknown>;
          if (parsed && typeof parsed === "object" && parsed.format === existing.format) {
            locationObj = {
              ...parsed,
              sourceRevision: source.sourceRevision,
              progression: { resource: 1, total: 1 },
            };
          }
        } catch {
          locationObj = null;
        }
      }
      if (!locationObj) {
        locationObj = existing.format === "txt"
          ? {
              locatorVersion: 1,
              sourceRevision: source.sourceRevision,
              format: "txt",
              primary: {
                kind: "txt",
                chapterId: "finished",
                characterOffset: 0,
              },
              progression: { resource: 1, total: 1 },
              text: { exact: "", prefix: "", suffix: "" },
            }
          : {
              locatorVersion: 1,
              sourceRevision: source.sourceRevision,
              format: "epub",
              primary: {
                kind: "epub",
                spineIndex: 0,
                spineHref: "end.xhtml",
                engineLocator: {
                  kind: "epub-cfi",
                  value: "epubcfi(/6/2!/4/1:0)",
                },
              },
              progression: { resource: 1, total: 1 },
              text: { exact: "", prefix: "", suffix: "" },
            };
      }
      this.db.prepare(`INSERT INTO reading_progress(book_id,locator_version,locator_json,source_revision,updated_at)
        VALUES (?,1,?,?,?) ON CONFLICT(book_id) DO UPDATE SET locator_version=1,locator_json=excluded.locator_json,source_revision=excluded.source_revision,updated_at=excluded.updated_at`)
        .run(bookId, JSON.stringify(locationObj), source.sourceRevision, now);
    }
    this.invalidateBookList();
    return this.getBook(bookId);
  }

  private publicationMetadataPath(bookId: string, sourceRevision: string) {
    return join(this.dataRoot!, "publications", bookId, sourceRevision, "publication.json");
  }

  private async writePublicationMetadata(publication: PublicationView) {
    const parsed = PublicationViewSchema.parse(publication);
    const path = this.publicationMetadataPath(parsed.bookId, parsed.sourceRevision);
    const partial = `${path}.partial-${randomUUID()}`;
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(partial, JSON.stringify(parsed), "utf8");
      await rename(partial, path);
    } finally {
      await rm(partial, { force: true }).catch(() => undefined);
    }
  }

  private preparedPath(bookId: string, sourceRevision: string) {
    return this.preparedResourcePath(bookId, sourceRevision, "book");
  }

  private preparedResourcePath(
    bookId: string,
    sourceRevision: string,
    resource: "book" | "cover" | "cover-thumb",
  ) {
    const fileName = resource === "book"
      ? "book.epub"
      : resource === "cover"
        ? "cover"
        : COVER_THUMBNAIL_FILE;
    return join(this.dataRoot!, "publications", bookId, sourceRevision, fileName);
  }

  private presentBook(book: BookSummary): BookSummary {
    if (book.format !== "epub") return book;
    const source = this.books.getSourceForBook(book.id);
    if (!source) return book;

    const cached = this.coverUrlsByBook.get(book.id);
    if (cached && cached.sourceRevision === source.sourceRevision) {
      return { ...book, coverUrl: cached.coverUrl };
    }

    // A published revision directory is written to a staging directory and moved
    // into place with a single rename, so these files are all-or-nothing.
    const coverUrl = this.resolveCoverUrl(book.id, source.sourceRevision);
    if (coverUrl) {
      this.coverUrlsByBook.set(book.id, { sourceRevision: source.sourceRevision, coverUrl });
      return { ...book, coverUrl };
    }
    // Not found: deliberately not remembered. Preparation may still be running, and a
    // cached miss would survive it.
    this.coverUrlsByBook.delete(book.id);
    return book;
  }

  private resolveCoverUrl(bookId: string, sourceRevision: string) {
    // Prefer the downscaled thumbnail; fall back to the original cover when
    // thumbnailing was unavailable for this revision.
    for (const resource of ["cover-thumb", "cover"] as const) {
      const candidate = this.getPreparedPublicationPath(bookId, sourceRevision, resource);
      if (!candidate || !existsSync(candidate)) continue;
      const fileName = resource === "cover-thumb" ? COVER_THUMBNAIL_FILE : "cover";
      const url = `reader-resource://publication/${bookId}/${sourceRevision}/${fileName}`;
      // Validate here rather than at the IPC boundary: a URL the shared contract
      // rejects would fail the entire book list, which the UI can only show as a
      // blank window. Failing on the single book keeps the rest of the shelf usable.
      const parsed = ControlledCoverUrlSchema.safeParse(url);
      if (parsed.success) return parsed.data;
      return null;
    }
    return null;
  }

  getSourceForBook(bookId: string) {
    const source = this.books.getSourceForBook(bookId);
    if (!source) throw new ReaderError("BOOK_NOT_FOUND", "找不到这本书。");
    return source;
  }

  async isSourceCurrent(bookId: string, sourceRevision: string) {
    const source = this.books.getSourceForBook(bookId);
    if (!source || source.sourceRevision !== sourceRevision) return false;
    const facts = await quickFingerprint(source.sourcePath).catch(() => null);
    return Boolean(
      facts
      && facts.isFile
      && facts.fileSize === source.fileSize
      && facts.modifiedAt === source.modifiedAt
      && facts.fingerprint === source.quickFingerprint,
    );
  }

  listManagedSources() {
    return this.books.listSources();
  }

  async replaceSource(bookId: string, path: string) {
    const book = this.books.getBook(bookId);
    if (!book) throw new ReaderError("BOOK_NOT_FOUND", "找不到要更新的书目。");
    return book.format === "txt"
      ? this.importTxt(path, bookId)
      : this.importEpub(path, bookId);
  }

  async readDocument(bookId: string) {
    let source = this.getSourceForBook(bookId);
    try {
      const facts = await quickFingerprint(source.sourcePath);
      if (facts.fingerprint !== source.quickFingerprint || facts.fileSize !== source.fileSize || facts.modifiedAt !== source.modifiedAt) {
        await this.importTxt(source.sourcePath);
        source = this.getSourceForBook(bookId);
      }
      const cached = this.cachedTxtDocument;
      if (
        cached
        && cached.bookId === bookId
        && cached.sourceRevision === source.sourceRevision
        && cached.quickFingerprint === source.quickFingerprint
        && cached.fileSize === source.fileSize
        && cached.modifiedAt === source.modifiedAt
      ) {
        return cached.document;
      }
      const document = await openTxt(source.sourcePath, source.sourceRevision);
      this.cachedTxtDocument = {
        bookId,
        sourceRevision: source.sourceRevision,
        quickFingerprint: source.quickFingerprint,
        fileSize: source.fileSize,
        modifiedAt: source.modifiedAt,
        document,
      };
      return document;
    }
    catch (error) {
      if (error instanceof ReaderError) throw error;
      this.db.prepare("UPDATE book_sources SET availability_status='unavailable' WHERE id=?").run(source.id);
      throw new ReaderError("SOURCE_UNAVAILABLE", "源文件不可用，请重新定位。");
    }
  }

  async getChapter(bookId: string, chapterId: string): Promise<ChapterContent> {
    const source = this.getSourceForBook(bookId);
    const document = await this.readDocument(bookId);
    const chapter = document.chapters.find((item) => item.id === chapterId);
    if (!chapter) throw new ReaderError("BOOK_NOT_FOUND", "找不到指定章节。");
    return { bookId, sourceRevision: source.sourceRevision, chapter, text: document.text.slice(chapter.startOffset, chapter.endOffset), totalCharacters: document.text.length };
  }
}
