import { describe, expect, it } from "vitest";
import { LibraryRemoveRequestSchema } from "../../src/shared/contracts.js";

describe("library removal contract", () => {
  it("accepts unique opaque ids", () => {
    expect(LibraryRemoveRequestSchema.parse({ bookIds: ["book-1", "book-2"] }))
      .toEqual({ bookIds: ["book-1", "book-2"] });
    expect(LibraryRemoveRequestSchema.parse({ bookIds: ["book-1"], deleteOriginal: true }))
      .toEqual({ bookIds: ["book-1"], deleteOriginal: true });
  });

  it("rejects empty, path-like, duplicate, or oversized requests", () => {
    expect(() => LibraryRemoveRequestSchema.parse({ bookIds: [] })).toThrow();
    expect(() => LibraryRemoveRequestSchema.parse({ bookIds: ["E:\\book.epub"] })).toThrow();
    expect(() => LibraryRemoveRequestSchema.parse({ bookIds: ["book-1", "book-1"] })).toThrow();
    expect(() => LibraryRemoveRequestSchema.parse({ bookIds: ["book-1"], sourcePath: "C:\\book.txt" })).toThrow();
    expect(() => LibraryRemoveRequestSchema.parse({
      bookIds: Array.from({ length: 1001 }, (_, index) => `book-${index}`),
    })).toThrow();
  });
});
