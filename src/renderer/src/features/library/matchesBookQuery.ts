import type { BookSummary } from "../../../../shared/contracts.js";

export function matchesBookQuery(book: BookSummary, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return true;
  return [book.title, book.author ?? ""]
    .some((value) => value.toLocaleLowerCase().includes(normalized));
}
