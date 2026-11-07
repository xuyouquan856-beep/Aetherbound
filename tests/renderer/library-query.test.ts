import { describe, expect, it } from "vitest";
import {
  filterAndSortBooks,
  type LibraryFilter,
  type LibrarySort,
} from "../../src/renderer/src/features/library/library-query.js";
import type { BookSummary } from "../../src/shared/contracts.js";

function book(
  id: string,
  title: string,
  overrides: Partial<BookSummary> = {},
): BookSummary {
  return {
    id,
    title,
    author: null,
    format: "epub",
    coverUrl: null,
    availabilityStatus: "available",
    progress: 0,
    addedAt: "2026-07-29T00:00:00.000Z",
    lastReadAt: null,
    updatedAt: "2026-07-29T00:00:00.000Z",
    ...overrides,
  };
}

const sample = [
  book("b", "星海 10", {
    author: "北辰",
    format: "txt",
    progress: 0.5,
    addedAt: "2026-07-29T01:00:00.000Z",
    lastReadAt: "2026-07-30T08:00:00.000Z",
  }),
  book("c", "星海 2", {
    author: "安然",
    progress: 0.995,
    addedAt: "2026-07-29T01:00:00.000Z",
    lastReadAt: "2026-07-30T10:00:00.000Z",
  }),
  book("a", "长夜", {
    author: null,
    progress: 0,
    addedAt: "2026-07-28T01:00:00.000Z",
    lastReadAt: null,
  }),
];

describe("library query", () => {
  it.each([
    ["added-desc", ["b", "c", "a"]],
    ["last-read-desc", ["c", "b", "a"]],
    ["title", ["c", "b", "a"]],
    ["author", ["a", "c", "b"]],
    ["progress-desc", ["c", "b", "a"]],
  ] satisfies Array<[LibrarySort, string[]]>)("sorts by %s deterministically", (sort, expected) => {
    expect(filterAndSortBooks(sample, { query: "", filter: "all", sort }).map((item) => item.id))
      .toEqual(expected);
  });

  it.each([
    ["unread", ["a"]],
    ["reading", ["b"]],
    ["finished", ["c"]],
    ["epub", ["c", "a"]],
    ["txt", ["b"]],
  ] satisfies Array<[LibraryFilter, string[]]>)("applies the %s filter", (filter, expected) => {
    expect(filterAndSortBooks(sample, { query: "", filter, sort: "added-desc" }).map((item) => item.id))
      .toEqual(expected);
  });

  it("applies metadata search before returning the sorted result", () => {
    expect(filterAndSortBooks(sample, {
      query: "北辰",
      filter: "reading",
      sort: "title",
    }).map((item) => item.id)).toEqual(["b"]);
  });
});
