import { describe, expect, it } from "vitest";
import type { BookDetails } from "../../src/shared/contracts.js";
import {
  InitialReaderLifecycleState,
  transitionReader,
  type ReaderLifecycleState,
} from "../../src/renderer/src/features/reader/reader-lifecycle.js";

function details(id: string): BookDetails {
  return {
    book: {
      id,
      format: "txt",
      title: id,
      author: null,
      availabilityStatus: "available",
      progress: 0,
      addedAt: "2026-07-29T00:00:00.000Z",
      lastReadAt: null,
      updatedAt: "2026-07-29T00:00:00.000Z",
      coverUrl: null,
    },
    sourceRevision: `revision-${id}`,
    chapters: [],
    savedLocation: null,
    sessionId: `session-${id}`,
  };
}

function progressToActive(book = details("book-1")): ReaderLifecycleState {
  let state = transitionReader(InitialReaderLifecycleState, {
    type: "prepare",
    details: book,
    traceId: "trace-1",
  });
  state = transitionReader(state, { type: "ready" });
  state = transitionReader(state, { type: "present" });
  return transitionReader(state, { type: "presented" });
}

describe("reader lifecycle", () => {
  it("progresses from preparation to an active restored reader", () => {
    let state = transitionReader(InitialReaderLifecycleState, {
      type: "prepare",
      details: details("book-1"),
      traceId: "trace-1",
    });
    expect(state.slot?.phase).toBe("preparing");
    state = transitionReader(state, { type: "ready" });
    expect(state.slot?.phase).toBe("ready-hidden");
    state = transitionReader(state, { type: "present" });
    expect(state.slot?.phase).toBe("presenting");
    state = transitionReader(state, { type: "presented" });
    expect(state.slot?.phase).toBe("active");
  });

  it("suspends and resumes the same live slot", () => {
    const active = progressToActive();
    const suspended = transitionReader(active, { type: "suspend" });
    expect(suspended.slot?.phase).toBe("suspended");
    const resumed = transitionReader(suspended, { type: "resume" });
    expect(resumed.slot).toMatchObject({
      phase: "presenting",
      details: { book: { id: "book-1" } },
      traceId: "trace-1",
    });
    expect(transitionReader(suspended, {
      type: "resume",
      traceId: "warm-trace",
    }).slot?.traceId).toBe("warm-trace");
  });

  it("retains at most one slot and permits explicit eviction", () => {
    const first = progressToActive();
    const replacement = transitionReader(first, {
      type: "prepare",
      details: details("book-2"),
      traceId: "trace-2",
    });
    expect(replacement.slot).toMatchObject({
      phase: "preparing",
      details: { book: { id: "book-2" } },
    });
    expect(transitionReader(replacement, { type: "evict" })).toEqual(
      InitialReaderLifecycleState,
    );
  });

  it("rejects readiness without a preparing reader", () => {
    expect(() => transitionReader(InitialReaderLifecycleState, { type: "ready" }))
      .toThrow("INVALID_READER_LIFECYCLE_TRANSITION");
  });

  it("ignores a duplicate prepare event for the same live book", () => {
    const active = progressToActive();
    expect(transitionReader(active, {
      type: "prepare",
      details: details("book-1"),
      traceId: "duplicate-trace",
    })).toBe(active);
  });
});
