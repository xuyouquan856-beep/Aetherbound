import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BookPreparationCoordinator } from "../../src/backend/library/book-preparation-coordinator.js";
import { BookPreparationJobRepository } from "../../src/backend/library/book-preparation-job-repository.js";
import { openDatabase, type OpenedDatabase } from "../../src/backend/storage/database.js";
import { ReaderError } from "../../src/shared/errors.js";

let dataRoot = "";
let opened: OpenedDatabase | null = null;
let jobs: BookPreparationJobRepository;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "reader-preparation-coordinator-"));
  opened = openDatabase(dataRoot);
  jobs = new BookPreparationJobRepository(opened.db);
});

afterEach(async () => {
  opened?.close();
  opened = null;
  await rm(dataRoot, { recursive: true, force: true });
});

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

async function eventually(assertion: () => void, timeoutMs = 2_000) {
  const started = Date.now();
  while (true) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() - started >= timeoutMs) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

function enqueue(bookId: string, revision: string, createdAt: string) {
  opened!.db.prepare(
    "INSERT INTO books(id,format,title,author,created_at,updated_at) VALUES (?,'epub',?,NULL,?,?)",
  ).run(bookId, bookId, createdAt, createdAt);
  jobs.enqueue(bookId, revision, createdAt);
}

describe("BookPreparationCoordinator", () => {
  it("wakes when a job is queued after its initial empty pass", async () => {
    const prepare = vi.fn(async () => ({} as never));
    const coordinator = new BookPreparationCoordinator(jobs, { prepare });

    coordinator.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    enqueue("book-later", "revision-later", "2026-07-29T00:00:01.000Z");
    (coordinator as unknown as { notifyQueued?(): void }).notifyQueued?.();

    await eventually(
      () => expect(jobs.get("book-later")?.state).toBe("ready"),
      100,
    );
    await coordinator.stop();
    expect(prepare).toHaveBeenCalledWith("book-later", "revision-later");
  });

  it("runs one preparation at a time and promotes one single-flight interactive book", async () => {
    enqueue("book-active", "revision-active", "2026-07-29T00:00:01.000Z");
    enqueue("book-old", "revision-old", "2026-07-29T00:00:02.000Z");
    enqueue("book-clicked", "revision-clicked", "2026-07-29T00:00:03.000Z");
    const gates = new Map([
      ["book-active", deferred()],
      ["book-clicked", deferred()],
    ]);
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const prepare = vi.fn(async (bookId: string) => {
      order.push(bookId);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await gates.get(bookId)?.promise;
      active -= 1;
      return {} as never;
    });
    const coordinator = new BookPreparationCoordinator(jobs, { prepare });

    coordinator.start();
    await eventually(() => expect(order).toEqual(["book-active"]));
    const opens = [
      coordinator.ensureReady("book-clicked"),
      coordinator.ensureReady("book-clicked"),
      coordinator.ensureReady("book-clicked"),
    ];
    gates.get("book-active")!.resolve();
    await eventually(() => expect(order.slice(0, 2)).toEqual([
      "book-active",
      "book-clicked",
    ]));
    gates.get("book-clicked")!.resolve();
    await Promise.all(opens);
    await eventually(() => expect(jobs.get("book-old")?.state).toBe("ready"));
    await coordinator.stop();

    expect(prepare.mock.calls.filter(([bookId]) => bookId === "book-clicked"))
      .toHaveLength(1);
    expect(maxActive).toBe(1);
  });

  it("emits only sanitized terminal events for success and failure", async () => {
    enqueue("book-good", "revision-good", "2026-07-29T00:00:01.000Z");
    enqueue("book-bad", "revision-bad", "2026-07-29T00:00:02.000Z");
    const prepare = vi.fn(async (bookId: string) => {
      if (bookId === "book-bad") {
        throw new ReaderError(
          "INVALID_PACKAGE",
          "E:\\private\\secret.epub is damaged",
        );
      }
      return {} as never;
    });
    const coordinator = new BookPreparationCoordinator(jobs, { prepare });
    const events: unknown[] = [];
    coordinator.subscribe((event) => events.push(event));

    coordinator.start();
    await eventually(() => expect(jobs.get("book-bad")?.state).toBe("error"));
    await coordinator.stop();

    expect(events).toEqual([
      {
        bookId: "book-good",
        sourceRevision: "revision-good",
        state: "ready",
        errorCode: null,
      },
      {
        bookId: "book-bad",
        sourceRevision: "revision-bad",
        state: "error",
        errorCode: "INVALID_PACKAGE",
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("private");
    expect(JSON.stringify(events)).not.toContain("secret.epub");
  });

  it("recovers interrupted jobs on startup without resetting attempts", async () => {
    enqueue("book-recover", "revision-recover", "2026-07-29T00:00:01.000Z");
    jobs.markPreparing(
      "book-recover",
      "revision-recover",
      "2026-07-29T00:00:02.000Z",
    );
    const prepare = vi.fn(async () => ({} as never));
    const coordinator = new BookPreparationCoordinator(jobs, { prepare });

    coordinator.start();
    await eventually(() => expect(jobs.get("book-recover")?.state).toBe("ready"));
    await coordinator.stop();

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(jobs.get("book-recover")?.attemptCount).toBe(2);
  });

  it("does not let an obsolete execution commit over a replacement revision", async () => {
    enqueue("book-replaced", "revision-old", "2026-07-29T00:00:01.000Z");
    const oldGate = deferred();
    const calls: string[] = [];
    const prepare = vi.fn(async (_bookId: string, revision: string) => {
      calls.push(revision);
      if (revision === "revision-old") await oldGate.promise;
      return {} as never;
    });
    const coordinator = new BookPreparationCoordinator(jobs, { prepare });

    coordinator.start();
    await eventually(() => expect(calls).toEqual(["revision-old"]));
    jobs.enqueue("book-replaced", "revision-new", "2026-07-29T00:00:03.000Z");
    oldGate.resolve();
    await eventually(() => expect(jobs.get("book-replaced")?.state).toBe("ready"));
    await coordinator.stop();

    expect(calls).toEqual(["revision-old", "revision-new"]);
    expect(jobs.get("book-replaced")?.sourceRevision).toBe("revision-new");
  });

  it("stop waits for the active operation and never starts the next queued job", async () => {
    enqueue("book-active", "revision-active", "2026-07-29T00:00:01.000Z");
    enqueue("book-pending", "revision-pending", "2026-07-29T00:00:02.000Z");
    const gate = deferred();
    const prepare = vi.fn(async (bookId: string) => {
      if (bookId === "book-active") await gate.promise;
      return {} as never;
    });
    const coordinator = new BookPreparationCoordinator(jobs, { prepare });

    coordinator.start();
    await eventually(() => expect(prepare).toHaveBeenCalledTimes(1));
    let stopped = false;
    const stopping = coordinator.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stopped).toBe(false);
    gate.resolve();
    await stopping;

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(jobs.get("book-pending")?.state).toBe("queued");
  });
});
