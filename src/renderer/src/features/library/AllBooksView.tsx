import { TransitionPresence } from "../shell/TransitionPresence.js";
import {
  ArrowsDownUp,
  CheckCircle,
  CheckSquare,
  FilePlus,
  FolderPlus,
  GridFour,
  ListBullets,
  PencilSimple,
  Plus,
  SquaresFour,
  Star,
  Trash,
  X,
} from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import type {
  BookSummary,
  CollectionDetails,
  CollectionMembership,
  CollectionSummary,
} from "../../../../shared/contracts.js";
import type { ReaderNoticeModel } from "../../errors/public-error.js";
import { InlineNotice } from "../../components/InlineNotice.js";
import { AddToCollectionsDialog } from "./AddToCollectionsDialog.js";
import { useAllBookPreferences } from "./book-preferences.js";
import { BookTile } from "./BookTile.js";
import {
  filterAndSortBooks,
  type LibraryFilter,
  type LibrarySort,
} from "./library-query.js";
import { ProgressiveBookGrid } from "./ProgressiveBookGrid.js";
import { useShelfViewPreferences } from "./shelf-preferences.js";
import { RemoveBooksDialog } from "./RemoveBooksDialog.js";

type AllBooksViewProps = {
  books: BookSummary[];
  collections: CollectionSummary[];
  query: string;
  visibilityStore?: Map<string, number>;
  busy: boolean;
  notice: ReaderNoticeModel | null;
  onImportFiles(): void;
  onNavigateUnorganized?(): void;
  onOpen(book: BookSummary): void;
  onOpenDetails?(book: BookSummary): void;
  onRemove(bookIds: string[], deleteOriginal?: boolean): Promise<boolean>;
  onBatchSetReadingState?(bookIds: string[], state: "unread" | "finished"): Promise<void>;
  onGetMemberships(bookIds: string[]): Promise<CollectionMembership[]>;
  onCreateCollection(name: string): Promise<CollectionDetails>;
  onAddBooksToCollection(collectionId: string, bookIds: string[]): Promise<CollectionDetails>;
};

