import {
  ArrowCounterClockwise,
  Bookmarks,
  BookOpen,
  CheckCircle,
  DownloadSimple,
  FolderOpen,
  FolderPlus,
  NotePencil,
  Palette,
  Star,
  Trash,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import type {
  BookSummary,
  CollectionDetails,
  CollectionMembership,
  CollectionSummary,
  ReadingLocationV1,
} from "../../../../shared/contracts.js";
import type { ReadingRecord, ReadingRecordsApi } from "../../../../shared/reading-records.js";
import {
  setBookCoverTone,
  toggleBookPinned,
  useBookPreference,
} from "./book-preferences.js";
import { CoverPalettes, GeneratedBookCover } from "./GeneratedBookCover.js";
import { PublicationCoverImage } from "./PublicationCoverImage.js";

type Props = {
  book: BookSummary;
  collections: CollectionSummary[];
  recordsApi?: ReadingRecordsApi;
  busy?: boolean;
  onClose(): void;
  onOpen(book: BookSummary, location?: ReadingLocationV1 | null): void;
  onUpdateMetadata?(input: { bookId: string; title: string; author: string | null }): Promise<BookSummary | null>;
  onSetReadingState?(input: { bookId: string; state: "unread" | "finished" }): Promise<BookSummary | null>;
  onRevealInFolder?(bookId: string): Promise<boolean>;
  onRelocate?(bookId: string): Promise<BookSummary | null>;
  onGetMemberships?(bookIds: string[]): Promise<CollectionMembership[]>;
  onCreateCollection?(name: string): Promise<CollectionDetails>;
  onAddBooksToCollection?(collectionId: string, bookIds: string[]): Promise<CollectionDetails>;
  onRemoveBooksFromCollection?(collectionId: string, bookIds: string[]): Promise<CollectionDetails>;
  onRequestRemove?(book: BookSummary): void;
};

function formatDateTime(iso: string | null): string {
  if (!iso) return "从未阅读";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function kindLabel(kind: ReadingRecord["kind"]): string {
  if (kind === "bookmark") return "书签";
  if (kind === "highlight") return "划线";
  if (kind === "note") return "笔记";
  return "摘录";
}

function downloadMarkdown(filename: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/markdown;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function BookDetailsDialog({
  book,
  collections,
  recordsApi,
  busy = false,
  onClose,
  onOpen,
  onUpdateMetadata,
  onSetReadingState,
  onRevealInFolder,
  onRelocate,
  onGetMemberships,
  onCreateCollection,
  onAddBooksToCollection,
  onRemoveBooksFromCollection,
  onRequestRemove,
}: Props) {
  const pref = useBookPreference(book.id);
  const pinned = Boolean(pref.pinned);
  const [title, setTitle] = useState(book.title);
  const [author, setAuthor] = useState(book.author ?? "");
  const [savingMeta, setSavingMeta] = useState(false);
  const [updatingState, setUpdatingState] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [memberCollectionIds, setMemberCollectionIds] = useState<Set<string>>(new Set());
  const [loadingMemberships, setLoadingMemberships] = useState(false);
  const [newCollectionName, setNewCollectionName] = useState("");
  const [records, setRecords] = useState<ReadingRecord[]>([]);
  const [loadingRecords, setLoadingRecords] = useState(false);

  useEffect(() => {
    setTitle(book.title);
    setAuthor(book.author ?? "");
  }, [book.id, book.title, book.author]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (!onGetMemberships) return;
    let alive = true;
    setLoadingMemberships(true);
    onGetMemberships([book.id])
      .then((list) => {
        if (!alive) return;
        const next = new Set<string>();
        for (const item of list) {
          if (item.bookIds.includes(book.id)) next.add(item.collectionId);
        }
        setMemberCollectionIds(next);
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive) setLoadingMemberships(false);
      });
    return () => {
      alive = false;
    };
  }, [book.id, onGetMemberships]);

  useEffect(() => {
    if (!recordsApi) return;
    let alive = true;
    setLoadingRecords(true);
    recordsApi
      .list({ bookId: book.id })
      .then((items) => {
        if (alive) setRecords(items);
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive) setLoadingRecords(false);
      });
    return () => {
      alive = false;
    };
  }, [book.id, recordsApi]);

  const progressPercent = Math.round(book.progress * 100);
  const readingStatusText = book.progress >= 0.995
    ? "已读完"
    : book.progress > 0
      ? `阅读中 · ${progressPercent}%`
      : "未读";

  const recordCounts = useMemo(() => {
    const counts = { bookmark: 0, highlight: 0, note: 0, quote: 0 };
    for (const r of records) {
      counts[r.kind] = (counts[r.kind] ?? 0) + 1;
    }
    return counts;
  }, [records]);

  const metadataChanged = title.trim() !== book.title || (author.trim() || null) !== (book.author || null);

  async function handleSaveMetadata(event: React.FormEvent) {
    event.preventDefault();
    if (!onUpdateMetadata || !title.trim()) return;
    setSavingMeta(true);
    setStatusMessage(null);
    try {
      await onUpdateMetadata({
        bookId: book.id,
        title: title.trim(),
        author: author.trim() || null,
      });
      setStatusMessage("书目信息已保存");
    } catch {
      setStatusMessage("保存书目信息失败");
    } finally {
      setSavingMeta(false);
    }
  }

  async function handleSetReadingState(state: "unread" | "finished") {
    if (!onSetReadingState) return;
    setUpdatingState(true);
    setStatusMessage(null);
    try {
      await onSetReadingState({ bookId: book.id, state });
      setStatusMessage(state === "finished" ? "已标记为已读完" : "已重置为未读状态");
    } catch {
      setStatusMessage("更新阅读状态失败");
    } finally {
      setUpdatingState(false);
    }
  }

  async function handleToggleCollection(collectionId: string) {
    const isMember = memberCollectionIds.has(collectionId);
    try {
      if (isMember) {
        if (!onRemoveBooksFromCollection) return;
        await onRemoveBooksFromCollection(collectionId, [book.id]);
        setMemberCollectionIds((prev) => {
          const next = new Set(prev);
          next.delete(collectionId);
          return next;
        });
      } else {
        if (!onAddBooksToCollection) return;
        await onAddBooksToCollection(collectionId, [book.id]);
        setMemberCollectionIds((prev) => new Set(prev).add(collectionId));
      }
    } catch {
      setStatusMessage("更新珍藏归属失败");
    }
  }

  async function handleCreateAndAddCollection() {
    const trimmed = newCollectionName.trim();
    if (!trimmed || !onCreateCollection || !onAddBooksToCollection) return;
    try {
      const created = await onCreateCollection(trimmed);
      await onAddBooksToCollection(created.id, [book.id]);
      setMemberCollectionIds((prev) => new Set(prev).add(created.id));
      setNewCollectionName("");
      setStatusMessage(`已加入新珍藏《${created.name}》`);
    } catch {
      setStatusMessage("创建珍藏失败");
    }
  }

  function handleExportBookRecords() {
    if (records.length === 0) return;
    const header = `# 《${book.title}》阅读笔记与摘录\n\n- **作者**：${book.author || "未知作者"}\n- **导出时间**：${formatDateTime(new Date().toISOString())}\n- **记录总数**：${records.length} 条\n\n---\n\n`;
    const body = records.map((r) => {
      const tag = kindLabel(r.kind);
      const quote = r.text ? `> ${r.text.replace(/\n/g, "\n> ")}\n` : "";
      const note = r.note ? `\n**想法**：${r.note}\n` : "";
      return `### [${tag}] ${formatDateTime(r.createdAt)}\n\n${quote}${note}`;
    }).join("\n---\n\n");
    const safeTitle = book.title.replace(/[\\/:*?"<>|]/g, "_");
    downloadMarkdown(`${safeTitle}-笔记摘录.md`, header + body);
  }

  return (
    <div
      className="modal-backdrop book-details-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="book-details-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="book-details-title"
      >
        <header className="book-details-dialog__header">
          <div className="book-details-dialog__cover-col">
            <div className="book-cover book-details-dialog__cover">
              <GeneratedBookCover book={book} />
              {book.coverUrl && (
                <PublicationCoverImage
                  className="book-cover__image"
                  url={book.coverUrl}
                  alt={`《${book.title}》封面`}
                  loading="eager"
                />
              )}
            </div>
            {!book.coverUrl && (
              <div className="book-details-dialog__palettes" aria-label="生成封面配色">
                <span className="book-details-dialog__palette-label"><Palette size={13} />封面色调</span>
                <div className="book-details-dialog__palette-swatches">
                  <button
                    type="button"
                    className="book-details-dialog__swatch book-details-dialog__swatch--auto"
                    aria-label="默认封面色调"
                    aria-pressed={pref.coverTone === undefined}
                    onClick={() => setBookCoverTone(book.id, null)}
                    title="自动配色"
                  >
                    自动
                  </button>
                  {CoverPalettes.map((palette, index) => (
                    <button
                      key={palette.name}
                      type="button"
                      className="book-details-dialog__swatch"
                      style={{ background: palette.background }}
                      aria-label={`封面色调：${palette.name}`}
                      aria-pressed={pref.coverTone === index}
                      onClick={() => setBookCoverTone(book.id, index)}
                      title={palette.name}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="book-details-dialog__summary">
            <div className="book-details-dialog__badges">
              <span className="book-details-badge book-details-badge--format">{book.format.toUpperCase()}</span>
              <span className={`book-details-badge ${book.availabilityStatus === "available" ? "book-details-badge--ok" : "book-details-badge--warn"}`}>
                {book.availabilityStatus === "available" ? "源文件可用" : "源文件缺失"}
              </span>
              <span className="book-details-badge">{readingStatusText}</span>
              {pinned && <span className="book-details-badge book-details-badge--pin">★ 已星标置顶</span>}
            </div>

            <h2 id="book-details-title" className="book-details-dialog__title">{book.title}</h2>
            <p className="book-details-dialog__author">{book.author || "未知作者"}</p>

            <dl className="book-details-dialog__dates">
              <div>
                <dt>加入书库</dt>
                <dd>{formatDateTime(book.addedAt)}</dd>
              </div>
              <div>
                <dt>最近阅读</dt>
                <dd>{formatDateTime(book.lastReadAt)}</dd>
              </div>
            </dl>

            <div className="book-details-dialog__primary-actions">
              <button
                type="button"
                className="button button--primary"
                onClick={() => {
                  onClose();
                  onOpen(book);
                }}
              >
                <BookOpen size={17} />
                {book.progress > 0 && book.progress < 0.995 ? "继续阅读" : "打开阅读"}
              </button>

              <button
                type="button"
                className="button"
                aria-pressed={pinned}
                onClick={() => {
                  const next = toggleBookPinned(book.id);
                  setStatusMessage(next ? "已设为星标置顶" : "已取消星标置顶");
                }}
              >
                <Star size={17} weight={pinned ? "fill" : "regular"} />
                {pinned ? "取消星标" : "星标置顶"}
              </button>

              {onRevealInFolder && book.availabilityStatus === "available" && (
                <button
                  type="button"
                  className="button"
                  onClick={() => {
                    void onRevealInFolder(book.id).then((ok) => {
                      if (!ok) setStatusMessage("无法在文件夹中定位源文件");
                    });
                  }}
                >
                  <FolderOpen size={17} />
                  在文件夹中显示
                </button>
              )}

              {onRelocate && book.availabilityStatus === "unavailable" && (
                <button
                  type="button"
                  className="button"
                  onClick={() => {
                    void onRelocate(book.id);
                  }}
                >
                  <WarningCircle size={17} />
                  重新定位源文件
                </button>
              )}
            </div>
          </div>

          <button
            type="button"
            className="icon-button book-details-dialog__close"
            aria-label="关闭书籍详情"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </header>

        {statusMessage && (
          <div className="book-details-dialog__status" role="status">
            {statusMessage}
          </div>
        )}

        <div className="book-details-dialog__body">
          <form className="book-details-section" onSubmit={(e) => void handleSaveMetadata(e)}>
            <h3><NotePencil size={17} /> 书目信息编辑</h3>
            <div className="book-details-form-grid">
              <label>
                <span>书名</span>
                <input
                  type="text"
                  aria-label="编辑书名"
                  value={title}
                  maxLength={200}
                  required
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>
              <label>
                <span>作者</span>
                <input
                  type="text"
                  aria-label="编辑作者"
                  value={author}
                  maxLength={150}
                  placeholder="未知作者"
                  onChange={(e) => setAuthor(e.target.value)}
                />
              </label>
              <button
                type="submit"
                className="button button--primary"
                disabled={busy || savingMeta || !title.trim() || !metadataChanged}
              >
                {savingMeta ? "保存中…" : "保存信息"}
              </button>
            </div>
          </form>

          <section className="book-details-section" aria-label="阅读状态与进度">
            <h3><CheckCircle size={17} /> 阅读进度管理</h3>
            <div className="book-details-progress-row">
              <div className="book-details-progress-bar">
                <span style={{ width: `${progressPercent}%` }} />
              </div>
              <strong>{progressPercent}%</strong>
              <div className="book-details-progress-actions">
                <button
                  type="button"
                  className="button"
                  disabled={busy || updatingState || book.progress >= 0.995}
                  onClick={() => void handleSetReadingState("finished")}
                >
                  <CheckCircle size={16} />
                  标记为已读
                </button>
                <button
                  type="button"
                  className="button"
                  disabled={busy || updatingState || (book.progress === 0 && !book.lastReadAt)}
                  onClick={() => void handleSetReadingState("unread")}
                >
                  <ArrowCounterClockwise size={16} />
                  重置为未读
                </button>
              </div>
            </div>
          </section>

          <section className="book-details-section" aria-label="所属珍藏">
            <h3><FolderPlus size={17} /> 所属珍藏 ({memberCollectionIds.size})</h3>
            {loadingMemberships ? (
              <p className="book-details-muted">正在读取珍藏归属…</p>
            ) : (
              <>
                {collections.length > 0 ? (
                  <div className="book-details-collections">
                    {collections.map((col) => {
                      const active = memberCollectionIds.has(col.id);
                      return (
                        <button
                          key={col.id}
                          type="button"
                          className="book-details-collection-pill"
                          aria-pressed={active}
                          onClick={() => void handleToggleCollection(col.id)}
                        >
                          <span>{active ? "✓" : "+"}</span>
                          <span>{col.name}</span>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <p className="book-details-muted">当前还没有创建任何珍藏。</p>
                )}
                {onCreateCollection && onAddBooksToCollection && (
                  <div className="book-details-collection-create">
                    <input
                      type="text"
                      aria-label="新建珍藏并加入本书"
                      placeholder="输入新珍藏名称并加入…"
                      value={newCollectionName}
                      maxLength={80}
                      onChange={(e) => setNewCollectionName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void handleCreateAndAddCollection();
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="button"
                      disabled={!newCollectionName.trim()}
                      onClick={() => void handleCreateAndAddCollection()}
                    >
                      新建并加入
                    </button>
                  </div>
                )}
              </>
            )}
          </section>

          <section className="book-details-section" aria-label="本书阅读记录">
            <div className="book-details-section__head">
              <h3>
                <Bookmarks size={17} />
                本书笔记与书签 ({records.length})
                {records.length > 0 && (
                  <small>
                    书签 {recordCounts.bookmark} · 划线 {recordCounts.highlight} · 笔记 {recordCounts.note} · 摘录 {recordCounts.quote}
                  </small>
                )}
              </h3>
              {records.length > 0 && (
                <button type="button" className="button" onClick={handleExportBookRecords}>
                  <DownloadSimple size={16} />
                  导出 Markdown
                </button>
              )}
            </div>
            {loadingRecords ? (
              <p className="book-details-muted">正在读取本书记录…</p>
            ) : records.length === 0 ? (
              <p className="book-details-muted">本书暂无书签、划线或笔记。在阅读时选中文本即可添加。</p>
            ) : (
              <ul className="book-details-records">
                {records.slice(0, 12).map((record) => (
                  <li key={record.id}>
                    <button
                      type="button"
                      className="book-details-record-item"
                      onClick={() => {
                        onClose();
                        onOpen(book, record.location);
                      }}
                    >
                      <span className={`book-details-record-kind book-details-record-kind--${record.kind}`}>
                        {kindLabel(record.kind)}
                      </span>
                      <div className="book-details-record-copy">
                        <strong>{record.text || "书签位置"}</strong>
                        {record.note && <p>{record.note}</p>}
                      </div>
                      <small>跳转 ↗</small>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <footer className="book-details-dialog__footer">
          {onRequestRemove && (
            <button
              type="button"
              className="button button--danger-outline"
              onClick={() => {
                onClose();
                onRequestRemove(book);
              }}
            >
              <Trash size={17} />
              从书架移出本书
            </button>
          )}
          <button type="button" className="button" onClick={onClose}>
            完成
          </button>
        </footer>
      </section>
    </div>
  );
}
