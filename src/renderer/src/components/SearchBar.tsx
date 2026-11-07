import { useState, useEffect, useRef, useCallback } from "react";

export interface SearchResult {
  bookId: string;
  title: string;
  author: string | null;
  format: string;
  matchSnippet: string;
}

type Props = {
  onSearch: (query: string) => Promise<SearchResult[]>;
  onSelect: (bookId: string) => void;
  placeholder?: string;
};

export function SearchBar({ onSearch, onSelect, placeholder = "搜索书名、作者或系列..." }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const doSearch = useCallback(async (q: string) => {
    if (!q.trim()) { setResults([]); setOpen(false); return; }
    setLoading(true);
    try {
      const r = await onSearch(q.trim());
      setResults(r.slice(0, 8));
      setOpen(r.length > 0);
      setSelectedIndex(-1);
    } finally {
      setLoading(false);
    }
  }, [onSearch]);

  useEffect(() => {
    clearTimeout(timerRef.current);
    if (!query.trim()) { setResults([]); setOpen(false); return; }
    timerRef.current = setTimeout(() => doSearch(query), 300);
    return () => clearTimeout(timerRef.current);
  }, [query, doSearch]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open || results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && selectedIndex >= 0) {
      e.preventDefault();
      onSelect(results[selectedIndex].bookId);
      setOpen(false);
      setQuery("");
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className="search-bar" role="combobox" aria-expanded={open} aria-haspopup="listbox">
      <div className="search-bar__input-wrap">
        <svg className="search-bar__icon" width="18" height="18" viewBox="0 0 18 18" fill="none">
          <circle cx="7.5" cy="7.5" r="5.5" stroke="currentColor" strokeWidth="1.5"/>
          <path d="M11.5 11.5L16 16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
        <input
          ref={inputRef}
          type="text"
          className="search-bar__input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => results.length > 0 && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 200)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          aria-label="搜索书库"
        />
        {loading && <span className="search-bar__spinner" aria-hidden="true"/>}
      </div>

      {open && results.length > 0 && (
        <ul className="search-bar__dropdown" role="listbox">
          {results.map((r, i) => (
            <li
              key={r.bookId}
              role="option"
              aria-selected={i === selectedIndex}
              className={`search-bar__item${i === selectedIndex ? " search-bar__item--active" : ""}`}
              onMouseDown={() => { onSelect(r.bookId); setOpen(false); setQuery(""); }}
            >
              <span className="search-bar__item-title" dangerouslySetInnerHTML={{ __html: r.matchSnippet || r.title }}/>
              <span className="search-bar__item-meta">
                {r.author && <span className="search-bar__item-author">{r.author}</span>}
                <span className="search-bar__item-format">{r.format}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
