import { access, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const modules = [
  "contracts",
  "safe-paths",
  "inventory",
  "epub-metadata",
  "normalization",
  "classifier",
  "preview",
  "executor",
  "cli",
] as const;

describe("library recovery architecture boundary", () => {
  it.each(modules)("provides %s.ts", async (name) => {
    await expect(
      access(new URL(`../../../scripts/library-recovery/${name}.ts`, import.meta.url)),
    ).resolves.toBeUndefined();
  });

  it("keeps mutation APIs out of analysis modules", async () => {
    for (const name of modules.filter((name) => !["executor", "cli"].includes(name))) {
      const source = await readFile(
        new URL(`../../../scripts/library-recovery/${name}.ts`, import.meta.url),
        "utf8",
      );
      expect(source).not.toMatch(
        /\b(rename|renameSync|rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync|Move-Item|Remove-Item|shutil\.move)\b/,
      );
    }
  });

  it("registers a standalone recovery entry point", async () => {
    const packageSource = await readFile(
      new URL("../../../package.json", import.meta.url),
      "utf8",
    );
    expect(packageSource).toContain("\"library:recovery\"");
  });
});
