import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("reader open continuity boundaries", () => {
  it("requires isolated lifecycle, stage, and trace modules", () => {
    for (const path of [
      "src/renderer/src/features/reader/reader-lifecycle.ts",
      "src/renderer/src/features/reader/ReaderStage.tsx",
      "src/renderer/src/features/reader/reader-open-trace.ts",
    ]) {
      expect(existsSync(path), path).toBe(true);
    }
  });

  it("never adds reader loading copy", () => {
    const path = "src/renderer/src/features/reader/ReaderStage.tsx";
    expect(existsSync(path), path).toBe(true);
    const source = readFileSync(path, "utf8");
    expect(source).not.toMatch(/加载|正在回到|spinner|skeleton/i);
  });
});
