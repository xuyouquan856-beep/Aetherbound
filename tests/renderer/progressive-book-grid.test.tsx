// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProgressiveBookGrid } from "../../src/renderer/src/features/library/ProgressiveBookGrid.js";
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

function books(count: number): BookSummary[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `book-${index}`,
    title: `第 ${index + 1} 本书`,
    author: null,
    format: "epub" as const,
    coverUrl: null,
    availabilityStatus: "available" as const,
    progress: 0,
    addedAt: "2026-07-29T00:00:00.000Z",
    lastReadAt: null,
    updatedAt: "2026-07-29T00:00:00.000Z",
  }));
}

afterEach(cleanup);

beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal("IntersectionObserver", IntersectionObserverMock);
});

describe("ProgressiveBookGrid", () => {
  it("renders large libraries in stable batches and resets after the query changes", () => {
    const allBooks = books(1_200);
    const { rerender } = render(
      <ProgressiveBookGrid
        books={allBooks}
        mode="comfortable"
        resetKey="all"
        renderBook={(item) => <article data-testid="book-tile">{item.title}</article>}
      />,
    );

    expect(screen.getAllByTestId("book-tile")).toHaveLength(80);
    act(() => observers.at(-1)?.([{
      isIntersecting: true,
      target: screen.getByTestId("book-grid-sentinel"),
    } as unknown as IntersectionObserverEntry]));
    expect(screen.getAllByTestId("book-tile")).toHaveLength(160);

    rerender(
      <ProgressiveBookGrid
        books={allBooks.slice(0, 37)}
        mode="compact"
        resetKey="filtered"
        renderBook={(item) => <article data-testid="book-tile">{item.title}</article>}
      />,
    );
    expect(screen.getAllByTestId("book-tile")).toHaveLength(37);
  });

  it("offers a keyboard-operable fallback when IntersectionObserver is unavailable", () => {
    vi.unstubAllGlobals();
    const allBooks = books(100);

    render(
      <ProgressiveBookGrid
        books={allBooks}
        mode="list"
        resetKey="all"
        renderBook={(item) => <article data-testid="book-tile">{item.title}</article>}
      />,
    );

    expect(screen.getAllByTestId("book-tile")).toHaveLength(80);
    fireEvent.click(screen.getByRole("button", { name: "继续加载" }));
    expect(screen.getAllByTestId("book-tile")).toHaveLength(100);
  });

  it("restores loaded batches when returning to the same shelf results", () => {
    const allBooks = books(300);
    const visibilityStore = new Map<string, number>();
    const props = {
      books: allBooks,
      mode: "comfortable" as const,
      resetKey: "search:星海",
      visibilityStore,
      renderBook: (item: BookSummary) => <article data-testid="book-tile">{item.title}</article>,
    };
    const first = render(<ProgressiveBookGrid {...props} />);
    act(() => observers.at(-1)?.([{
      isIntersecting: true,
      target: screen.getByTestId("book-grid-sentinel"),
    } as unknown as IntersectionObserverEntry]));
    expect(screen.getAllByTestId("book-tile")).toHaveLength(160);
    first.unmount();

    render(<ProgressiveBookGrid {...props} />);
    expect(screen.getAllByTestId("book-tile")).toHaveLength(160);
  });
});
