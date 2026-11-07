import { describe, expect, it, vi } from "vitest";
import {
  LayoutTransactionCoordinator,
  restoreCapturedPosition,
} from "../../src/renderer/src/epub-runner/layout-transaction.js";
import {
  paginatorLayoutAttributes,
  publicationAppearanceCss,
} from "../../src/renderer/src/epub-runner/appearance.js";
import { DefaultReadingAppearance } from "../../src/shared/contracts.js";

describe("EPUB layout transaction coordinator", () => {
  it("captures, applies, restores and settles in one ordered transaction", async () => {
    const calls: string[] = [];
    const coordinator = new LayoutTransactionCoordinator<string, string, string>({
      capture: () => {
        calls.push("capture");
        return { anchor: "epubcfi(/6/2)", fallback: "fallback" };
      },
      apply: async (layout) => { calls.push(`apply:${layout}`); },
      waitForStable: async () => { calls.push("stable"); },
      restore: async ({ anchor, fallback }) => { calls.push(`restore:${anchor}:${fallback}`); },
      readLocation: () => {
        calls.push("read");
        return "settled-location";
      },
      onActiveChange: (active) => { calls.push(`active:${active}`); },
      onStarted: (transactionId) => { calls.push(`started:${transactionId}`); },
      onSettled: (transactionId, location) => { calls.push(`settled:${transactionId}:${location}`); },
    });

    await coordinator.request({ transactionId: 1, layout: "night" });

    expect(calls).toEqual([
      "active:true",
      "started:1",
      "capture",
      "apply:night",
      "stable",
      "restore:epubcfi(/6/2):fallback",
      "stable",
      "read",
      "settled:1:settled-location",
      "active:false",
    ]);
  });

  it("coalesces pending work and never commits a stale transaction", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const applied: number[] = [];
    const settled: number[] = [];
    const coordinator = new LayoutTransactionCoordinator<number, string, string>({
      capture: () => ({ anchor: "cfi", fallback: "fallback" }),
      apply: async (layout) => {
        applied.push(layout);
        if (layout === 1) await firstGate;
      },
      waitForStable: async () => undefined,
      restore: async () => undefined,
      readLocation: () => "location",
      onActiveChange: vi.fn(),
      onStarted: vi.fn(),
      onSettled: (transactionId) => { settled.push(transactionId); },
    });

    const first = coordinator.request({ transactionId: 1, layout: 1 });
    await vi.waitFor(() => expect(applied).toEqual([1]));
    const second = coordinator.request({ transactionId: 2, layout: 2 });
    const third = coordinator.request({ transactionId: 3, layout: 3 });
    releaseFirst();
    await Promise.all([first, second, third]);

    expect(applied).toEqual([1, 3]);
    expect(settled).toEqual([3]);
  });

  it("does not settle after disposal", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const onSettled = vi.fn();
    const coordinator = new LayoutTransactionCoordinator<string, string, string>({
      capture: () => ({ anchor: "cfi", fallback: "fallback" }),
      apply: async () => { await gate; },
      waitForStable: async () => undefined,
      restore: async () => undefined,
      readLocation: () => "location",
      onActiveChange: vi.fn(),
      onStarted: vi.fn(),
      onSettled,
    });

    const request = coordinator.request({ transactionId: 1, layout: "layout" });
    coordinator.dispose();
    release();
    await request;

    expect(onSettled).not.toHaveBeenCalled();
  });

  it("falls back when the captured CFI can no longer be restored", async () => {
    const goToAnchor = vi.fn(async () => { throw new Error("stale cfi"); });
    const restoreFallback = vi.fn(async () => undefined);

    await restoreCapturedPosition({
      anchor: "epubcfi(/6/2)",
      fallback: "quote-and-progression",
    }, { goToAnchor, restoreFallback });

    expect(goToAnchor).toHaveBeenCalledWith("epubcfi(/6/2)");
    expect(restoreFallback).toHaveBeenCalledWith("quote-and-progression");
  });
});

describe("EPUB logical layout values", () => {
  it("maps persisted width, flow and column choices to foliate public attributes", () => {
    expect(paginatorLayoutAttributes({
      ...DefaultReadingAppearance,
      measure: 520,
      epubFlow: "paginated",
      epubColumns: "single",
    })).toEqual({
      flow: "paginated",
      "max-inline-size": "520px",
      "max-column-count": "1",
    });
    expect(paginatorLayoutAttributes({
      ...DefaultReadingAppearance,
      measure: 920,
      epubFlow: "scrolled",
      epubColumns: "double",
    })).toEqual({
      flow: "scrolled",
      "max-inline-size": "920px",
      "max-column-count": "2",
    });
  });

  it("creates controlled paragraph typography without overriding special content", () => {
    const css = publicationAppearanceCss({
      ...DefaultReadingAppearance,
      paragraphSpacing: 0.8,
      firstLineIndent: "two-em",
      letterSpacing: 0.06,
    });

    expect(css).toContain("margin-block-end:0.8em");
    expect(css).toContain("text-indent:2em");
    expect(css).toContain("letter-spacing:0.06em");
    expect(css).toMatch(/pre,code,ruby,rt,table,nav/);
    expect(css).toContain('[role="doc-toc"]');
  });
});
