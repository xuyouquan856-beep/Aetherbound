import Database from "better-sqlite3";
import { ReaderError } from "../../shared/errors.js";

export interface TextUnit {
  unitIndex: number;
  content: string;
  charCount: number;
}

export interface IndexState {
  bookId: string;
  sourceRevision: string;
  state: "pending" | "indexing" | "ready" | "error";
  indexedUnits: number;
  totalUnits: number;
  errorCode: string | null;
  updatedAt: string;
}

export type TextExtractor = (bookId: string) => AsyncIterable<TextUnit>;

export interface FulltextResult {
  bookId: string;
  title: string;
  matchSnippet: string;
  unitIndex: number;
}

export type IndexableBook = { id: string; format: "txt" | "epub" };

export class TextIndexer {
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private readonly activeBooks = new Set<string>();
  private readonly idleWaiters = new Set<() => void>();
  private pumpScheduled = false;

  constructor(
    private readonly db: Database.Database,
    private readonly extractor: TextExtractor,
    private readonly maxConcurrency: number = 2
  ) {}

  enqueue(bookId: string): void {
    const sourceRevision = this.getSourceRevision(bookId);
    const current = this.getIndexState(bookId);
    if (
      current?.sourceRevision === sourceRevision
      && current.state === "ready"
    ) {
      return;
    }
    if (this.queued.has(bookId) || this.activeBooks.has(bookId)) return;

    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO book_index_state(
        book_id,source_revision,state,indexed_units,total_units,error_code,updated_at
      ) VALUES (?,?,'pending',0,0,NULL,?)
      ON CONFLICT(book_id) DO UPDATE SET
        source_revision=excluded.source_revision,
        state='pending',
        indexed_units=0,
        total_units=0,
        error_code=NULL,
        updated_at=excluded.updated_at
    `).run(bookId, sourceRevision, now);
    this.queue.push(bookId);
    this.queued.add(bookId);
    this.schedulePump();
  }

  /**
   * EPUB books are enqueued when their preparation completes, because only then does
   * a sanitized revision exist to read. A TXT source is readable as soon as it is
   * imported, so those are found here instead — this is the only path that indexes
   * TXT, and it is what makes full-text search work for the app's primary format.
   *
   * The query is state-driven, so it enqueues each TXT book exactly once and skips
   * everything already indexed at the current revision.
   */
  recoverPending(): void {
    const rows = this.db.prepare(`
      SELECT b.id
      FROM books b
      JOIN book_sources s ON s.book_id = b.id
      LEFT JOIN book_preparation_jobs p
        ON p.book_id = b.id
       AND p.source_revision = s.source_revision
      LEFT JOIN book_index_state i ON i.book_id = b.id
      WHERE s.availability_status = 'available'
        AND (
          (b.format = 'epub' AND p.state = 'ready')
          OR b.format = 'txt'
        )
        AND (
          i.book_id IS NULL
          OR i.source_revision <> s.source_revision
          OR i.state IN ('pending','indexing')
        )
      ORDER BY b.created_at ASC, b.id ASC
    `).all() as Array<{ id: string }>;
    for (const row of rows) this.enqueue(row.id);
  }

  waitForIdle(): Promise<void> {
    if (this.queue.length === 0 && this.activeBooks.size === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.idleWaiters.add(resolve);
    });
  }

  async indexBook(bookId: string): Promise<void> {
    const now = new Date().toISOString();

    // Check if already indexed with same sourceRevision
    const sourceRev = this.getSourceRevision(bookId);
    const current = this.getIndexState(bookId);
    if (current && current.sourceRevision === sourceRev && current.state === "ready") {
      return; // already indexed, skip
    }

    // Mark as indexing
    this.db.prepare(
      "INSERT INTO book_index_state(book_id, source_revision, state, indexed_units, total_units, updated_at) VALUES (?,?,'indexing',0,0,?) ON CONFLICT(book_id) DO UPDATE SET source_revision=?, state='indexing', indexed_units=0, total_units=0, updated_at=?"
    ).run(bookId, sourceRev, now, sourceRev, now);

    // Clear previous index
    this.removeBookIndex(bookId);

    try {
      const insertUnit = this.db.prepare(
        "INSERT INTO book_text_units(book_id, unit_index, content, char_count) VALUES (?,?,?,?)"
      );
      const insertFts = this.db.prepare(
        "INSERT INTO book_content_fts(book_id, unit_index, content) VALUES (?,?,?)"
      );
      const insertFtsRow = this.db.prepare(
        "INSERT INTO book_content_fts_rows(fts_rowid, book_id) VALUES (?,?)"
      );
      const commitBatch = this.db.transaction((batch: TextUnit[]) => {
        for (const unit of batch) {
          insertUnit.run(bookId, unit.unitIndex, unit.content, unit.charCount);
          const inserted = insertFts.run(bookId, unit.unitIndex, unit.content);
          insertFtsRow.run(inserted.lastInsertRowid, bookId);
        }
      });

      // Batch rather than buffering the whole book: a large novel would otherwise
      // sit in the heap in full before the first row is written.
      let batch: TextUnit[] = [];
      let indexed = 0;
      for await (const unit of this.extractor(bookId)) {
        batch.push(unit);
        if (batch.length >= TextIndexer.BatchSize) {
          commitBatch(batch);
          indexed += batch.length;
          batch = [];
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
      if (batch.length > 0) {
        commitBatch(batch);
        indexed += batch.length;
      }

      this.db.prepare(
        "UPDATE book_index_state SET state='ready', indexed_units=?, total_units=?, updated_at=? WHERE book_id=?"
      ).run(indexed, indexed, new Date().toISOString(), bookId);
    } catch (e: any) {
      this.db.prepare(
        "UPDATE book_index_state SET state='error', error_code=?, updated_at=? WHERE book_id=?"
      ).run(e?.code ?? "INDEX_FAILED", new Date().toISOString(), bookId);
      throw e;
    }
  }

  removeBook(bookId: string): void {
    this.removeBookIndex(bookId);
    this.db.prepare("DELETE FROM book_index_state WHERE book_id = ?").run(bookId);
  }

  search(
    query: string,
    limit = 20,
    offset = 0,
  ): Array<{ bookId: string; title: string; matchSnippet: string; unitIndex: number }> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const safeLimit = clamp(limit, 1, 100, 20);
    const safeOffset = clamp(offset, 0, Number.MAX_SAFE_INTEGER, 0);

    // The FTS index uses the trigram tokenizer, which cannot match fewer than
    // three characters. Two-character CJK words are extremely common, so fall back
    // to an indexed LIKE scan rather than returning nothing.
    if (shortestTermLength(trimmed) < 3) {
      return this.searchBySubstring(trimmed, safeLimit, safeOffset);
    }

    const ftsQuery = fts5Escape(trimmed);
    if (!ftsQuery) return [];
    // Joining book_index_state restricts results to fully indexed books, so a
    // book that is mid-reindex never surfaces partial matches.
    return (this.db.prepare(
      "SELECT f.book_id, b.title, snippet(book_content_fts, 2, '', '', '…', 32) as snip, f.unit_index " +
      "FROM book_content_fts f JOIN books b ON b.id = f.book_id " +
      "JOIN book_index_state i ON i.book_id = f.book_id AND i.state = 'ready' " +
      "WHERE book_content_fts MATCH ? ORDER BY rank LIMIT ? OFFSET ?"
    ).all(ftsQuery, safeLimit, safeOffset) as Array<{ book_id: string; title: string; snip: string; unit_index: number }>)
      .map((row) => ({
        bookId: row.book_id,
        title: row.title,
        matchSnippet: row.snip,
        unitIndex: row.unit_index,
      }));
  }

  private searchBySubstring(
    query: string,
    limit: number,
    offset: number,
  ): Array<{ bookId: string; title: string; matchSnippet: string; unitIndex: number }> {
    const pattern = `%${escapeLikePattern(query)}%`;
    const rows = this.db.prepare(
      `SELECT u.book_id, b.title, u.content, u.unit_index
       FROM book_text_units u
       JOIN books b ON b.id = u.book_id
       JOIN book_index_state i ON i.book_id = u.book_id AND i.state = 'ready'
       WHERE u.content LIKE ? ESCAPE '\\'
       ORDER BY b.updated_at DESC, u.unit_index
       LIMIT ? OFFSET ?`,
    ).all(pattern, limit, offset) as Array<{
      book_id: string;
      title: string;
      content: string;
      unit_index: number;
    }>;
    return rows.map((row) => ({
      bookId: row.book_id,
      title: row.title,
      matchSnippet: snippetAround(row.content, query),
      unitIndex: row.unit_index,
    }));
  }

  async reindexAll(): Promise<void> {
    const books = this.db.prepare("SELECT id FROM books").all() as { id: string }[];

    // Sequential with concurrency — simple: process in batches of maxConcurrency
    for (let i = 0; i < books.length; i += this.maxConcurrency) {
      const batch = books.slice(i, i + this.maxConcurrency);
      await Promise.allSettled(batch.map((b) => this.indexBook(b.id).catch(() => {})));
    }
  }

  getIndexState(bookId: string): IndexState | null {
    const row = this.db.prepare("SELECT * FROM book_index_state WHERE book_id = ?").get(bookId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      bookId: row.book_id as string,
      sourceRevision: row.source_revision as string,
      state: row.state as IndexState["state"],
      indexedUnits: row.indexed_units as number,
      totalUnits: row.total_units as number,
      errorCode: row.error_code as string | null,
      updatedAt: row.updated_at as string,
    };
  }

  private removeBookIndex(bookId: string): void {
    this.db.prepare("DELETE FROM book_text_units WHERE book_id = ?").run(bookId);
    this.db.prepare("DELETE FROM book_content_fts WHERE rowid IN (SELECT fts_rowid FROM book_content_fts_rows WHERE book_id = ?)").run(bookId);
    this.db.prepare("DELETE FROM book_content_fts_rows WHERE book_id = ?").run(bookId);
  }

  /**
   * Indexing shares the main process with EPUB preparation, library queries and
   * every IPC handler, so a library-wide sweep must not occupy the event loop
   * continuously. Each batch commits in its own transaction and then yields, which
   * bounds both peak memory and how long the loop is held.
   */
  private static readonly BatchSize = 200;

  private schedulePump() {
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    setImmediate(() => {
      this.pumpScheduled = false;
      this.pump();
    });
  }

  private pump() {
    while (
      this.activeBooks.size < this.maxConcurrency
      && this.queue.length > 0
    ) {
      const bookId = this.queue.shift()!;
      this.queued.delete(bookId);
      this.activeBooks.add(bookId);
      void this.indexBook(bookId)
        .catch(() => undefined)
        .finally(() => {
          this.activeBooks.delete(bookId);
          // Yield before starting the next book: a tight loop here would starve
          // IPC and keep a large TXT sweep on the critical path for minutes.
          setImmediate(() => {
            this.pump();
            this.resolveIdle();
          });
        });
    }
    this.resolveIdle();
  }

  private resolveIdle() {
    if (this.queue.length !== 0 || this.activeBooks.size !== 0) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  private getSourceRevision(bookId: string): string {
    const row = this.db.prepare(
      "SELECT source_revision FROM book_sources WHERE book_id = ? LIMIT 1"
    ).get(bookId) as { source_revision: string } | undefined;
    return row?.source_revision ?? "unknown";
  }
}

/** Escape user input for FTS5: wrap each token in double quotes, escape quotes inside */
function fts5Escape(input: string): string {
  return input
    .replace(/"/g, '""')
    .split(/\s+/)
    .filter(Boolean)
    .map(token => `"${token}"`)
    .join(" ") || '""';
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

/**
 * Length of the shortest whitespace-separated term, in code points. The trigram
 * tokenizer needs every term to be at least three characters.
 */
function shortestTermLength(query: string): number {
  const terms = query.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return 0;
  return Math.min(...terms.map((term) => [...term].length));
}

/** `%` and `_` are wildcards in LIKE; escape them plus the escape character. */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/** Build a short excerpt around the match for display in the result list. */
function snippetAround(content: string, query: string, radius = 32): string {
  const index = content.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return content.slice(0, radius * 2);
  const start = Math.max(0, index - radius);
  const end = Math.min(content.length, index + query.length + radius);
  return `${start > 0 ? "…" : ""}${content.slice(start, end)}${end < content.length ? "…" : ""}`;
}
