import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/backend/storage/database.js";
import { ReadingSessionService } from "../../src/backend/sessions/reading-session-service.js";
import type { TxtReadingLocationV1 } from "../../src/shared/contracts.js";

const location: TxtReadingLocationV1 = {
  locatorVersion: 1,
  sourceRevision: "revision-1",
  format: "txt",
  primary: { kind: "txt", chapterId: "chapter-1", characterOffset: 0 },
  progression: { resource: 0, total: 0 },
  text: { exact: "text", prefix: "", suffix: "" },
};

describe("reading session authorization", () => {
  it("rejects a session used for another book without writing progress", () => {
    const db = new Database(":memory:");
    migrate(db);
    const now = new Date().toISOString();
    db.prepare("INSERT INTO books VALUES ('book-1','txt','One',NULL,?,?)").run(now, now);
    db.prepare("INSERT INTO books VALUES ('book-2','txt','Two',NULL,?,?)").run(now, now);
    const service = new ReadingSessionService(db);
    const sessionId = service.openSession("book-1", "revision-1", null);

    expect(() => service.heartbeat(sessionId, "book-2", location)).toThrow(/SESSION_INVALID/);
    expect(db.prepare("SELECT COUNT(*) AS count FROM reading_progress").get()).toEqual({ count: 0 });
    db.close();
  });
});
