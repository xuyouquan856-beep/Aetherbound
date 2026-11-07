import { CrystalAppearanceSettings } from "./CrystalAppearanceSettings.js";
import { crystalStyle, useCrystalAppearance } from "./crystal-preferences.js";
import { TransitionPresence } from "../shell/TransitionPresence.js";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
   BookOpen,
  DotsSixVertical,
  FolderPlus,
  GridFour,
  ListNumbers,
  PencilSimple,
  Plus,
  SortAscending,
  Trash,
  X,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  BookSummary,
  CollectionDetails,
} from "../../../../shared/contracts.js";
import { BookTile } from "./BookTile.js";
import { CollectionEditorDialog } from "./CollectionEditorDialog.js";
import {
  DefaultCoverPrewarmOptions,
  prewarmCoverImages,
} from "./cover-image-cache.js";
import { suggestCollectionAdditions } from "./series-suggestions.js";

const VolumeCollator = new Intl.Collator("zh-CN", {
  numeric: true,
  sensitivity: "base",
});

type Props = {
  collectionId: string;
  libraryBooks: BookSummary[];
  busy: boolean;
  onGet(id: string): Promise<CollectionDetails>;
  onRename(id: string, name: string): Promise<CollectionDetails>;
  onDelete(id: string): Promise<void>;
  onAddBooks(id: string, bookIds: string[]): Promise<CollectionDetails>;
  onRemoveBooks(id: string, bookIds: string[]): Promise<CollectionDetails>;
  onReorder(id: string, bookIds: string[]): Promise<CollectionDetails>;
  onImportFolder?(id: string): Promise<{ status: string }>;
  onImportFiles?(id: string): Promise<{ status: string }>;
  onOpen(book: BookSummary): void;
  onOpenDetails?(book: BookSummary): void;
  onBack(): void;
  onDeleted(): void;
  onChanged(): Promise<void>;
};

