// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getCoverImageState,
  loadCoverImage,
  prewarmCoverImages,
} from "../../src/renderer/src/features/library/cover-image-cache.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("cover image cache", () => {
  it("deduplicates concurrent decode work for one URL", async () => {
    const created: FakeImage[] = [];
    class FakeImage {
      onload: null | (() => void) = null;
      onerror: null | (() => void) = null;
      naturalWidth = 120;
      complete = false;
      src = "";
      decode = vi.fn(async () => undefined);
      constructor() { created.push(this); }
    }
    vi.stubGlobal("Image", FakeImage);
    const url = "reader-resource://publication/dedupe/rev/cover";

    const first = loadCoverImage(url);
    const second = loadCoverImage(url);

    expect(first).toBe(second);
    expect(created).toHaveLength(1);
    created[0]!.complete = true;
    created[0]!.onload?.();
    await expect(first).resolves.toBe("ready");
    expect(created[0]!.decode).toHaveBeenCalledTimes(1);
    expect(getCoverImageState(url)).toBe("ready");
  });

  it("limits first-viewport work to eight URLs and four active loads", async () => {
    let active = 0;
    let peak = 0;
    let created = 0;
    const releases: Array<() => void> = [];
    class FakeImage {
      onload: null | (() => void) = null;
      onerror: null | (() => void) = null;
      naturalWidth = 100;
      complete = true;
      private value = "";
      get src() { return this.value; }
      set src(value: string) {
        this.value = value;
        queueMicrotask(() => this.onload?.());
      }
      decode = vi.fn(() => new Promise<void>((resolve) => {
        active += 1;
        peak = Math.max(peak, active);
        releases.push(() => {
          active -= 1;
          resolve();
        });
      }));
      constructor() { created += 1; }
    }
    vi.stubGlobal("Image", FakeImage);

    const pending = prewarmCoverImages(
      Array.from({ length: 12 }, (_, index) =>
        `reader-resource://publication/p-${index}/rev/cover`),
      { limit: 8, concurrency: 4, timeoutMs: 5_000 },
    );

    await vi.waitFor(() => expect(releases).toHaveLength(4));
    releases.splice(0).forEach((release) => release());
    await vi.waitFor(() => expect(created).toBe(8));
    await vi.waitFor(() => expect(releases).toHaveLength(4));
    releases.splice(0).forEach((release) => release());
    await pending;

    expect(created).toBe(8);
    expect(peak).toBeLessThanOrEqual(4);
  });
});
