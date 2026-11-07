import { describe, expect, it } from "vitest";
import { findImports } from "./find-imports.js";

describe("process boundaries", () => {
  it("keeps Electron out of backend and format modules", async () => {
    const violations = await findImports(["src/backend", "src/formats"], /^electron$/);
    expect(violations).toEqual([]);
  });
});
