// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AllBooksView } from "../../src/renderer/src/features/library/AllBooksView.js";
import { filterAndSortBooks } from "../../src/renderer/src/features/library/library-query.js";
import type { BookSummary } from "../../src/shared/contracts.js";

const observers: Array<(entries: IntersectionObserverEntry[]) => void> = [];

class IntersectionObserverMock {
  readonly root = null;
  readonly rootMargin = "";
  readonly thresholds = [];
  constructor(callback: IntersectionObserverCallback) {
    observers.push((entries) => callback(entries, this as unknown as IntersectionObserver));
  }
  disconnect = vi.fn();
  observe = vi.fn();
  takeRecords = vi.fn(() => []);
  unobserve = vi.fn();
}

function largeLibrary(): BookSummary[] {
  return Array.from({ length: 1_200 }, (_, index) => ({
    id: `book-${String(index).padStart(4, "0")}`,
    title: index === 1_199 ? "特选 1199" : `藏书 ${index}`,
    author: `作者 ${index % 40}`,
    format: index % 5 === 0 ? "txt" as const : "epub" as const,
    coverUrl: null,
    availabilityStatus: "available" as const,
    progress: (index % 100) / 100,
    addedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    lastReadAt: null,
    updatedAt: "2026-07-29T00:00:00.000Z",
  }));
}

beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal("IntersectionObserver", IntersectionObserverMock);
  // Shelf view preferences persist to localStorage; keep tests independent.
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("large bookshelf rendering", () => {
  it("keeps a 1,200-book library bounded through scrolling, search, density, and sorting", () => {
    const books = largeLibrary();
    const baseProps: Parameters<typeof AllBooksView>[0] = {
      books,
      collections: [],
      query: "",
      busy: false,
      notice: null,
      onImportFiles: vi.fn(),
      onOpen: vi.fn(),
      onRemove: vi.fn(async () => true),
      onGetMemberships: vi.fn(async () => []),
      onCreateCollection: vi.fn(),
      onAddBooksToCollection: vi.fn(),
    };
    const view = render(<AllBooksView {...baseProps} />);

    expect(screen.getAllByTestId("book-tile").length).toBeLessThanOrEqual(80);
    act(() => observers.at(-1)?.([{
      isIntersecting: true,
      target: screen.getByTestId("book-grid-sentinel"),
    } as unknown as IntersectionObserverEntry]));
    expect(screen.getAllByTestId("book-tile").length).toBeLessThanOrEqual(160);

    view.rerender(<AllBooksView {...baseProps} query="特选 1199" />);
    expect(screen.getAllByTestId("book-tile")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "特选 1199" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "列表" }));
    expect(screen.getAllByTestId("book-tile")).toHaveLength(1);
    expect(new Set(screen.getAllByTestId("book-tile").map((tile) =>
      tile.querySelector('[role="heading"]')?.textContent)).size).toBe(1);

    const sorted = filterAndSortBooks(books, {
      query: "",
      filter: "all",
      sort: "title",
    });
    expect(sorted).toHaveLength(1_200);
    expect(new Set(sorted.map((book) => book.id))).toHaveLength(1_200);
  });
});
