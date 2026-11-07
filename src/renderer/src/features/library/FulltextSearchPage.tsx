import { MagnifyingGlass } from "@phosphor-icons/react";
import { useState, useCallback, useMemo, useRef, type ReactNode } from "react";
import type { BookSummary, FulltextSearchResult } from "../../../../shared/contracts.js";

type Props = {
  books?: BookSummary[];
  onSearch(query: string, offset?: number): Promise<FulltextSearchResult[]>;
  onOpenBook(bookId: string): void;
  onOpenResult?(result: FulltextSearchResult, query: string): void;
};

function renderHighlightedSnippet(snippet: string, keyword: string): ReactNode {
  const needle = keyword.trim();
  if (!needle) return snippet;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = snippet.split(new RegExp(`(${escaped})`, "gi"));
  if (parts.length <= 1) return snippet;
  const lowerNeedle = needle.toLocaleLowerCase();
  return parts.map((part, index) =>
    part.toLocaleLowerCase() === lowerNeedle ? (
      <mark key={index} className="search-result-highlight">{part}</mark>
    ) : (
      part
    ),
  );
}

export function FulltextSearchPage({ books = [], onSearch, onOpenBook, onOpenResult }: Props) {
  const pageSize = 20;
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [results, setResults] = useState<FulltextSearchResult[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const requestId = useRef(0);
  const bookById = useMemo(() => new Map(books.map((book) => [book.id, book])), [books]);

  const handleSearch = useCallback(async () => {
    const trimmed = query.trim();
    if (!trimmed) return;
    const currentRequest = ++requestId.current;
    setSearching(true);
    setError(null);
    setResults([]);
    setHasMore(false);
    setSubmittedQuery(trimmed);
    try {
      const r = await onSearch(trimmed);
      if (requestId.current !== currentRequest) return;
      setResults(r);
      setHasMore(r.length === pageSize);
      setSearched(true);
    } catch (e) {
      if (requestId.current !== currentRequest) return;
      setError(e instanceof Error ? e.message : "搜索失败");
      setResults([]);
    } finally {
      if (requestId.current === currentRequest) setSearching(false);
    }
  }, [query, onSearch]);

  const loadMore = useCallback(async () => {
    if (searching || !hasMore || !submittedQuery) return;
    const currentRequest = ++requestId.current;
    setSearching(true);
    setError(null);
    try {
      const next = await onSearch(submittedQuery, results.length);
      if (requestId.current !== currentRequest) return;
      setResults((current) => [...current, ...next]);
      setHasMore(next.length === pageSize);
    } catch (e) {
      if (requestId.current !== currentRequest) return;
      setError(e instanceof Error ? e.message : "搜索失败");
    } finally {
      if (requestId.current === currentRequest) setSearching(false);
    }
  }, [hasMore, onSearch, results.length, searching, submittedQuery]);

  return (
    <main className="page fulltext-search-page">
      <header className="page-header">
        <MagnifyingGlass size={24} />
        <h1>全文搜索</h1>
      </header>

      <div className="search-bar-row">
        <input
          type="search"
          className="search-input"
          placeholder="搜索正文内容..."
          aria-label="全文搜索关键词"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
        />
        <button className="button button--primary" onClick={handleSearch} disabled={searching || !query.trim()}>
          {searching ? "搜索中..." : "搜索"}
        </button>
      </div>

      {error && <div className="notice notice--error">{error}</div>}

      {searched && results.length === 0 && !error && !searching && (
        <div className="empty-state">
          <p>未找到匹配结果</p>
        </div>
      )}

      {results.length > 0 && (
        <ul className="search-results">
          {results.map((r, i) => {
            const book = bookById.get(r.bookId);
            return (
              <li key={`${r.bookId}-${r.unitIndex}-${i}`} className="search-result-item">
                <button
                  type="button"
                  className="search-result-link"
                  onClick={() => onOpenResult ? onOpenResult(r, submittedQuery || query.trim()) : onOpenBook(r.bookId)}
                >
                  <span className="search-result-head">
                    <span className="search-result-title">{r.title}</span>
                    {book && (
                      <span className="search-result-meta">
                        {book.author ? <span>{book.author}</span> : null}
                        <span className="book-tile__format-badge">{book.format.toUpperCase()}</span>
                      </span>
                    )}
                  </span>
                  <span className="search-result-snippet">
                    {renderHighlightedSnippet(r.matchSnippet, submittedQuery)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {hasMore && <button className="button" type="button" onClick={loadMore} disabled={searching}>
        {searching ? "加载中..." : "加载更多结果"}
      </button>}
    </main>
  );
}

