import { describe, expect, it } from "vitest";
import {
  installReaderOpenTraceDebugTarget,
  ReaderOpenTraceStore,
  type ReaderOpenPhase,
} from "../../src/renderer/src/features/reader/reader-open-trace.js";

describe("ReaderOpenTraceStore", () => {
  it("records monotonic phases without accepting an unknown phase", () => {
    let now = 10;
    const store = new ReaderOpenTraceStore({
      now: () => now,
      createId: () => "trace-1",
    });
    const id = store.start("book-1");
    now = 20;
    store.mark(id, "details-ready");
    now = 35;
    store.mark(id, "interactive");

    expect(store.completed()).toEqual([{
      id: "trace-1",
      bookId: "book-1",
      startedAt: 10,
      marks: {
        selected: 10,
        "details-ready": 20,
        interactive: 35,
      },
    }]);
    expect(() => store.mark(id, "unknown" as ReaderOpenPhase))
      .toThrow("INVALID_READER_OPEN_PHASE");
  });

  it("retains only the newest twenty completed traces", () => {
    let sequence = 0;
    const store = new ReaderOpenTraceStore({
      now: () => sequence,
      createId: () => `trace-${sequence}`,
    });

    for (sequence = 0; sequence < 25; sequence += 1) {
      const id = store.start(`book-${sequence}`);
      store.mark(id, "interactive");
    }

    expect(store.completed()).toHaveLength(20);
    expect(store.completed()[0]?.id).toBe("trace-5");
    expect(store.completed()[19]?.id).toBe("trace-24");
  });

  it("rejects non-opaque book identifiers before a trace can expose them", () => {
    const store = new ReaderOpenTraceStore();
    expect(() => store.start("E:\\private\\book.epub"))
      .toThrow("INVALID_READER_TRACE_BOOK_ID");
  });

  it("exposes path-free snapshots only when explicitly enabled", () => {
    const target: Record<string, unknown> = {};
    const store = new ReaderOpenTraceStore({
      now: () => 10,
      createId: () => "trace-1",
    });
    const id = store.start("book-1");
    store.mark(id, "interactive");

    installReaderOpenTraceDebugTarget(target, store, false);
    expect(target.__AETHERBOUND_READER_TRACES__).toBeUndefined();

    installReaderOpenTraceDebugTarget(target, store, true);
    const read = target.__AETHERBOUND_READER_TRACES__ as () => unknown;
    expect(read()).toEqual(store.completed());
    expect(JSON.stringify(read())).not.toMatch(/[A-Z]:\\|sourcePath|filePath/i);
  });
});
