import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveReaderDataRoot } from "../../src/main/data-root-location.js";

describe("reader data root", () => {
  it("uses Electron's per-user directory by default", () => {
    const userData = resolve("fixtures", "default-profile");
    expect(resolveReaderDataRoot(userData, undefined)).toBe(userData);
  });

  it("honors an explicit isolated profile for tests or existing installations", () => {
    const userData = resolve("fixtures", "default-profile");
    const override = resolve("fixtures", "isolated-profile");
    expect(resolveReaderDataRoot(userData, override)).toBe(override);
  });
});
