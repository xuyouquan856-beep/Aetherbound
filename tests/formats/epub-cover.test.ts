import { describe, expect, it } from "vitest";
import {
  MAX_EPUB_COVER_BYTES,
  detectRasterCoverMediaType,
  enforceEpubCoverBudget,
  isDeclaredRasterCover,
} from "../../src/formats/epub/cover.js";

describe("EPUB raster cover policy", () => {
  it.each([
    ["image/jpeg", new Uint8Array([0xff, 0xd8, 0xff, 0x00])],
    ["image/png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ["image/webp", new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])],
  ] as const)("detects %s by signature", (mediaType, bytes) => {
    expect(detectRasterCoverMediaType(bytes)).toBe(mediaType);
    expect(isDeclaredRasterCover(mediaType, bytes)).toBe(true);
  });

  it("rejects a declared type that does not match the bytes", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff]);
    expect(isDeclaredRasterCover("image/png", jpeg)).toBe(false);
    expect(detectRasterCoverMediaType(new TextEncoder().encode("not an image"))).toBeNull();
  });

  it("enforces a dedicated cover byte budget", () => {
    expect(() => enforceEpubCoverBudget(MAX_EPUB_COVER_BYTES)).not.toThrow();
    expect(() => enforceEpubCoverBudget(MAX_EPUB_COVER_BYTES + 1)).toThrowError(/cover exceeds/i);
  });
});

