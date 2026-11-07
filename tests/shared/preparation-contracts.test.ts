import { describe, expect, it } from "vitest";
import {
  BookSummarySchema,
  PublicPreparationEventSchema,
} from "../../src/shared/contracts.js";

describe("book preparation public contracts", () => {
  it("accepts preparation projections on book summaries without requiring them", () => {
    const base = {
      id: "book-1",
      title: "Book",
      author: null,
      format: "epub" as const,
      availabilityStatus: "available" as const,
      progress: 0,
      addedAt: "2026-07-29T00:00:00.000Z",
      lastReadAt: null,
      updatedAt: "2026-07-29T00:00:00.000Z",
      coverUrl: null,
    };

    expect(BookSummarySchema.parse(base)).toEqual(base);
    expect(BookSummarySchema.parse({
      ...base,
      preparationStatus: "preparing",
      preparationErrorCode: null,
    })).toEqual({
      ...base,
      preparationStatus: "preparing",
      preparationErrorCode: null,
    });
  });

  it("exposes only bounded state and sanitized error codes", () => {
    const event = {
      bookId: "book-1",
      sourceRevision: "revision-1",
      state: "error" as const,
      errorCode: "INVALID_PACKAGE" as const,
    };
    expect(PublicPreparationEventSchema.parse(event)).toEqual(event);
    expect(() => PublicPreparationEventSchema.parse({
      ...event,
      sourcePath: "E:\\private\\book.epub",
    })).toThrow();
    expect(() => PublicPreparationEventSchema.parse({
      ...event,
      errorCode: "E:\\private\\book.epub",
    })).toThrow();
    expect(() => PublicPreparationEventSchema.parse({
      ...event,
      state: "unknown",
    })).toThrow();
  });
});
