import { ArrowClockwise, Check, DotsThreeOutline, HourglassHigh, Star, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import type { BookSummary } from "../../../../shared/contracts.js";
import { useBookPreference } from "./book-preferences.js";
import { GeneratedBookCover } from "./GeneratedBookCover.js";
import { PublicationCoverImage } from "./PublicationCoverImage.js";

type Props = {
  book: BookSummary;
  selectionMode?: boolean;
  selected?: boolean;
  coverOnly?: boolean;
  showRichMeta?: boolean;
  onOpen(book: BookSummary): void;
  onSelect?(book: BookSummary): void;
  onLongPress?(book: BookSummary): void;
  onOpenDetails?(book: BookSummary): void;
};

function formatShortDate(iso: string | null): string | null {
  if (!iso) return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
  return match ? match[1]! : null;
}

export function BookTile({
  book,
  selectionMode = false,
  selected = false,
  coverOnly = false,
  showRichMeta = false,
  onOpen,
  onSelect,
  onLongPress,
  onOpenDetails,
}: Props) {
  const [holding, setHolding] = useState(false);
  const pref = useBookPreference(book.id);
  const pinned = Boolean(pref.pinned);
  const pressTimer = useRef<number | null>(null);
  const resetTimer = useRef<number | null>(null);
  const pressStart = useRef<{ x: number; y: number } | null>(null);
  const suppressClick = useRef(false);
  function cancelPress() {
    setHolding(false);
    if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
    pressTimer.current = null;
    pressStart.current = null;
  }
  useEffect(() => () => {
    if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
  }, []);
  const unavailable = book.availabilityStatus === "unavailable";
  const preparing = book.preparationStatus === "queued"
    || book.preparationStatus === "preparing";
  const preparationFailed = book.preparationStatus === "error";
  const progressText = book.progress >= 0.995
    ? "已读完"
    : book.progress > 0
      ? `已读 ${Math.round(book.progress * 100)}%`
      : "尚未开始";
  const dateHint = book.lastReadAt
    ? `最近阅读 ${formatShortDate(book.lastReadAt) ?? ""}`
    : `加入于 ${formatShortDate(book.addedAt) ?? ""}`;

  return (
    <article
      className="book-tile"
      data-holding={holding}
      data-selected={selected}
      data-selection-mode={selectionMode}
      data-pinned={pinned ? "true" : undefined}
      data-unavailable={unavailable ? "true" : undefined}
      data-testid="book-tile"
    >
      <button
        className="book-tile__button"
        type="button"
        tabIndex={coverOnly ? -1 : undefined}
        aria-hidden={coverOnly ? "true" : undefined}
        aria-pressed={selectionMode ? selected : undefined}
        aria-label={coverOnly
          ? undefined
          : selectionMode
            ? `${selected ? "取消选择" : "选择"}《${book.title}》`
            : unavailable
              ? `${book.title}，源文件不可用，点击重新定位`
              : preparationFailed
                ? `重试准备《${book.title}》`
                : `打开《${book.title}》`}
        onPointerDown={(event) => {
          if (selectionMode || !onLongPress || event.button !== 0) return;
          cancelPress();
          setHolding(true);
          pressStart.current = { x: event.clientX, y: event.clientY };
          pressTimer.current = window.setTimeout(() => {
            pressTimer.current = null;
            pressStart.current = null;
            setHolding(false);
            suppressClick.current = true;
            onLongPress(book);
          }, 480);
        }}
        onPointerMove={(event) => {
          if (pressStart.current && Math.hypot(event.clientX - pressStart.current.x, event.clientY - pressStart.current.y) > 9) cancelPress();
        }}
        onPointerUp={() => {
          cancelPress();
          if (suppressClick.current) resetTimer.current = window.setTimeout(() => { suppressClick.current = false; }, 0);
        }}
        onPointerCancel={cancelPress}
        onPointerLeave={cancelPress}
        onContextMenu={(event) => {
          if (selectionMode) return;
          if (onOpenDetails) {
            event.preventDefault();
            cancelPress();
            onOpenDetails(book);
            return;
          }
          if (!onLongPress) return;
          event.preventDefault();
          cancelPress();
          onLongPress(book);
        }}
        onClick={(event) => {
          if (suppressClick.current) {
            suppressClick.current = false;
            event.preventDefault();
            return;
          }
          selectionMode ? onSelect?.(book) : onOpen(book);
        }}
      >
        {selectionMode && (
          <span className="book-tile__check" aria-hidden="true">
            {selected && <Check size={18} weight="bold" />}
          </span>
        )}
        <span className="book-cover">
          <GeneratedBookCover book={book} />
          {book.coverUrl && (
            <PublicationCoverImage
              className="book-cover__image"
              url={book.coverUrl}
              alt={`《${book.title}》封面`}
              loading="lazy"
            />
          )}
          {pinned && !coverOnly && (
            <span className="book-cover__pin-badge" aria-hidden="true" title="星标置顶">
              <Star size={12} weight="fill" />
            </span>
          )}
        </span>
        {!coverOnly && (
          <span className="book-tile__copy">
            <span className="book-tile__title" role="heading" aria-level={2}>{book.title}</span>
            <span className="book-tile__author">{book.author || "未知作者"}</span>
            <span className="book-tile__meta">
              {unavailable
                ? <><WarningCircle size={16} />源文件不可用 · 点击定位</>
                : preparationFailed
                  ? <><ArrowClockwise size={16} />准备失败 · 点击重试</>
                  : preparing
                    ? <><HourglassHigh size={16} />准备中</>
                    : progressText}
            </span>
            {showRichMeta && (
              <span className="book-tile__rich-meta">
                <span className="book-tile__format-badge">{book.format.toUpperCase()}</span>
                <span className="book-tile__date-hint">{dateHint}</span>
              </span>
            )}
          </span>
        )}
      </button>
      {!coverOnly && !selectionMode && onOpenDetails && (
        <button
          type="button"
          className="book-tile__more"
          aria-label={`管理《${book.title}》`}
          title="书籍详情与操作"
          onClick={(event) => {
            event.stopPropagation();
            onOpenDetails(book);
          }}
        >
          <DotsThreeOutline size={16} weight="fill" />
        </button>
      )}
    </article>
  );
}

