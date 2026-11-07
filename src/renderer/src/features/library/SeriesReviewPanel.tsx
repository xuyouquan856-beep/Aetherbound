import { ArrowLeft, Check, Plus, X } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import type { BookSummary, CollectionDetails, CollectionSummary } from "../../../../shared/contracts.js";
import { GeneratedBookCover } from "./GeneratedBookCover.js";
import { PublicationCoverImage } from "./PublicationCoverImage.js";
import type { SeriesSuggestion } from "./series-suggestions.js";

type Props = {
  suggestion: SeriesSuggestion;
  libraryBooks: BookSummary[];
  collections: CollectionSummary[];
  busy: boolean;
  onGetCollection(collectionId: string): Promise<CollectionDetails>;
  onCreateCollection(name: string): Promise<CollectionDetails>;
  onAddBooksToCollection(collectionId: string, bookIds: string[]): Promise<CollectionDetails>;
  onDone(): void;
  onCancel(): void;
};

export function SeriesReviewPanel({
  suggestion, libraryBooks, collections, busy,
  onGetCollection, onCreateCollection, onAddBooksToCollection, onDone, onCancel,
}: Props) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(suggestion.bookIds));
  const [query, setQuery] = useState("");
  const [targetMode, setTargetMode] = useState<"existing" | "new">(
    suggestion.targetCollectionId ? "existing" : "new",
  );
  const [targetId, setTargetId] = useState(suggestion.targetCollectionId ?? collections[0]?.id ?? "");
  const [newName, setNewName] = useState(suggestion.name);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [targetDetails, setTargetDetails] = useState<CollectionDetails | null>(null);
  const [targetLoadError, setTargetLoadError] = useState<string | null>(null);
  const [targetLoading, setTargetLoading] = useState(false);
  const [targetQuery, setTargetQuery] = useState("");
  const [visibleTargetBooks, setVisibleTargetBooks] = useState(40);
  const [reloadTarget, setReloadTarget] = useState(0);
  const disabled = busy || working;
  const selectedBooks = useMemo(() => libraryBooks.filter((book) => selected.has(book.id)), [libraryBooks, selected]);
  const currentTarget = targetMode === "existing" && targetDetails?.id === targetId ? targetDetails : null;
  const targetBookIds = useMemo(() => new Set(currentTarget?.books.map((book) => book.id) ?? []), [currentTarget]);
  const targetTitles = useMemo(() => new Set(currentTarget?.books.map((book) => comparableTitle(book.title)) ?? []), [currentTarget]);
  const booksToAdd = selectedBooks.filter((book) => !targetBookIds.has(book.id));
  const alreadyInTarget = selectedBooks.length - booksToAdd.length;
  const sameTitleCount = booksToAdd.filter((book) => targetTitles.has(comparableTitle(book.title))).length;
  function bookStatus(book: BookSummary) {
    if (targetBookIds.has(book.id)) return "已在该珍藏";
    if (targetTitles.has(comparableTitle(book.title))) return "与珍藏现有书籍同名，请核对";
    return book.author || "作者未知";
  }
  const matchingTargetBooks = useMemo(() => {
    const needle = targetQuery.normalize("NFKC").trim().toLocaleLowerCase();
    if (!needle) return currentTarget?.books ?? [];
    return (currentTarget?.books ?? []).filter((book) => book.title.normalize("NFKC").toLocaleLowerCase().includes(needle)
      || book.author?.normalize("NFKC").toLocaleLowerCase().includes(needle));
  }, [currentTarget, targetQuery]);

  useEffect(() => {
    if (targetMode !== "existing" || !targetId) return;
    let active = true;
    setTargetLoading(true);
    setTargetLoadError(null);
    setTargetDetails(null);
    void onGetCollection(targetId).then((details) => {
      if (active) setTargetDetails(details);
    }).catch((cause: unknown) => {
      if (active) setTargetLoadError(cause instanceof Error ? cause.message : "珍藏书单加载失败，请重试。");
    }).finally(() => {
      if (active) setTargetLoading(false);
    });
    return () => { active = false; };
  }, [onGetCollection, reloadTarget, targetId, targetMode]);

  useEffect(() => {
    setTargetQuery("");
    setVisibleTargetBooks(40);
  }, [targetId]);
  const candidates = useMemo(() => {
    const needle = query.normalize("NFKC").trim().toLocaleLowerCase();
    if (!needle) return [];
    return libraryBooks.filter((book) =>
      book.title.normalize("NFKC").toLocaleLowerCase().includes(needle)
      || book.author?.normalize("NFKC").toLocaleLowerCase().includes(needle),
    ).slice(0, 100);
  }, [libraryBooks, query]);

  function toggle(bookId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(bookId)) next.delete(bookId);
      else next.add(bookId);
      return next;
    });
  }

  async function apply() {
    if (selectedBooks.length === 0 || (targetMode === "existing" && (!currentTarget || booksToAdd.length === 0))) return;
    setWorking(true);
    setError(null);
    try {
      const collectionId = targetMode === "existing"
        ? targetId
        : (await onCreateCollection(newName.trim())).id;
      if (!collectionId) throw new Error("请选择目标珍藏");
      await onAddBooksToCollection(collectionId, (targetMode === "existing" ? booksToAdd : selectedBooks).map((book) => book.id));
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "归类失败，请稍后重试。");
    } finally {
      setWorking(false);
    }
  }

  return <section className="series-review" aria-label={`检查系列《${suggestion.name}》`}>
    <header className="series-review__header">
      <button className="button" type="button" onClick={onCancel} disabled={disabled}><ArrowLeft size={16} />返回建议</button>
      <div><h2>检查《{suggestion.name}》</h2><p>只是识别建议；确认后才会修改珍藏。</p></div>
    </header>
    <div className="series-review__columns">
      <div className="series-review__books">
        <h3>将加入的书 <span>{selectedBooks.length} 本</span></h3>
        {currentTarget && <p className="series-review__selection-note">{booksToAdd.length} 本待加入{alreadyInTarget > 0 ? ` · ${alreadyInTarget} 本已在该珍藏，将跳过` : ""}{sameTitleCount > 0 ? ` · ${sameTitleCount} 本与现有书籍同名，请核对` : ""}</p>}
        {selectedBooks.length === 0 ? <p className="series-review__empty">先从下方搜索并选择书籍。</p> :
          <ul className="series-review__selected">
            {selectedBooks.map((book) => <li key={book.id}>
              <SeriesBookCover book={book} />
              <span className="series-review__book-copy"><strong>{book.title}</strong><small>{bookStatus(book)}</small></span>
              <button type="button" aria-label={`移出建议《${book.title}》`} disabled={disabled} onClick={() => toggle(book.id)}><X size={16} /></button>
            </li>)}
          </ul>}
        <label className="series-review__search">
          <span>补入漏掉的书</span>
          <input type="search" aria-label="查找漏掉的书" placeholder="搜索书名或作者，跨全部书籍查找" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        {query && <div className="series-review__results" aria-label="书库搜索结果">
          {candidates.length === 0 ? <p>没有找到书籍，请换个关键词。</p>
            : candidates.map((book) => <label key={book.id}>
              <input type="checkbox" checked={selected.has(book.id)} disabled={disabled} onChange={() => toggle(book.id)} />
              <SeriesBookCover book={book} />
              <span className="series-review__book-copy"><strong>{book.title}</strong><small>{bookStatus(book)}</small></span>
            </label>)}
          {candidates.length === 100 && <p>仅显示前 100 条，请缩小搜索范围。</p>}
        </div>}
      </div>
      <div className="series-review__target">
        <h3>归入哪里</h3>
        <div className="series-review__modes" role="group" aria-label="目标珍藏类型">
          <button type="button" aria-pressed={targetMode === "existing"} disabled={disabled || collections.length === 0} onClick={() => setTargetMode("existing")}>已有珍藏</button>
          <button type="button" aria-pressed={targetMode === "new"} disabled={disabled} onClick={() => setTargetMode("new")}>新建珍藏</button>
        </div>
        {targetMode === "existing" ? <><label className="series-review__field">
          <span>选择已有珍藏</span>
          <select value={targetId} disabled={disabled} onChange={(event) => setTargetId(event.target.value)}>
            {collections.map((collection) => <option key={collection.id} value={collection.id}>{collection.name}（{collection.bookCount} 本）</option>)}
          </select>
        </label>
          <div className="series-review__existing">
            <h3>珍藏现有书籍 {currentTarget?.books.length ?? 0} 本</h3>
            {targetLoading && <p className="series-review__empty" role="status">正在载入珍藏书籍…</p>}
            {targetLoadError && <div className="series-review__load-error" role="alert"><p>{targetLoadError}</p><button className="button" type="button" onClick={() => setReloadTarget((value) => value + 1)}>重试加载</button></div>}
            {currentTarget && <>
              {currentTarget.books.length > 10 && <input type="search" aria-label="筛选已有书籍" placeholder="在这份珍藏里查找" value={targetQuery} onChange={(event) => { setTargetQuery(event.target.value); setVisibleTargetBooks(40); }} />}
              {currentTarget.books.length === 0 ? <p className="series-review__empty">这份珍藏还没有书。</p> : matchingTargetBooks.length === 0 ? <p className="series-review__empty">没有匹配的书籍。</p> : <>
                <ul className="series-review__existing-list" aria-label="珍藏现有书籍">
                  {matchingTargetBooks.slice(0, visibleTargetBooks).map((book) => <li key={book.id}>
                    <SeriesBookCover book={book} />
                    <span className="series-review__book-copy"><strong>{book.title}</strong><small>{book.author || "作者未知"}</small></span>
                  </li>)}
                </ul>
                {matchingTargetBooks.length > visibleTargetBooks && <button className="button series-review__more" type="button" onClick={() => setVisibleTargetBooks((count) => count + 40)}>显示更多（还剩 {matchingTargetBooks.length - visibleTargetBooks} 本）</button>}
              </>}
            </>}
          </div>
        </> : <label className="series-review__field">
          <span>新珍藏名称</span>
          <input value={newName} maxLength={80} disabled={disabled} onChange={(event) => setNewName(event.target.value)} />
        </label>}
        <p className="series-review__note">只增加归组关系，不会移动或复制书籍文件。以后仍可从珍藏中移出。</p>
        {error && <p className="series-review__error" role="alert">{error}</p>}
        <button className="button button--primary series-review__apply" type="button"
          disabled={disabled || selectedBooks.length === 0 || (targetMode === "new" ? !newName.trim() : !targetId || !currentTarget || booksToAdd.length === 0)}
          onClick={() => void apply()}>
          {working ? <><Plus size={17} />正在归类</> : <><Check size={17} />确认加入珍藏</>}
        </button>
      </div>
    </div>
  </section>;
}

function SeriesBookCover({ book }: { book: BookSummary }) {
  return <span className="series-review__cover">
    <GeneratedBookCover book={book} />
    {book.coverUrl && <PublicationCoverImage className="book-cover__image" url={book.coverUrl} alt={`《${book.title}》封面`} loading="lazy" />}
  </span>;
}

function comparableTitle(title: string) {
  return title.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}
