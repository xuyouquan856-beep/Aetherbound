import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { ReadingLocationSchema, type ReadingLocationV1 } from "../../shared/contracts.js";
import { ReaderError } from "../../shared/errors.js";
import { ProgressRepository } from "../storage/progress-repository.js";

export class ReadingSessionService {
  private readonly progress: ProgressRepository;
  constructor(private readonly db: Database.Database, private readonly now: () => Date = () => new Date()) {
    this.progress = new ProgressRepository(db);
  }

  openSession(bookId: string, sourceRevision: string, start: ReadingLocationV1 | null) {
    const id = randomUUID();
    const time = this.now().toISOString();
    const json = start ? JSON.stringify(start) : null;
    this.db.prepare(`INSERT INTO reading_sessions(id,book_id,source_revision,state,started_at,last_heartbeat_at,start_locator_json,last_locator_json)
      VALUES (?,?,?,'open',?,?,?,?)`).run(id, bookId, sourceRevision, time, time, json, json);
    return id;
  }

  heartbeat(sessionId: string, bookId: string, location: ReadingLocationV1) {
    const valid = ReadingLocationSchema.parse(location);
    this.requireOpenSession(sessionId, bookId, valid.sourceRevision);
    const time = this.now().toISOString();
    this.db.transaction(() => {
      const update = this.db.prepare("UPDATE reading_sessions SET last_heartbeat_at=?,last_locator_json=? WHERE id=? AND book_id=? AND source_revision=? AND state='open'")
        .run(time, JSON.stringify(valid), sessionId, bookId, valid.sourceRevision);
      if (update.changes !== 1) throw new ReaderError("SESSION_INVALID", "SESSION_INVALID");
      this.progress.save(bookId, valid, time);
    })();
  }

  closeSession(sessionId: string, bookId: string, location: ReadingLocationV1 | null) {
    const valid = location ? ReadingLocationSchema.parse(location) : null;
    const session = this.requireOpenSession(sessionId, bookId, valid?.sourceRevision);
    const time = this.now().toISOString();
    this.db.transaction(() => {
      if (valid) this.progress.save(bookId, valid, time);
      const update = this.db.prepare("UPDATE reading_sessions SET state='closed',ended_at=?,last_heartbeat_at=?,end_locator_json=? WHERE id=? AND book_id=? AND source_revision=? AND state='open'")
        .run(time, time, valid ? JSON.stringify(valid) : null, sessionId, bookId, session.source_revision);
      if (update.changes !== 1) throw new ReaderError("SESSION_INVALID", "SESSION_INVALID");
    })();
  }

  private requireOpenSession(sessionId: string, bookId: string, sourceRevision?: string) {
    const row = this.db.prepare("SELECT book_id,source_revision,state FROM reading_sessions WHERE id=?").get(sessionId) as
      { book_id: string; source_revision: string; state: string } | undefined;
    if (!row || row.state !== "open" || row.book_id !== bookId || (sourceRevision && row.source_revision !== sourceRevision)) {
      throw new ReaderError("SESSION_INVALID", "SESSION_INVALID");
    }
    return row;
  }

  recoverStaleSessions(timeoutMs: number) {
    const cutoff = new Date(this.now().getTime() - timeoutMs).toISOString();
    const rows = this.db.prepare("SELECT id,last_locator_json FROM reading_sessions WHERE state='open' AND last_heartbeat_at < ?").all(cutoff) as { id: string; last_locator_json: string | null }[];
    this.db.transaction(() => {
      for (const row of rows) this.db.prepare("UPDATE reading_sessions SET state='recovered' WHERE id=?").run(row.id);
    })();
    return rows.map((row) => ({ id: row.id, lastLocation: row.last_locator_json ? ReadingLocationSchema.parse(JSON.parse(row.last_locator_json)) : null }));
  }
}
