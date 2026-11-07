import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/backend/storage/database.js";
import { ReadingSessionService } from "../../src/backend/sessions/reading-session-service.js";
import type { TxtReadingLocationV1 } from "../../src/shared/contracts.js";

const location: TxtReadingLocationV1 = {
  locatorVersion: 1, sourceRevision: "r1", format: "txt",
  primary: { kind: "txt", chapterId: "c1", characterOffset: 2 },
  progression: { resource: 0.2, total: 0.1 },
  text: { exact: "文本", prefix: "", suffix: "" },
};

function fixture(now: { value: number }) {
  const db = new Database(":memory:");
  migrate(db);
  db.prepare("INSERT INTO books VALUES ('b1','txt','Book',NULL,?,?)").run(new Date(now.value).toISOString(), new Date(now.value).toISOString());
  return { db, service: new ReadingSessionService(db, () => new Date(now.value)) };
}

describe("reading sessions", () => {
  it("persists heartbeat progress and closes transactionally", () => {
    const now = { value: Date.parse("2026-07-21T00:00:00Z") };
    const { db, service } = fixture(now);
    const id = service.openSession("b1", "r1", null);
    now.value += 5_000;
    service.heartbeat(id, "b1", location);
    service.closeSession(id, "b1", location);
    expect(db.prepare("SELECT state FROM reading_sessions WHERE id=?").get(id)).toEqual({ state: "closed" });
    expect(db.prepare("SELECT locator_version FROM reading_progress WHERE book_id='b1'").get()).toEqual({ locator_version: 1 });
    db.close();
  });

  it("marks stale open sessions recovered without losing their locator", () => {
    const now = { value: Date.parse("2026-07-21T00:00:00Z") };
    const { db, service } = fixture(now);
    const id = service.openSession("b1", "r1", location);
    now.value += 120_000;
    expect(service.recoverStaleSessions(60_000)).toEqual([expect.objectContaining({ id, lastLocation: location })]);
    expect(db.prepare("SELECT state FROM reading_sessions WHERE id=?").get(id)).toEqual({ state: "recovered" });
    db.close();
  });
});
