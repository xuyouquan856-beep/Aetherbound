// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDeferredAppearance } from "../../src/renderer/src/features/reader/useDeferredAppearance.js";
import { DefaultReadingAppearance } from "../../src/shared/contracts.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useDeferredAppearance", () => {
  it("updates controls immediately but commits and reflows only the newest value", async () => {
    vi.useFakeTimers();
    const onCommit = vi.fn(async () => undefined);
    const { result } = renderHook(() =>
      useDeferredAppearance(DefaultReadingAppearance, onCommit, 100),
    );

    act(() => {
      for (let fontSize = 21; fontSize <= 30; fontSize += 1) {
        result.current.update({ ...DefaultReadingAppearance, fontSize });
      }
    });

    expect(result.current.draft.fontSize).toBe(30);
    expect(result.current.layout.fontSize).toBe(20);
    expect(onCommit).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(result.current.layout.fontSize).toBe(30);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(expect.objectContaining({ fontSize: 30 }));
  });

  it("flushes the latest unsaved choice when the reader unmounts", () => {
    vi.useFakeTimers();
    const onCommit = vi.fn(async () => undefined);
    const { result, unmount } = renderHook(() =>
      useDeferredAppearance(DefaultReadingAppearance, onCommit, 100),
    );

    act(() => result.current.update({
      ...DefaultReadingAppearance,
      paragraphSpacing: 0.9,
    }));
    unmount();

    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith(expect.objectContaining({ paragraphSpacing: 0.9 }));
  });
});
