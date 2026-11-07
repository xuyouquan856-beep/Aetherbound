// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReaderApi, TxtReadingLocationV1 } from "../../src/shared/contracts.js";
import { useReadingProgress } from "../../src/renderer/src/features/reader/useReadingProgress.js";

const location: TxtReadingLocationV1 = {
  locatorVersion: 1,
  sourceRevision: "revision-1",
  format: "txt",
  primary: {
    kind: "txt",
    chapterId: "chapter-1",
    characterOffset: 12,
  },
  progression: { resource: 0.2, total: 0.1 },
  text: { exact: "正文", prefix: "", suffix: "" },
};

function api() {
  return {
    reader: {
      saveProgress: vi.fn(async () => undefined),
      closeSession: vi.fn(async () => undefined),
    },
  } as unknown as ReaderApi;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useReadingProgress", () => {
  it("flushes a newer locator queued while an earlier save is in flight", async () => {
    const readerApi = api();
    let finishFirst!: () => void;
    vi.mocked(readerApi.reader.saveProgress)
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finishFirst = resolve; }));
    const newer = {
      ...location,
      primary: { ...location.primary, characterOffset: 24 },
    };
    const { result } = renderHook(() =>
      useReadingProgress(readerApi, "book-1", "session-1"),
    );

    act(() => result.current.queue(location));
    let firstFlush!: Promise<void>;
    act(() => { firstFlush = result.current.flush(); });
    act(() => result.current.queue(newer));
    let secondFlush!: Promise<void>;
    act(() => { secondFlush = result.current.flush(); });
    await act(async () => { finishFirst(); await Promise.all([firstFlush, secondFlush]); });

    expect(readerApi.reader.saveProgress).toHaveBeenNthCalledWith(2, "book-1", "session-1", newer);
  });
  it("flushes the newest locator without closing a suspended session", async () => {
    const readerApi = api();
    const { result } = renderHook(() =>
      useReadingProgress(readerApi, "book-1", "session-1"),
    );

    act(() => result.current.queue(location));
    await act(async () => result.current.flush());

    expect(readerApi.reader.saveProgress).toHaveBeenCalledWith(
      "book-1",
      "session-1",
      location,
    );
    expect(readerApi.reader.closeSession).not.toHaveBeenCalled();
  });

  it("closes exactly once even when eviction and cleanup overlap", async () => {
    const readerApi = api();
    const { result, unmount } = renderHook(() =>
      useReadingProgress(readerApi, "book-1", "session-1"),
    );
    act(() => result.current.queue(location));

    await act(async () => {
      await Promise.all([result.current.close(), result.current.close()]);
    });
    unmount();

    expect(readerApi.reader.saveProgress).not.toHaveBeenCalled();
    expect(readerApi.reader.closeSession).toHaveBeenCalledTimes(1);
    expect(readerApi.reader.closeSession).toHaveBeenCalledWith(
      "book-1",
      "session-1",
      location,
    );
  });

  it("retries a failed background save without leaking a rejected promise", async () => {
    vi.useFakeTimers();
    const readerApi = api();
    vi.mocked(readerApi.reader.saveProgress)
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce(undefined);
    const { result } = renderHook(() =>
      useReadingProgress(readerApi, "book-1", "session-1"),
    );

    act(() => result.current.queue(location));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_700);
    });

    expect(readerApi.reader.saveProgress).toHaveBeenCalledTimes(2);
  });
});
