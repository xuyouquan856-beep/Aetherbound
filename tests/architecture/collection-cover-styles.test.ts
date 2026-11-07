import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("collection cover paint boundaries", () => {
  it("isolates each stack and avoids a broad animated hover shadow", async () => {
    const css = await readFile("src/renderer/src/styles/app.css", "utf8");

    expect(css).toMatch(
      /\.collection-stack-card\s*\{[^}]*isolation:\s*isolate[^}]*contain:\s*paint/s,
    );
    expect(css).toMatch(/\.collection-stack__cover::after\s*\{/);
    expect(css).toMatch(/data-stack-index="0"\]::after[^}]*opacity:\s*1/s);
    expect(css).not.toMatch(/\.collection-stack-grid:hover/);
    expect(css).not.toMatch(
      /button:hover[^{}]*data-stack-index="0"[^{}]*box-shadow/s,
    );
  });
});
