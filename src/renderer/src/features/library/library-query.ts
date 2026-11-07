import type { BookSummary } from "../../../../shared/contracts.js";
import { matchesBookQuery } from "./matchesBookQuery.js";
import {
  LibraryFilterValues,
  LibrarySortValues,
  type LibraryFilter,
  type LibraryFormatFilter,
  type LibrarySort,
  type LibrarySortDirection,
} from "./shelf-preferences.js";

export { LibraryFilterValues, LibrarySortValues };
export type { LibraryFilter, LibraryFormatFilter, LibrarySort, LibrarySortDirection };

type LibraryQuery = {
  query: string;
  filter: LibraryFilter;
  sort: LibrarySort;
  formatFilter?: LibraryFormatFilter;
  sortDirection?: LibrarySortDirection;
  pinnedOnly?: boolean;
  pinnedBookIds?: ReadonlySet<string>;
};

const MetadataCollator = new Intl.Collator("zh-CN", {
  numeric: true,
  sensitivity: "base",
});

function matchesFilter(book: BookSummary, filter: LibraryFilter): boolean {
  if (filter === "unread") return book.progress === 0;
  if (filter === "reading") return book.progress > 0 && book.progress < 0.995;
  if (filter === "finished") return book.progress >= 0.995;
  if (filter === "epub" || filter === "txt") return book.format === filter;
  return true;
}

function stableIdOrder(left: BookSummary, right: BookSummary): number {
  return left.id.localeCompare(right.id);
}

function compareBooksBase(left: BookSummary, right: BookSummary, sort: LibrarySort): number {
  if (sort === "added-desc") {
    return right.addedAt.localeCompare(left.addedAt);
  }
  if (sort === "last-read-desc") {
    return (right.lastReadAt ?? "").localeCompare(left.lastReadAt ?? "")
      || right.addedAt.localeCompare(left.addedAt);
  }
  if (sort === "progress-desc") {
    return right.progress - left.progress;
  }
  const leftValue = sort === "author" ? left.author ?? "" : left.title;
  const rightValue = sort === "author" ? right.author ?? "" : right.title;
  return MetadataCollator.compare(leftValue, rightValue);
}

export function filterAndSortBooks(
  books: BookSummary[],
  options: LibraryQuery,
): BookSummary[] {
  const directionMultiplier = options.sortDirection === "reverse" ? -1 : 1;
  const pinnedIds = options.pinnedBookIds;

  return books
    .filter((book) => matchesBookQuery(book, options.query))
    .filter((book) => matchesFilter(book, options.filter))
    .filter((book) => {
      if (!options.formatFilter || options.formatFilter === "all") return true;
      return book.format === options.formatFilter;
    })
    .filter((book) => {
      if (!options.pinnedOnly) return true;
      return Boolean(pinnedIds?.has(book.id));
    })
    .sort((left, right) => {
      if (pinnedIds && pinnedIds.size > 0) {
        const leftPinned = pinnedIds.has(left.id) ? 1 : 0;
        const rightPinned = pinnedIds.has(right.id) ? 1 : 0;
        if (leftPinned !== rightPinned) return rightPinned - leftPinned;
      }
      const primary = compareBooksBase(left, right, options.sort) * directionMultiplier;
      return primary || stableIdOrder(left, right);
    });
}

