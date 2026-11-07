import { TransitionPresence } from "../shell/TransitionPresence.js";
import { CheckSquare, FolderPlus, GridFour, ListBullets, X } from "@phosphor-icons/react";
import { useMemo, useRef, useState } from "react";
import type {
  BookSummary,
  CollectionDetails,
  CollectionMembership,
  CollectionSummary,
} from "../../../../shared/contracts.js";
import { AddToCollectionsDialog } from "./AddToCollectionsDialog.js";
import { GeneratedBookCover } from "./GeneratedBookCover.js";
import { PublicationCoverImage } from "./PublicationCoverImage.js";
import { BookTile } from "./BookTile.js";
import { ProgressiveBookGrid } from "./ProgressiveBookGrid.js";
import { SeriesReviewPanel } from "./SeriesReviewPanel.js";
import { findSeriesSuggestions, type SeriesSuggestion } from "./series-suggestions.js";

type Props = {
  books: BookSummary[];
  libraryBooks?: BookSummary[];
  collections: CollectionSummary[];
  busy: boolean;
  onOpen(book: BookSummary): void;
  onOpenDetails?(book: BookSummary): void;
  onGetMemberships(bookIds: string[]): Promise<CollectionMembership[]>;
  onGetCollection(collectionId: string): Promise<CollectionDetails>;
  onCreateCollection(name: string): Promise<CollectionDetails>;
  onAddBooksToCollection(collectionId: string, bookIds: string[]): Promise<CollectionDetails>;
};

