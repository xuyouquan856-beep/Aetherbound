import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { EpubReadingLocationV1 } from "../../src/shared/contracts.js";
import { initialLastLocation } from "../../src/renderer/src/epub-runner/restoration.js";

const location: EpubReadingLocationV1 = {
  locatorVersion: 1,
  sourceRevision: "rev-1",
  format: "epub",
  primary: {
    kind: "epub",
    spineIndex: 8,
    spineHref: "item/xhtml/p-002.xhtml",
    engineLocator: { kind: "epub-cfi", value: "epubcfi(/6/18!/4/2:0)" },
  },
  progression: { resource: 0.9, total: 0.56 },
  text: { exact: "恢复位置", prefix: "", suffix: "" },
};

describe("EPUB initial restoration", () => {
  it("uses an exact CFI as foliate lastLocation only for the same source revision", () => {
    expect(initialLastLocation(location, "rev-1")).toBe("epubcfi(/6/18!/4/2:0)");
    expect(initialLastLocation(location, "rev-2")).toBeNull();
    expect(initialLastLocation(null, "rev-1")).toBeNull();
  });

  it("finishes exact or fallback restoration before exposing the runner as ready", async () => {
    const source = await readFile("src/renderer/src/epub-runner/main.ts", "utf8");
    const initAt = source.indexOf("await view.init({ lastLocation })");
    const fallbackAt = source.indexOf("await restore(restoreLocation)");
    const finishedAt = source.indexOf("restoring = false", fallbackAt);
    const readyAt = source.indexOf('dataset.ready = "true"', finishedAt);

    expect(initAt).toBeGreaterThan(0);
    expect(fallbackAt).toBeGreaterThan(initAt);
    expect(finishedAt).toBeGreaterThan(fallbackAt);
    expect(readyAt).toBeGreaterThan(finishedAt);
  });

  it("waits for two stable paint frames before exposing the restored reader", async () => {
    const source = await readFile("src/renderer/src/epub-runner/main.ts", "utf8");
    expect(source).toMatch(
      /async function waitForStablePaint\(\)[\s\S]*requestAnimationFrame[\s\S]*requestAnimationFrame/,
    );
    expect(source).toMatch(
      /restoring = false[\s\S]*await waitForStablePaint\(\)[\s\S]*dataset\.ready = "true"/,
    );
  });

  it("routes layout changes through one transaction while buffering relocations", async () => {
    const source = await readFile("src/renderer/src/epub-runner/main.ts", "utf8");
    expect(source).toMatch(/let currentCfi:\s*string \| null = null/);
    expect(source).toMatch(/currentCfi = detail\.cfi/);
    expect(source).toMatch(/LayoutTransactionCoordinator/);
    expect(source).toMatch(/layoutChanging[\s\S]*pendingLocation/);
    expect(source).toMatch(/command\.command === "applyLayout"[\s\S]*layoutCoordinator\?\.request/);
  });
});
