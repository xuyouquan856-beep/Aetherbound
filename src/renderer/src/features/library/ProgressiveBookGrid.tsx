import { Fragment, type ReactNode, useEffect, useRef, useState } from "react";
import type { BookSummary } from "../../../../shared/contracts.js";
import type { BookDisplayMode } from "./shelf-preferences.js";

export type { BookDisplayMode };

export type ProgressiveBookGridProps = {
  books: BookSummary[];
  mode: BookDisplayMode;
  resetKey: string;
  visibilityStore?: Map<string, number>;
  renderBook(book: BookSummary): ReactNode;
};

const BatchSize = 80;

function ProgressiveBookGridPage({
  books,
  mode,
  renderBook,
  resetKey,
  visibilityStore,
}: ProgressiveBookGridProps) {
  const [visibleCount, setVisibleCount] = useState(() =>
    Math.min(books.length, Math.max(BatchSize, visibilityStore?.get(resetKey) ?? BatchSize)));
  const sentinelRef = useRef<HTMLDivElement>(null);
  const hasMore = visibleCount < books.length;
  const supportsObserver = typeof IntersectionObserver !== "undefined";

  useEffect(() => {
    visibilityStore?.set(resetKey, visibleCount);
  }, [resetKey, visibilityStore, visibleCount]);

  useEffect(() => {
    if (!supportsObserver || !hasMore || !sentinelRef.current) return;

    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setVisibleCount((current) => Math.min(current + BatchSize, books.length));
    }, { rootMargin: "320px 0px" });
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [books.length, hasMore, supportsObserver, visibleCount]);

  return (
    <>
      <div
        className={`book-grid book-grid--${mode}`}
        data-display-mode={mode}
        aria-label="本地书籍"
      >
        {books.slice(0, visibleCount).map((book) => (
          <Fragment key={book.id}>{renderBook(book)}</Fragment>
        ))}
      </div>
      {hasMore && supportsObserver && (
        <div
          ref={sentinelRef}
          className="book-grid__sentinel"
          data-testid="book-grid-sentinel"
          aria-hidden="true"
        />
      )}
      {hasMore && !supportsObserver && (
        <div className="book-grid__fallback">
          <button
            className="button"
            type="button"
            onClick={() => setVisibleCount((current) => Math.min(current + BatchSize, books.length))}
          >
            继续加载
          </button>
        </div>
      )}
    </>
  );
}

export function ProgressiveBookGrid({
  resetKey,
  ...props
}: ProgressiveBookGridProps) {
  return <ProgressiveBookGridPage key={resetKey} resetKey={resetKey} {...props} />;
}