export function UncategorizedPage({
  books,
  libraryBooks = books,
  collections,
  busy,
  onOpen,
  onOpenDetails,
  onGetMemberships,
  onGetCollection,
  onCreateCollection,
  onAddBooksToCollection,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [organizing, setOrganizing] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reviewing, setReviewing] = useState<SeriesSuggestion | null>(null);
  const [visibleSuggestions, setVisibleSuggestions] = useState(12);
  const [query, setQuery] = useState("");
  const [displayMode, setDisplayMode] = useState<"list" | "comfortable">("list");
  const manualSectionRef = useRef<HTMLDivElement>(null);
  const suggestions = useMemo(() => findSeriesSuggestions(books, collections), [books, collections]);
  const filteredBooks = useMemo(() => {
    const needle = query.normalize("NFKC").trim().toLocaleLowerCase();
    if (!needle) return books;
    return books.filter((book) => book.title.normalize("NFKC").toLocaleLowerCase().includes(needle)
      || book.author?.normalize("NFKC").toLocaleLowerCase().includes(needle));
  }, [books, query]);
  const bookById = useMemo(() => new Map(books.map((book) => [book.id, book])), [books]);
  const filteredSuggestions = useMemo(() => {
    const needle = query.normalize("NFKC").trim().toLocaleLowerCase();
    if (!needle) return suggestions;
    return suggestions.filter((suggestion) =>
      suggestion.name.normalize("NFKC").toLocaleLowerCase().includes(needle)
      || suggestion.bookIds.some((id) => bookById.get(id)?.title.normalize("NFKC").toLocaleLowerCase().includes(needle))
      || collections.some((collection) => collection.id === suggestion.targetCollectionId
        && collection.name.normalize("NFKC").toLocaleLowerCase().includes(needle)));
  }, [bookById, collections, query, suggestions]);
  const selectedIds = useMemo(
    () => books.filter((book) => selected.has(book.id)).map((book) => book.id),
    [books, selected],
  );

  function finish() {
    setSelected(new Set());
    setOrganizing(false);
    setEditing(false);
  }

  return (
    <section className="unorganized-page" aria-labelledby="unorganized-title">
      <header className="collections-page__header">
        <div>
          <div className="library-page-title"><span className="library-page-index">04</span><h1 id="unorganized-title">未整理</h1><span className="library-page-rule" /></div>
          <p>{books.length ? `${books.length} 本书尚未加入任何珍藏。` : "所有书籍都已经有了归处。"}</p>
        </div>
        {books.length > 0 && !editing && !reviewing && (
          <button className="button" type="button" onClick={() => { setEditing(true); manualSectionRef.current?.scrollIntoView?.({ block: "start" }); }}>整理书籍</button>
        )}
      </header>

      {books.length > 0 && !reviewing && <div className="unorganized-filter">
        <label><span>查找书籍或系列</span><input type="search" aria-label="筛选未整理书籍" placeholder="输入书名、作者或系列名" value={query} onChange={(event) => { setQuery(event.target.value); setVisibleSuggestions(12); }} /></label>
        <span>找到 {filteredBooks.length} 本书 · {filteredSuggestions.length} 组系列建议</span>
      </div>}

      {books.length > 0 && (reviewing ? <SeriesReviewPanel
        key={reviewing.key}
        suggestion={reviewing}
        libraryBooks={libraryBooks}
        collections={collections}
        busy={busy}
        onCreateCollection={onCreateCollection}
        onGetCollection={onGetCollection}
        onAddBooksToCollection={onAddBooksToCollection}
        onCancel={() => setReviewing(null)}
        onDone={() => { setReviewing(null); finish(); }}
      /> : <section className="series-suggestions" aria-label="系列归类建议">
        <div className="series-suggestions__heading">
          <div><h2>可能属于同一系列</h2><p>先检查每组书，再决定补进旧珍藏或新建珍藏。</p></div>
          <span>{filteredSuggestions.length} 组建议</span>
        </div>
        {filteredSuggestions.length === 0 ? <p className="series-suggestions__empty">{query ? "没有匹配的系列建议，可在下方逐本选择。" : "暂时没有明确的卷号线索。下方仍可手动多选书籍归类。"}</p>
          : <>
            <div className="series-suggestions__list">
              {filteredSuggestions.slice(0, visibleSuggestions).map((suggestion) => {
                const target = collections.find((collection) => collection.id === suggestion.targetCollectionId);
                const preview = bookById.get(suggestion.bookIds[0]);
                return <article className="series-suggestion" key={suggestion.key}>
                  <span className="series-suggestion__cover" aria-hidden="true">{preview && <><GeneratedBookCover book={preview} />{preview.coverUrl && <PublicationCoverImage url={preview.coverUrl} alt="" loading="lazy" className="series-suggestion__image" />}</>}</span>
                  <div className="series-suggestion__info">
                    <strong>{suggestion.name}</strong>
                    <div className="series-suggestion__meta"><span>{suggestion.bookIds.length} 本待整理</span><span>{target ? `补入已有珍藏《${target.name}》` : "可新建珍藏"}</span></div>
                    <p>{suggestion.bookIds.slice(0, 3).map((id) => bookById.get(id)?.title).filter(Boolean).join("、")}</p>
                  </div>
                  <button className="button" type="button" aria-label={`检查系列《${suggestion.name}》`} onClick={() => { finish(); setReviewing(suggestion); }}>检查并归类</button>
                </article>;
              })}
            </div>
            {visibleSuggestions < filteredSuggestions.length && <button className="button series-suggestions__more" type="button" onClick={() => setVisibleSuggestions((count) => count + 12)}>显示更多系列</button>}
          </>}
      </section>)}

      {!reviewing && books.length > 0 && <div className="unorganized-library-heading" ref={manualSectionRef}>
        <div><h2>逐本整理</h2><p>系列建议不准确时，在这里手动选择书籍。</p></div>
        <div className="unorganized-library-heading__controls">
          <span>{filteredBooks.length} 本</span>
          <div className="library-density" role="group" aria-label="未整理书籍显示方式">
            <button type="button" aria-label="列表显示" aria-pressed={displayMode === "list"} onClick={() => setDisplayMode("list")}><ListBullets size={18} /></button>
            <button type="button" aria-label="封面显示" aria-pressed={displayMode === "comfortable"} onClick={() => setDisplayMode("comfortable")}><GridFour size={18} /></button>
          </div>
        </div>
      </div>}

      {!reviewing && editing && (
        <div className="library-edit-bar" aria-label="未整理书籍编辑工具">
          <span className="library-edit-bar__count"><CheckSquare size={19} />已选择 {selectedIds.length} 本</span>
          <div className="library-edit-bar__actions">
            <button className="button" type="button" disabled={filteredBooks.length === 0} onClick={() => setSelected((current) => {
              const next = new Set(current);
              const allSelected = filteredBooks.every((book) => next.has(book.id));
              for (const book of filteredBooks) {
                if (allSelected) next.delete(book.id);
                else next.add(book.id);
              }
              return next;
            })}>全选当前结果</button>
            <button className="button" type="button" onClick={() => setOrganizing(true)} disabled={busy || selectedIds.length === 0}>
              <FolderPlus size={17} />加入珍藏
            </button>
            <button className="button" type="button" onClick={finish}><X size={17} />完成</button>
          </div>
        </div>
      )}

      {!reviewing && (books.length === 0 ? (
        <div className="collections-empty collections-empty--small">
          <h2>书架已经整理完毕</h2>
          <p>从某本书的最后一个珍藏中移除后，它会重新出现在这里。</p>
        </div>
      ) : filteredBooks.length === 0 ? <p className="series-suggestions__empty">没有符合条件的书籍，请换个关键词。</p> : (
        <ProgressiveBookGrid
          books={filteredBooks}
          mode={displayMode}
          resetKey={`unorganized:${query}:${filteredBooks.map((book) => book.id).join(",")}`}
          renderBook={(book) => (
            <BookTile
              book={book}
              selectionMode={editing}
              selected={selected.has(book.id)}
              showRichMeta={displayMode === "list"}
              onOpen={onOpen}
              onOpenDetails={onOpenDetails}
              onSelect={() => setSelected((current) => {
                const next = new Set(current);
                if (next.has(book.id)) next.delete(book.id);
                else next.add(book.id);
                return next;
              })}
            />
          )}
        />
      ))}

      <TransitionPresence>{organizing && (
        <AddToCollectionsDialog
          bookIds={selectedIds}
          collections={collections}
          busy={busy}
          onGetMemberships={onGetMemberships}
          onCreateCollection={onCreateCollection}
          onAddBooks={onAddBooksToCollection}
          onCancel={() => setOrganizing(false)}
          onDone={finish}
        />
      )}</TransitionPresence>
    </section>
  );
}