export function AllBooksView({
  books,
  collections,
  query,
  visibilityStore,
  busy,
  notice,
  onImportFiles,
  onNavigateUnorganized,
  onOpen,
  onOpenDetails,
  onRemove,
  onBatchSetReadingState,
  onGetMemberships,
  onCreateCollection,
  onAddBooksToCollection,
}: AllBooksViewProps) {
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [organizing, setOrganizing] = useState(false);
  // Persisted so leaving and re-entering 全部书籍 keeps the chosen view.
  const {
    displayMode,
    setDisplayMode,
    sort,
    setSort,
    filter,
    setFilter,
    sortDirection,
    setSortDirection,
    formatFilter,
    setFormatFilter,
    pinnedOnly,
    setPinnedOnly,
  } = useShelfViewPreferences();

  const bookPrefs = useAllBookPreferences();
  const pinnedBookIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [id, pref] of Object.entries(bookPrefs)) {
      if (pref.pinned) ids.add(id);
    }
    return ids;
  }, [bookPrefs]);

  const filteredBooks = useMemo(() => {
    return filterAndSortBooks(books, {
      query,
      filter,
      sort,
      formatFilter,
      sortDirection,
      pinnedOnly,
      pinnedBookIds,
    });
  }, [books, filter, formatFilter, pinnedBookIds, pinnedOnly, query, sort, sortDirection]);

  const selectedIds = useMemo(
    () => books.filter((book) => selected.has(book.id)).map((book) => book.id),
    [books, selected],
  );
  const allFilteredSelected = filteredBooks.length > 0
    && filteredBooks.every((book) => selected.has(book.id));

  function toggle(book: BookSummary) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(book.id)) next.delete(book.id);
      else next.add(book.id);
      return next;
    });
  }

  function finishEditing() {
    setSelected(new Set());
    setConfirming(false);
    setOrganizing(false);
    setEditing(false);
  }

  async function confirmRemoval(deleteOriginal: boolean) {
    const succeeded = deleteOriginal
      ? await onRemove(selectedIds, true)
      : await onRemove(selectedIds);
    setConfirming(false);
    if (succeeded) finishEditing();
  }

  return (
    <section className="all-books-view" aria-labelledby="books-title">
      <div className="library-intro">
        <div className="library-intro__row">
          <div>
            <div className="library-page-title"><span className="library-page-index">02</span><h1 id="books-title">全部书籍</h1><span className="library-page-rule" /></div>
            <p>{books.length ? `共 ${books.length} 本本地藏书。` : "把书留在本地，把时间留给阅读。"}</p>
          </div>
          {books.length > 0 && !editing && <div className="library-intro__actions">
            {onNavigateUnorganized && <button className="button" type="button" onClick={onNavigateUnorganized} disabled={busy}>
              <FolderPlus size={18} />整理系列
            </button>}
            <button className="button library-edit-button" type="button" onClick={() => setEditing(true)} disabled={busy}>
              <PencilSimple size={18} />编辑书架
            </button>
          </div>}
        </div>
      </div>

      {notice && <InlineNotice notice={notice} />}

      {books.length > 0 && (
        <div className="library-controls" aria-label="书架显示设置">
          <label>
            <span>排序</span>
            <select value={sort} onChange={(event) => setSort(event.target.value as LibrarySort)}>
              <option value="added-desc">最近加入</option>
              <option value="last-read-desc">最近阅读</option>
              <option value="title">书名</option>
              <option value="author">作者</option>
              <option value="progress-desc">阅读进度</option>
            </select>
          </label>
          <button
            type="button"
            className="library-sort-direction"
            aria-label="切换排序方向"
            aria-pressed={sortDirection === "reverse"}
            title={sortDirection === "reverse" ? "当前为反向排序，点击恢复默认方向" : "点击切换升序/降序"}
            onClick={() => setSortDirection(sortDirection === "reverse" ? "default" : "reverse")}
          >
            <ArrowsDownUp size={16} />
            <span>{sortDirection === "reverse" ? "反向" : "正序"}</span>
          </button>
          <label>
            <span>筛选</span>
            <select value={filter} onChange={(event) => setFilter(event.target.value as LibraryFilter)}>
              <option value="all">全部</option>
              <option value="unread">未读</option>
              <option value="reading">阅读中</option>
              <option value="finished">已读完</option>
              <option value="epub">EPUB</option>
              <option value="txt">TXT</option>
            </select>
          </label>
          <div className="library-quick-filters" role="group" aria-label="格式与星标筛选">
            <button
              type="button"
              className="library-filter-pill"
              aria-pressed={formatFilter === "all"}
              onClick={() => setFormatFilter("all")}
            >
              全部格式
            </button>
            <button
              type="button"
              className="library-filter-pill"
              aria-pressed={formatFilter === "epub"}
              onClick={() => setFormatFilter(formatFilter === "epub" ? "all" : "epub")}
            >
              EPUB
            </button>
            <button
              type="button"
              className="library-filter-pill"
              aria-pressed={formatFilter === "txt"}
              onClick={() => setFormatFilter(formatFilter === "txt" ? "all" : "txt")}
            >
              TXT
            </button>
            <button
              type="button"
              className="library-filter-pill library-filter-pill--star"
              aria-pressed={pinnedOnly}
              onClick={() => setPinnedOnly(!pinnedOnly)}
            >
              <Star size={13} weight={pinnedOnly ? "fill" : "regular"} />
              星标
            </button>
          </div>
          <div className="library-density" role="group" aria-label="显示方式">
            <button type="button" aria-label="舒适封面" aria-pressed={displayMode === "comfortable"} onClick={() => setDisplayMode("comfortable")}>
              <GridFour size={18} />
            </button>
            <button type="button" aria-label="紧凑封面" aria-pressed={displayMode === "compact"} onClick={() => setDisplayMode("compact")}>
              <SquaresFour size={18} />
            </button>
            <button type="button" aria-label="列表" aria-pressed={displayMode === "list"} onClick={() => setDisplayMode("list")}>
              <ListBullets size={18} />
            </button>
          </div>
          <span className="library-controls__result">{filteredBooks.length} 本</span>
        </div>
      )}

      {editing && (
        <div className="library-edit-bar" aria-label="书架编辑工具">
          <span className="library-edit-bar__count"><CheckSquare size={19} weight="duotone" />已选择 {selectedIds.length} 本</span>
          <div className="library-edit-bar__actions">
            <button
              className="button"
              type="button"
              onClick={() => setSelected((current) => {
                const next = new Set(current);
                for (const book of filteredBooks) {
                  if (allFilteredSelected) next.delete(book.id);
                  else next.add(book.id);
                }
                return next;
              })}
              disabled={busy || filteredBooks.length === 0}
            >
              {allFilteredSelected ? "取消全选当前结果" : "全选当前结果"}
            </button>
            {onBatchSetReadingState && (
              <>
                <button
                  className="button"
                  type="button"
                  disabled={busy || selectedIds.length === 0}
                  onClick={() => {
                    void onBatchSetReadingState(selectedIds, "finished").then(() => finishEditing());
                  }}
                >
                  <CheckCircle size={17} />标为已读
                </button>
                <button
                  className="button"
                  type="button"
                  disabled={busy || selectedIds.length === 0}
                  onClick={() => {
                    void onBatchSetReadingState(selectedIds, "unread").then(() => finishEditing());
                  }}
                >
                  重置未读
                </button>
              </>
            )}
            <button className="button" type="button" onClick={() => setOrganizing(true)} disabled={busy || selectedIds.length === 0}>
              <FolderPlus size={17} />加入珍藏
            </button>
            <button className="button button--danger" type="button" onClick={() => setConfirming(true)} disabled={busy || selectedIds.length === 0}>
              <Trash size={17} />移出书架
            </button>
            <button className="button" type="button" onClick={finishEditing} disabled={busy}>
              <X size={17} />完成编辑
            </button>
          </div>
        </div>
      )}

      {filteredBooks.length === 0 ? (
        <div className="empty-library">
          <span className="empty-library__icon" aria-hidden="true"><FilePlus size={32} weight="duotone" /></span>
          <h2>{query ? "没有找到符合条件的书籍" : "把想读的书放在这里"}</h2>
          <p>{query ? "尝试更改搜索关键词" : "支持本地 TXT 与可重排 EPUB。文件保持在原来的位置，不会上传。"}</p>
          {!query && (
            <div className="empty-library__actions">
              <button className="button button--primary" type="button" onClick={onImportFiles} disabled={busy}>
                <Plus size={18} weight="bold" />
                {busy ? "正在导入" : "导入书籍文件"}
              </button>
            </div>
          )}
        </div>
      ) : (
        <ProgressiveBookGrid
          books={filteredBooks}
          mode={displayMode}
          resetKey={`${query}\u0000${filter}\u0000${sort}\u0000${formatFilter}\u0000${sortDirection}\u0000${pinnedOnly}`}
          visibilityStore={visibilityStore}
          renderBook={(book) => (
            <BookTile
              book={book}
              selectionMode={editing}
              selected={selected.has(book.id)}
              showRichMeta={displayMode === "list"}
              onOpen={onOpen}
              onOpenDetails={onOpenDetails}
              onSelect={toggle}
              onLongPress={(pressed) => {
                if (busy || editing) return;
                setSelected(new Set([pressed.id]));
                setEditing(true);
              }}
            />
          )}
        />
      )}

      <TransitionPresence>{confirming && (
        <RemoveBooksDialog
          count={selectedIds.length}
          busy={busy}
          onCancel={() => setConfirming(false)}
          onConfirm={(deleteOriginal) => void confirmRemoval(deleteOriginal)}
        />
      )}</TransitionPresence>

      <TransitionPresence>{organizing && (
        <AddToCollectionsDialog
          bookIds={selectedIds}
          collections={collections}
          busy={busy}
          onGetMemberships={onGetMemberships}
          onCreateCollection={onCreateCollection}
          onAddBooks={onAddBooksToCollection}
          onCancel={() => setOrganizing(false)}
          onDone={finishEditing}
        />
      )}</TransitionPresence>
    </section>
  );
}

