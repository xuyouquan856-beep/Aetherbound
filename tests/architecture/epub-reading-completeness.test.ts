import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ReadingAppearanceSchema } from "../../src/shared/contracts.js";

describe("EPUB reading completeness boundaries", () => {
  it("backfills persisted light-novel layout preferences", () => {
    const parsed = ReadingAppearanceSchema.parse({
      theme: "paper",
      fontFamily: "serif",
      fontSize: 20,
      lineHeight: 1.85,
      measure: 720,
      brightness: 100,
    });

    expect(parsed).toMatchObject({
      epubFlow: "paginated",
      epubColumns: "double",
      paragraphSpacing: 0,
      firstLineIndent: "two-em",
      letterSpacing: 0,
    });
  });

  it("uses one authenticated layout command instead of competing flow and appearance commands", async () => {
    const protocol = await readFile("src/renderer/src/epub-runner/protocol.ts", "utf8");

    expect(protocol).toContain('command: z.literal("applyLayout")');
    expect(protocol).not.toContain('command: z.literal("setFlow")');
    expect(protocol).not.toContain('command: z.literal("applyAppearance")');
  });

  it("configures foliate through public logical layout attributes", async () => {
    const runner = await readFile("src/renderer/src/epub-runner/main.ts", "utf8");
    const appearance = await readFile("src/renderer/src/epub-runner/appearance.ts", "utf8");

    expect(`${runner}\n${appearance}`).toContain('"max-inline-size"');
    expect(`${runner}\n${appearance}`).toContain('"max-column-count"');
    expect(runner).not.toMatch(/[A-Z]:\\\\|window\.readerApi\./);
  });
});