export function CollectionDetailPage({
  collectionId,
  libraryBooks,
  busy,
  onGet,
  onRename,
  onDelete,
  onAddBooks,
  onRemoveBooks,
  onReorder,
  onImportFolder,
  onImportFiles,
  onOpen,
  onOpenDetails,
  onBack,
  onDeleted,
  onChanged,
}: Props) {
  const { appearance: crystalAppearance } = useCrystalAppearance(collectionId);
  const [colorOpen, setColorOpen] = useState(false);
  const [collection, setCollection] = useState<CollectionDetails | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [selectedToAdd, setSelectedToAdd] = useState<Set<string>>(new Set());
  const [addingQuery, setAddingQuery] = useState("");
  const [showAllAdditions, setShowAllAdditions] = useState(false);
  const [addingVisibleCount, setAddingVisibleCount] = useState(100);
  const [managing, setManaging] = useState(false);
  const [viewMode, setViewMode] = useState<"list" | "grid">("list");
  const [selectedToRemove, setSelectedToRemove] = useState<Set<string>>(new Set());
  const [memberQuery, setMemberQuery] = useState("");
  const [working, setWorking] = useState(false);
  const [warmedCoverKey, setWarmedCoverKey] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(80);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; after: boolean } | null>(null);
  const dragSource = useRef<string | null>(null);
  const listSentinel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let current = true;
    setCollection(null);
    setWarmedCoverKey(null);
    setVisibleCount(80);
    onGet(collectionId).then((value) => current && setCollection(value));
    return () => {
      current = false;
    };
  }, [collectionId, onGet]);

  const availableToAdd = useMemo(() => {
    const members = new Set(collection?.books.map((book) => book.id) ?? []);
    return libraryBooks.filter((book) => !members.has(book.id));
  }, [collection, libraryBooks]);
  const suggestedToAdd = useMemo(() => collection
    ? new Set(suggestCollectionAdditions(collection, libraryBooks))
    : new Set<string>(), [collection, libraryBooks]);
  const filteredToAdd = useMemo(() => {
    const needle = addingQuery.normalize("NFKC").trim().toLocaleLowerCase();
    return availableToAdd.filter((book) => {
      if (needle) return book.title.normalize("NFKC").toLocaleLowerCase().includes(needle)
        || book.author?.normalize("NFKC").toLocaleLowerCase().includes(needle);
      return showAllAdditions || suggestedToAdd.size === 0 || suggestedToAdd.has(book.id);
    });
  }, [addingQuery, availableToAdd, showAllAdditions, suggestedToAdd]);

  const memberBooks = useMemo(() => {
    if (!collection) return [];
    const currentBooks = new Map(libraryBooks.map((book) => [book.id, book]));
    return collection.books.map((book) => currentBooks.get(book.id) ?? book);
  }, [collection, libraryBooks]);
  const indexedMembers = useMemo(() => {
    const needle = memberQuery.normalize("NFKC").trim().toLocaleLowerCase();
    return memberBooks.map((book, index) => ({ book, index })).filter(({ book }) =>
      !needle || book.title.normalize("NFKC").toLocaleLowerCase().includes(needle)
        || book.author?.normalize("NFKC").toLocaleLowerCase().includes(needle));
  }, [memberBooks, memberQuery]);
  const hasMoreBooks = visibleCount < indexedMembers.length;

  const collectionStats = useMemo(() => {
    if (memberBooks.length === 0) {
      return { finishedCount: 0, avgPercent: 0, nextBook: null as BookSummary | null };
    }
    const finishedCount = memberBooks.filter((b) => b.progress >= 0.995).length;
    const totalProgress = memberBooks.reduce((sum, b) => sum + b.progress, 0);
    const avgPercent = Math.round((totalProgress / memberBooks.length) * 100);
    const available = memberBooks.filter((b) => b.availabilityStatus === "available");
    const inProgress = available.find((b) => b.progress > 0 && b.progress < 0.995);
    const firstUnread = available.find((b) => b.progress < 0.995);
    return {
      finishedCount,
      avgPercent,
      nextBook: inProgress ?? firstUnread ?? available[0] ?? null,
    };
  }, [memberBooks]);

  useEffect(() => {
    if (!hasMoreBooks || !listSentinel.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisibleCount((current) => Math.min(current + 80, indexedMembers.length));
      }
    }, { rootMargin: "320px 0px" });
    observer.observe(listSentinel.current);
    return () => observer.disconnect();
  }, [hasMoreBooks, indexedMembers.length, visibleCount]);

  const coverUrls = useMemo(() => memberBooks
    .map((book) => book.coverUrl)
    .filter((url): url is string => Boolean(url))
    .slice(0, DefaultCoverPrewarmOptions.limit), [memberBooks]);
  const coverKey = coverUrls.join("\n");

  useEffect(() => {
    if (!collection) return;
    let current = true;
    setWarmedCoverKey((value) => value === coverKey ? value : null);
    void prewarmCoverImages(coverUrls, DefaultCoverPrewarmOptions)
      .finally(() => {
        if (current) setWarmedCoverKey(coverKey);
      });
    return () => {
      current = false;
    };
  }, [collection, coverKey]);

  async function apply(
    operation: () => Promise<CollectionDetails>,
  ) {
    setWorking(true);
    try {
      setCollection(await operation());
      await onChanged();
    } finally {
      setWorking(false);
    }
  }

  async function rename(name: string) {
    await apply(() => onRename(collectionId, name));
    setRenaming(false);
  }

  async function addSelected() {
    const ids = availableToAdd
      .filter((book) => selectedToAdd.has(book.id))
      .map((book) => book.id);
    if (ids.length === 0) return;
    await apply(() => onAddBooks(collectionId, ids));
    setSelectedToAdd(new Set());
    setAdding(false);
  }

  async function move(index: number, offset: -1 | 1) {
    if (!collection) return;
    const target = index + offset;
    if (target < 0 || target >= collection.books.length) return;
    const ids = collection.books.map((book) => book.id);
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    await apply(() => onReorder(collectionId, ids));
  }

  async function autoSortByVolume() {
    if (!collection || memberBooks.length < 2) return;
    const sortedIds = [...memberBooks]
      .sort((left, right) => VolumeCollator.compare(left.title, right.title) || left.id.localeCompare(right.id))
      .map((book) => book.id);
    if (sortedIds.every((id, idx) => id === collection.books[idx]?.id)) return;
    await apply(() => onReorder(collectionId, sortedIds));
  }

  function finishDrag() {
    dragSource.current = null;
    setDraggingId(null);
    setDropTarget(null);
  }

  async function dropBook(targetId: string, after: boolean) {
    const sourceId = dragSource.current;
    finishDrag();
    if (!collection || !sourceId || sourceId === targetId) return;
    const ids = collection.books.map((book) => book.id);
    const sourceIndex = ids.indexOf(sourceId);
    if (sourceIndex < 0) return;
    ids.splice(sourceIndex, 1);
    const targetIndex = ids.indexOf(targetId);
    if (targetIndex < 0) return;
    ids.splice(targetIndex + (after ? 1 : 0), 0, sourceId);
    if (ids.every((id, index) => id === collection.books[index]?.id)) return;
    await apply(() => onReorder(collectionId, ids));
  }

  async function remove(bookId: string) {
    await apply(() => onRemoveBooks(collectionId, [bookId]));
  }

  async function removeSelected() {
    if (!collection) return;
    const ids = collection.books.filter((book) => selectedToRemove.has(book.id)).map((book) => book.id);
    if (ids.length === 0) return;
    await apply(() => onRemoveBooks(collectionId, ids));
    setSelectedToRemove(new Set());
    setManaging(false);
    setMemberQuery("");
  }

  function openAddBooks() {
    setSelectedToAdd(new Set());
    setAddingQuery("");
    setShowAllAdditions(false);
    setAddingVisibleCount(100);
    setAdding(true);
  }

  async function appendFolder() {
    if (!onImportFolder) return;
    setWorking(true);
    try {
      const result = await onImportFolder(collectionId);
      if (result.status === "completed") setCollection(await onGet(collectionId));
    } catch {
      // App presents the import error in the shared notice.
    } finally {
      setWorking(false);
    }
  }

  async function appendFiles() {
    if (!onImportFiles) return;
    setWorking(true);
    try {
      const result = await onImportFiles(collectionId);
      if (result.status === "completed") setCollection(await onGet(collectionId));
    } catch {
      // App presents the import error in the shared notice.
    } finally {
      setWorking(false);
    }
  }

  async function confirmDelete() {
    setWorking(true);
    try {
      await onDelete(collectionId);
      await onChanged();
      onDeleted();
    } finally {
      setWorking(false);
    }
  }

  if (!collection || warmedCoverKey !== coverKey) {
    return <section className="collection-detail" aria-label="正在载入珍藏"><div className="skeleton skeleton--heading" /></section>;
  }

  const disabled = busy || working;

  return (
    <section className="collection-detail" aria-labelledby="collection-detail-title" style={crystalStyle(crystalAppearance)}>
      <header className="collection-detail__header">
        <button className="button" type="button" onClick={onBack}><ArrowLeft size={17} />返回</button>
        <div className="collection-detail__identity">
          <span className="collection-detail__kicker">珍藏详情</span>
          <h1 id="collection-detail-title">{collection.name}</h1>
          <p>
            {memberBooks.length} 本书，按你设定的顺序排列
            {memberBooks.length > 0 && ` · 已读完 ${collectionStats.finishedCount} / ${memberBooks.length} 本（总进度 ${collectionStats.avgPercent}%）`}
          </p>
          {memberBooks.length > 0 && (
            <div className="collection-detail__progress-bar" aria-hidden="true">
              <span style={{ width: `${collectionStats.avgPercent}%` }} />
            </div>
          )}
        </div>
        <div className="collection-detail__header-actions">
          {collectionStats.nextBook && (
            <button
              className="button button--primary"
              type="button"
              onClick={() => onOpen(collectionStats.nextBook!)}
              disabled={disabled}
            >
              <BookOpen size={17} />
              继续阅读《{collectionStats.nextBook.title}》
            </button>
          )}
          <button className="button" type="button" aria-expanded={colorOpen} onClick={() => setColorOpen(!colorOpen)}>珍藏配色</button>
          {onImportFiles && (
            <button className={`button ${!collectionStats.nextBook ? "button--primary" : ""}`} type="button" onClick={() => void appendFiles()} disabled={disabled}>
              <Plus size={17} />追加书籍文件
            </button>
          )}
          {onImportFolder && (
            <button className="button" type="button" onClick={() => void appendFolder()} disabled={disabled}>
              <FolderPlus size={17} />追加导入文件夹
            </button>
          )}
          <button className="button" type="button" onClick={() => setRenaming(true)} disabled={disabled}>
            <PencilSimple size={17} />重命名
          </button>
          <button className="button" type="button" onClick={openAddBooks} disabled={disabled || availableToAdd.length === 0}>
            <Plus size={17} />添加书籍
          </button>
          {memberBooks.length > 1 && (
            <button className="button" type="button" onClick={() => void autoSortByVolume()} disabled={disabled}>
              <SortAscending size={17} />按卷号排序
            </button>
          )}
          {memberBooks.length > 0 && (
            <div className="library-density" role="group" aria-label="珍藏视图模式">
              <button
                type="button"
                aria-label="排序列表视图"
                aria-pressed={viewMode === "list"}
                onClick={() => setViewMode("list")}
                title="排序列表视图"
              >
                <ListNumbers size={18} />
              </button>
              <button
                type="button"
                aria-label="网格封面视图"
                aria-pressed={viewMode === "grid"}
                onClick={() => setViewMode("grid")}
                title="网格封面视图"
              >
                <GridFour size={18} />
              </button>
            </div>
          )}
          {memberBooks.length > 0 && <button className="button" type="button" aria-pressed={managing} onClick={() => {
            setManaging((current) => !current);
            setSelectedToRemove(new Set());
            setMemberQuery("");
          }} disabled={disabled}>管理珍藏书籍</button>}
          <button className="button button--danger-outline" type="button" onClick={() => setDeleting(true)} disabled={disabled}>
            <Trash size={17} />删除珍藏
          </button>
        </div>
      </header>

      {colorOpen && <CrystalAppearanceSettings collectionId={collectionId} books={memberBooks} />}
      {managing && <div className="collection-manage-bar" aria-label="珍藏书籍管理工具">
        <label>筛选珍藏书籍<input type="search" aria-label="筛选珍藏书籍" placeholder="搜索书名或作者" value={memberQuery} onChange={(event) => { setMemberQuery(event.target.value); setVisibleCount(80); }} /></label>
        <span>已选择 {selectedToRemove.size} 本</span>
        {memberBooks.length > 1 && (
          <button className="button" type="button" onClick={() => void autoSortByVolume()} disabled={disabled}>
            <SortAscending size={16} />按书名卷号自动排序
          </button>
        )}
        <button className="button" type="button" onClick={() => setSelectedToRemove((current) => {
          const next = new Set(current);
          const ids = indexedMembers.map(({ book }) => book.id);
          const allSelected = ids.length > 0 && ids.every((id) => next.has(id));
          for (const id of ids) {
            if (allSelected) next.delete(id);
            else next.add(id);
          }
          return next;
        })} disabled={disabled || indexedMembers.length === 0}>全选或取消当前结果</button>
        <button className="button button--danger-outline" type="button" disabled={disabled || selectedToRemove.size === 0} onClick={() => void removeSelected()}>从珍藏移出所选</button>
        <small>只移出珍藏，不删除书籍。</small>
      </div>}

      {memberBooks.length === 0 ? (
        <div className="collection-detail__empty">
          <h2>这个珍藏还是空的</h2>
          <p>从全部书籍批量加入，或使用上方“添加书籍”。</p>
        </div>
      ) : indexedMembers.length === 0 ? <p className="collection-detail__empty">没有符合筛选条件的书籍。</p> : viewMode === "grid" && !managing ? (
        <div className="book-grid book-grid--comfortable collection-book-grid" aria-label="珍藏书籍网格">
          {indexedMembers.slice(0, visibleCount).map(({ book, index }) => (
            <div key={book.id} className="collection-grid-item">
              <span className="collection-grid-item__badge">#{index + 1}</span>
              <BookTile book={book} onOpen={onOpen} onOpenDetails={onOpenDetails} />
            </div>
          ))}
        </div>
      ) : (
        <ol className="collection-book-list" data-managing={managing} aria-label="珍藏书籍">
          {indexedMembers.slice(0, visibleCount).map(({ book, index }) => (
            <li key={book.id}
              data-dragging={draggingId === book.id}
              data-drop-position={dropTarget?.id === book.id ? (dropTarget.after ? "after" : "before") : undefined}
              onDragOver={(event) => {
                if (!dragSource.current || dragSource.current === book.id || disabled) return;
                event.preventDefault();
                const bounds = event.currentTarget.getBoundingClientRect();
                const after = event.clientY > bounds.top + bounds.height / 2;
                setDropTarget((current) => current?.id === book.id && current.after === after ? current : { id: book.id, after });
              }}
              onDrop={(event) => {
                event.preventDefault();
                const bounds = event.currentTarget.getBoundingClientRect();
                void dropBook(book.id, event.clientY > bounds.top + bounds.height / 2);
              }}>
              {managing && <input type="checkbox" className="collection-book-list__select" aria-label={`选择《${book.title}》`} checked={selectedToRemove.has(book.id)} onChange={() => setSelectedToRemove((current) => {
                const next = new Set(current);
                if (next.has(book.id)) next.delete(book.id);
                else next.add(book.id);
                return next;
              })} />}
              <button className="collection-book-list__drag" type="button" draggable={!disabled}
                aria-label={`拖动排序《${book.title}》`} title="拖动调整顺序"
                disabled={disabled}
                onDragStart={(event) => {
                  dragSource.current = book.id;
                  setDraggingId(book.id);
                  event.dataTransfer?.setData("text/plain", book.id);
                  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
                }}
                onDragEnd={finishDrag}><DotsSixVertical size={20} /></button>
              <span className="collection-book-list__position">{index + 1}</span>
              <div className="collection-book-list__book"><BookTile book={book} onOpen={onOpen} onOpenDetails={onOpenDetails} /></div>
              <div className="collection-book-list__actions">
                <button className="icon-button" type="button" aria-label={`上移《${book.title}》`} disabled={disabled || index === 0} onClick={() => void move(index, -1)}>
                  <ArrowUp size={18} />
                </button>
                <button className="icon-button" type="button" aria-label={`下移《${book.title}》`} disabled={disabled || index === memberBooks.length - 1} onClick={() => void move(index, 1)}>
                  <ArrowDown size={18} />
                </button>
                <button className="icon-button icon-button--danger" type="button" aria-label={`从珍藏移除《${book.title}》`} disabled={disabled} onClick={() => void remove(book.id)}>
                  <X size={18} />
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}
      {hasMoreBooks && <div className="collection-detail__more" ref={listSentinel}>
        <button className="button" type="button" onClick={() => setVisibleCount((current) => Math.min(current + 80, indexedMembers.length))}>继续加载珍藏书籍</button>
      </div>}

      <TransitionPresence>{renaming && (
        <CollectionEditorDialog
          mode="rename"
          initialName={collection.name}
          busy={disabled}
          onSave={rename}
          onCancel={() => setRenaming(false)}
        />
      )}</TransitionPresence>

      <TransitionPresence>{adding && (
        <div className="modal-backdrop" role="presentation">
          <section className="collection-add-dialog" role="dialog" aria-modal="true" aria-labelledby="collection-add-title">
            <header>
              <h2 id="collection-add-title">添加书籍</h2>
              <p>先看可能同系列的书，也可以搜索全部书籍。勾选后才会加入《{collection.name}》。</p>
            </header>
            <div className="collection-add-dialog__toolbar">
              <input type="search" aria-label="搜索可添加书籍" placeholder="搜索书名或作者" value={addingQuery} onChange={(event) => { setAddingQuery(event.target.value); setAddingVisibleCount(100); }} />
              {!addingQuery && suggestedToAdd.size > 0 && <div role="group" aria-label="添加书籍范围">
                <button type="button" aria-pressed={!showAllAdditions} onClick={() => setShowAllAdditions(false)}>同系列建议（{suggestedToAdd.size}）</button>
                <button type="button" aria-pressed={showAllAdditions} onClick={() => setShowAllAdditions(true)}>全部书籍</button>
              </div>}
              <span>找到 {filteredToAdd.length} 本 · 已选择 {selectedToAdd.size} 本</span>
              <button type="button" disabled={filteredToAdd.length === 0} onClick={() => setSelectedToAdd((current) => {
                const next = new Set(current);
                const allSelected = filteredToAdd.every((book) => next.has(book.id));
                for (const book of filteredToAdd) {
                  if (allSelected) next.delete(book.id);
                  else next.add(book.id);
                }
                return next;
              })}>全选或取消当前结果</button>
            </div>
            <div className="collection-add-dialog__list">
              {filteredToAdd.slice(0, addingVisibleCount).map((book) => (
                <label key={book.id}>
                  <input
                    type="checkbox"
                    checked={selectedToAdd.has(book.id)}
                    onChange={() => setSelectedToAdd((current) => {
                      const next = new Set(current);
                      if (next.has(book.id)) next.delete(book.id);
                      else next.add(book.id);
                      return next;
                    })}
                  />
                  <span>{book.title}</span>
                </label>
              ))}
              {filteredToAdd.length > addingVisibleCount && <button className="button" type="button" onClick={() => setAddingVisibleCount((count) => count + 100)}>显示更多书籍</button>}
            </div>
            <footer>
              <button className="button" type="button" onClick={() => setAdding(false)} disabled={disabled}>取消</button>
              <button className="button button--primary" type="button" onClick={() => void addSelected()} disabled={disabled || selectedToAdd.size === 0}>加入所选书籍</button>
            </footer>
          </section>
        </div>
      )}</TransitionPresence>

      <TransitionPresence>{deleting && (
        <div className="modal-backdrop" role="presentation">
          <section className="confirmation-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-collection-title">
            <div className="confirmation-dialog__icon" aria-hidden="true"><Trash size={22} /></div>
            <div className="confirmation-dialog__copy">
              <h2 id="delete-collection-title">确认删除珍藏</h2>
              <p>只会删除《{collection.name}》这个分组及其归组关系。</p>
              <p>书籍与原文件不会删除</p>
            </div>
            <div className="confirmation-dialog__actions">
              <button className="button" type="button" onClick={() => setDeleting(false)} disabled={disabled}>取消</button>
              <button className="button button--danger" type="button" onClick={() => void confirmDelete()} disabled={disabled}>确认删除</button>
            </div>
          </section>
        </div>
      )}</TransitionPresence>
    </section>
  );
}
