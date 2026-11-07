import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import type { CSSProperties, UIEvent } from "react";
import type { ChapterContent, ReadingAppearance, ReadingLocationV1, TxtReadingLocationV1 } from "../../../shared/contracts.js";
import { createTxtLocator, restoreTxtLocator } from "../../../formats/txt/locator.js";
import type { ReaderMark, ReaderSearchResult, ReaderSelection } from "./reading-tools.js";
import { rangeForTextOffsets, textOffsetInBlock } from "./txt-dom-range.js";

type TextBlock = { id: string; text: string; start: number; end: number };

function countCodePoints(slice: string): number {
  let count = 0;
  for (let index = 0; index < slice.length; index += 1) {
    const code = slice.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < slice.length) {
      const next = slice.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index += 1;
    }
    count += 1;
  }
  return count;
}

function splitBlocks(text: string): TextBlock[] {
  const blocks: TextBlock[] = [];
  const expression = /\S[^\r\n]*(?=\r?\n|$)/g;
  let lastCodeUnit = 0;
  let lastCodePoint = 0;
  for (const match of text.matchAll(expression)) {
    const raw = match[0].trim();
    if (!raw) continue;
    const codeUnitStart = (match.index ?? 0) + match[0].indexOf(raw);
    const start = lastCodePoint + countCodePoints(text.slice(lastCodeUnit, codeUnitStart));
    const end = start + countCodePoints(raw);
    lastCodeUnit = codeUnitStart + raw.length;
    lastCodePoint = end;
    blocks.push({ id: `txt-block-${start}`, text: raw, start, end });
  }
  return blocks.length ? blocks : [{ id: "txt-block-0", text, start: 0, end: countCodePoints(text) }];
}

function isHeadingBlock(blockText: string, chapterTitle: string): boolean {
  const cleaned = blockText.replace(/^#+\s*/, "").replace(/[ \t\u3000]+/g, " ").trim();
  if (!cleaned || cleaned.length > 80) return false;
  if (cleaned === chapterTitle) return true;
  return chapterTitle === "正文" && cleaned.length <= 40 && !/[。！？…；.!?;”」』]$/.test(cleaned);
}

type Props = {
  content: ChapterContent;
  appearance: ReadingAppearance;
  restoreLocation: TxtReadingLocationV1 | null;
  chapterCount: number;
  nextChapterTitle?: string | null;
  onLocation(location: TxtReadingLocationV1): void;
  onReady?(): void;
  onBoundary(direction: -1 | 1): void;
  initialEdge: "start" | "end";
  onSelection?(selection: ReaderSelection | null): void;
  onContentClick?(): void;
  onMarkClick?(id: string): void;
};

export type TxtRenditionHandle = {
  previousPage(): void;
  nextPage(): void;
  navigateLocation(location: ReadingLocationV1): void;
  clearSelection(): void;
  search(query: string): Promise<ReaderSearchResult[]>;
  setMarks(marks: ReaderMark[]): void;
};

export const TxtRendition = forwardRef<TxtRenditionHandle, Props>(function TxtRendition({
  content,
  appearance,
  restoreLocation,
  chapterCount,
  nextChapterTitle,
  onLocation,
  onReady,
  onBoundary,
  initialEdge,
  onSelection,
  onContentClick,
  onMarkClick,
}, forwardedRef) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const currentLocationRef = useRef<TxtReadingLocationV1 | null>(null);
  const marksRef = useRef<ReaderMark[]>([]);
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const overscrollRef = useRef(0);
  const lastWheelFlipAtRef = useRef(0);
  const blocks = useMemo(() => splitBlocks(content.text), [content.text]);
  const points = useMemo(() => [...content.text], [content.text]);
  const paginated = appearance.txtFlow === "paginated";
  const columns = appearance.txtColumns === "double" ? 2 : 1;

  function locator(characterOffset: number) {
    return createTxtLocator({
      sourceRevision: content.sourceRevision,
      chapter: content.chapter,
      chapterText: content.text,
      characterOffset,
      points,
      totalProgression: Math.min(1, (content.chapter.index + characterOffset / Math.max(1, points.length)) / Math.max(1, chapterCount)),
    });
  }

  function findBlockForOffset(offset: number) {
    return blocks.find((block) => offset >= block.start && offset <= block.end)
      ?? blocks.find((block) => offset < block.start)
      ?? blocks.at(-1);
  }

  function rangeAt(start: number, end: number) {
    const scroller = scrollerRef.current;
    if (!scroller) return null;
    const first = findBlockForOffset(start);
    const last = findBlockForOffset(end);
    if (!first || !last) return null;
    const firstNode = scroller.querySelector<HTMLElement>(`#${first.id}`);
    const lastNode = scroller.querySelector<HTMLElement>(`#${last.id}`);
    if (!firstNode || !lastNode) return null;
    const startOffset = Math.max(0, Math.min(first.end - first.start, start - first.start));
    const endOffset = Math.max(0, Math.min(last.end - last.start, end - last.start));
    const startRange = rangeForTextOffsets(firstNode, startOffset, startOffset);
    const endRange = rangeForTextOffsets(lastNode, endOffset, endOffset);
    if (!startRange || !endRange) return null;
    const range = document.createRange();
    range.setStart(startRange.startContainer, startRange.startOffset);
    range.setEnd(endRange.endContainer, endRange.endOffset);
    return range;
  }

  function paintMarks(marks: ReaderMark[]) {
    const highlights = (globalThis.CSS as (typeof CSS & { highlights?: Map<string, unknown> }) | undefined)?.highlights;
    if (!highlights || typeof Highlight === "undefined") return;
    for (const color of ["cyan", "yellow", "pink"]) {
      const ranges = marks.filter((mark) => mark.color === color && mark.location.format === "txt"
        && mark.location.primary.chapterId === content.chapter.id).map((mark) => {
          if (mark.location.format !== "txt") return null;
          const end = mark.endLocation?.format === "txt" ? mark.endLocation.primary.characterOffset : mark.location.primary.characterOffset + 1;
          return rangeAt(mark.location.primary.characterOffset, end);
        }).filter((range): range is Range => !!range);
      if (ranges.length) highlights.set(`reader-${color}`, new Highlight(...ranges));
      else highlights.delete(`reader-${color}`);
    }
  }

  const stepPreviousPage = () => {
    const node = scrollerRef.current;
    if (!node) return;
    if (paginated) {
      if (node.scrollLeft <= 1) {
        onBoundary(-1);
        return;
      }
      node.scrollLeft = Math.max(0, node.scrollLeft - Math.max(1, node.clientWidth));
      return;
    }
    if (node.scrollTop <= 1) {
      onBoundary(-1);
      return;
    }
    node.scrollTop = Math.max(0, node.scrollTop - node.clientHeight * 0.88);
  };

  const stepNextPage = () => {
    const node = scrollerRef.current;
    if (!node) return;
    if (paginated) {
      const maximum = Math.max(0, node.scrollWidth - node.clientWidth);
      if (node.scrollLeft >= maximum - 1) {
        onBoundary(1);
        return;
      }
      node.scrollLeft = Math.min(maximum, node.scrollLeft + Math.max(1, node.clientWidth));
      return;
    }
    const maximum = Math.max(0, node.scrollHeight - node.clientHeight);
    if (node.scrollTop >= maximum - 1) {
      onBoundary(1);
      return;
    }
    node.scrollTop = Math.min(maximum, node.scrollTop + node.clientHeight * 0.88);
  };

  useImperativeHandle(forwardedRef, () => ({
    previousPage: stepPreviousPage,
    nextPage: stepNextPage,
    navigateLocation(location) {
      if (location.format !== "txt" || location.primary.chapterId !== content.chapter.id) return;
      const offset = restoreTxtLocator(content.text, location).characterOffset;
      rangeAt(offset, Math.min(points.length, offset + 1))?.startContainer.parentElement?.scrollIntoView({ block: "center" });
      currentLocationRef.current = location;
    },
    clearSelection() { window.getSelection()?.removeAllRanges(); onSelection?.(null); },
    async search(query) {
      const needle = query.trim();
      if (!needle) return [];
      const results: ReaderSearchResult[] = [];
      const expression = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
      for (const match of content.text.matchAll(expression)) {
        if (results.length >= 2000) break;
        const index = match.index;
        const start = [...content.text.slice(0, index)].length;
        const end = [...content.text.slice(0, index + match[0].length)].length;
        results.push({ id: `${content.chapter.id}:${start}`, text: content.text.slice(Math.max(0, index - 40), index + match[0].length + 40), location: locator(start), endLocation: locator(end) });
      }
      return results;
    },
    setMarks(marks) { marksRef.current = marks; paintMarks(marks); },
  }), [onBoundary, content, chapterCount, points.length, blocks, onSelection, paginated]);

  useEffect(() => {
    currentLocationRef.current = restoreLocation?.primary.chapterId === content.chapter.id ? restoreLocation : null;
    overscrollRef.current = 0;
  }, [content.chapter.id, restoreLocation]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const location = currentLocationRef.current;
    if (!location || location.primary.chapterId !== content.chapter.id) {
      const atEnd = initialEdge === "end";
      const characterOffset = atEnd ? points.length : 0;
      if (paginated) {
        scroller.scrollTop = 0;
        scroller.scrollLeft = atEnd
          ? Math.max(0, scroller.scrollWidth - scroller.clientWidth)
          : 0;
      } else {
        scroller.scrollLeft = 0;
        scroller.scrollTop = atEnd
          ? Math.max(0, scroller.scrollHeight - scroller.clientHeight)
          : 0;
      }
      const start = createTxtLocator({
        sourceRevision: content.sourceRevision,
        chapter: content.chapter,
        chapterText: content.text,
        characterOffset,
        points,
        totalProgression: Math.min(1, (content.chapter.index + (atEnd ? 1 : 0)) / Math.max(1, chapterCount)),
      });
      currentLocationRef.current = start;
      onLocation(start);
      return;
    }
    const restored = restoreTxtLocator(content.text, location);
    const target = findBlockForOffset(restored.characterOffset) ?? blocks[0];
    const element = scroller.querySelector<HTMLElement>(`#${target.id}`);
    const textNode = element?.firstChild;
    if (!paginated && element && textNode?.nodeType === Node.TEXT_NODE) {
      const localCodePoints = Math.max(0, restored.characterOffset - target.start);
      const codeUnitOffset = [...target.text].slice(0, localCodePoints).join("").length;
      const range = document.createRange();
      range.setStart(textNode, Math.min(codeUnitOffset, textNode.textContent?.length ?? 0));
      range.setEnd(textNode, Math.min(codeUnitOffset + 1, textNode.textContent?.length ?? 0));
      const rectangle = typeof range.getBoundingClientRect === "function" ? range.getBoundingClientRect() : null;
      if (rectangle?.height) {
        const anchorY = Math.min(96, Math.max(24, scroller.clientHeight * 0.22));
        scroller.scrollTop += rectangle.top + rectangle.height / 2 - scroller.getBoundingClientRect().top - anchorY;
      }
      else element.scrollIntoView({ block: "center" });
    } else {
      element?.scrollIntoView({ block: "center", inline: "start" });
    }
  }, [appearance.firstLineIndent, appearance.fontFamily, appearance.fontSize, appearance.letterSpacing, appearance.lineHeight, appearance.measure, appearance.paragraphSpacing, paginated, columns, blocks, chapterCount, content.chapter, content.sourceRevision, content.text, initialEdge, onLocation, points]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || typeof ResizeObserver === "undefined") return;
    let previousWidth = scroller.clientWidth;
    const observer = new ResizeObserver(() => {
      if (scroller.clientWidth === previousWidth) return;
      previousWidth = scroller.clientWidth;
      const location = currentLocationRef.current;
      if (location?.primary.chapterId !== content.chapter.id) return;
      const offset = restoreTxtLocator(content.text, location).characterOffset;
      rangeAt(offset, Math.min(points.length, offset + 1))?.startContainer.parentElement?.scrollIntoView({ block: "center" });
    });
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [content, blocks, points.length]);

  useEffect(() => {
    paintMarks(marksRef.current);
    return () => {
      const highlights = (globalThis.CSS as (typeof CSS & { highlights?: Map<string, unknown> }) | undefined)?.highlights;
      for (const color of ["cyan", "yellow", "pink"]) highlights?.delete(`reader-${color}`);
    };
  }, [content.chapter.id, blocks, appearance.fontFamily, appearance.fontSize]);

  useEffect(() => {
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => onReady?.());
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
    };
  }, [
    appearance.fontSize,
    appearance.fontFamily,
    appearance.firstLineIndent,
    appearance.letterSpacing,
    appearance.lineHeight,
    appearance.measure,
    appearance.paragraphSpacing,
    content.chapter.id,
    content.sourceRevision,
    onReady,
  ]);

  function handleScroll(event: UIEvent<HTMLDivElement>) {
    const node = event.currentTarget;
    const characterOffset = characterOffsetAtViewport(node, blocks);
    const progression = points.length ? characterOffset / points.length : 0;
    const location = createTxtLocator({
      sourceRevision: content.sourceRevision,
      chapter: content.chapter,
      chapterText: content.text,
      characterOffset,
      points,
      totalProgression: Math.min(1, (content.chapter.index + progression) / Math.max(1, chapterCount)),
    });
    currentLocationRef.current = location;
    onLocation(location);
  }

  function handleWheel(event: React.WheelEvent<HTMLDivElement>) {
    const node = event.currentTarget;
    if (paginated) {
      const primaryDelta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (Math.abs(primaryDelta) < 8) return;
      const now = Date.now();
      if (now - lastWheelFlipAtRef.current < 160) return;
      lastWheelFlipAtRef.current = now;
      if (primaryDelta > 0) stepNextPage();
      else stepPreviousPage();
      return;
    }
    const maximum = Math.max(0, node.scrollHeight - node.clientHeight);
    if (event.deltaY > 0 && node.scrollTop >= maximum - 1) {
      overscrollRef.current = Math.max(0, overscrollRef.current) + event.deltaY;
      if (overscrollRef.current >= 110) {
        overscrollRef.current = 0;
        onBoundary(1);
      }
    } else if (event.deltaY < 0 && node.scrollTop <= 1) {
      overscrollRef.current = Math.min(0, overscrollRef.current) + event.deltaY;
      if (overscrollRef.current <= -110) {
        overscrollRef.current = 0;
        onBoundary(-1);
      }
    } else {
      overscrollRef.current = 0;
    }
  }

  function handleSelection() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) { onSelection?.(null); return; }
    const range = selection.getRangeAt(0);
    const article = scrollerRef.current?.querySelector(".txt-rendition");
    if (!article?.contains(range.startContainer) || !article.contains(range.endContainer)) return;
    const first = (range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer as Element : range.startContainer.parentElement)?.closest<HTMLElement>("[data-txt-block]");
    const last = (range.endContainer.nodeType === Node.ELEMENT_NODE ? range.endContainer as Element : range.endContainer.parentElement)?.closest<HTMLElement>("[data-txt-block]");
    const firstBlock = blocks.find((block) => block.id === first?.id);
    const lastBlock = blocks.find((block) => block.id === last?.id);
    if (!first || !last || !firstBlock || !lastBlock) return;
    const start = firstBlock.start + textOffsetInBlock(first, range.startContainer, range.startOffset);
    const end = lastBlock.start + textOffsetInBlock(last, range.endContainer, range.endOffset);
    const rectangle = range.getBoundingClientRect();
    onSelection?.({ text: selection.toString(), location: locator(start), endLocation: locator(end), rect: {
      x: rectangle.x, y: rectangle.y, width: rectangle.width, height: rectangle.height,
    } });
  }

  function handleClick(event: React.MouseEvent<HTMLDivElement>) {
    const start = pointerStartRef.current;
    if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) return;
    if (window.getSelection()?.toString().trim()) return;
    const target = event.target as Element;
    if (target.closest("a[href], button")) return;
    const marked = marksRef.current.find((mark) => {
      if (mark.location.format !== "txt" || mark.location.primary.chapterId !== content.chapter.id) return false;
      const end = mark.endLocation?.format === "txt" ? mark.endLocation.primary.characterOffset : mark.location.primary.characterOffset + 1;
      const range = rangeAt(mark.location.primary.characterOffset, end);
      return [...(range?.getClientRects() ?? [])].some((rect) => event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom);
    });
    if (marked) onMarkClick?.(marked.id);
    else onContentClick?.();
  }

  const style = {
    "--reader-font-size": `${appearance.fontSize}px`,
    "--reader-line-height": String(appearance.lineHeight),
    "--reader-measure": `${appearance.measure}px`,
    "--reader-font-family": appearance.fontFamily === "serif" ? "var(--font-reading-serif)" : "var(--font-reading-sans)",
    "--reader-paragraph-spacing": `${appearance.paragraphSpacing}em`,
    "--reader-first-line-indent": appearance.firstLineIndent === "two-em" ? "2em" : "0",
    "--reader-letter-spacing": `${appearance.letterSpacing}em`,
    "--reader-columns": String(columns),
  } as CSSProperties;

  return (
    <div
      className="reading-scroller"
      data-testid="reading-scroller"
      data-flow={paginated ? "paginated" : "scrolled"}
      data-columns={columns}
      ref={scrollerRef}
      onScroll={handleScroll}
      onWheel={handleWheel}
      onPointerDown={(event) => { pointerStartRef.current = { x: event.clientX, y: event.clientY }; }}
      onPointerUp={handleSelection}
      onKeyUp={handleSelection}
      onClick={handleClick}
    >
      <style>{`::highlight(reader-cyan){background:rgba(68,207,218,.38)} ::highlight(reader-yellow){background:rgba(255,222,85,.46)} ::highlight(reader-pink){background:rgba(247,132,185,.4)}`}</style>
      <article className="txt-rendition" aria-label="正文" style={style}>
        {blocks.map((block, index) => (
          <p
            id={block.id}
            data-txt-block
            data-chapter-heading={index === 0 && isHeadingBlock(block.text, content.chapter.title) ? "true" : undefined}
            key={block.id}
          >
            {block.text}
          </p>
        ))}
        {!paginated && nextChapterTitle && (
          <footer className="txt-chapter-footer">
            <button type="button" className="txt-next-chapter" onClick={() => onBoundary(1)}>
              继续阅读：{nextChapterTitle}
            </button>
          </footer>
        )}
      </article>
    </div>
  );
});

function characterOffsetAtViewport(scroller: HTMLDivElement, blocks: TextBlock[]) {
  const scrollerRect = scroller.getBoundingClientRect();
  const article = scroller.querySelector<HTMLElement>(".txt-rendition");
  const articleRect = article?.getBoundingClientRect();
  const x = articleRect ? articleRect.left + Math.min(24, Math.max(4, articleRect.width / 4)) : scrollerRect.left + 24;
  const y = scrollerRect.top + Math.min(96, Math.max(24, scroller.clientHeight * 0.22));
  const caret = document.caretPositionFromPoint?.(x, y);
  if (caret) {
    const element = caret.offsetNode.nodeType === Node.ELEMENT_NODE
      ? (caret.offsetNode as Element)
      : caret.offsetNode.parentElement;
    const paragraph = element?.closest<HTMLElement>("[data-txt-block]");
    const block = blocks.find((item) => item.id === paragraph?.id);
    if (block && caret.offsetNode.nodeType === Node.TEXT_NODE) {
      const codeUnits = caret.offsetNode.textContent?.slice(0, caret.offset) ?? "";
      return Math.min(block.end, block.start + [...codeUnits].length);
    }
    if (block) return block.start;
  }
  const visible = blocks.find((block) => {
    const rectangle = scroller.querySelector<HTMLElement>(`#${block.id}`)?.getBoundingClientRect();
    return rectangle ? rectangle.bottom > scrollerRect.top + 32 : false;
  });
  return visible?.start ?? blocks[0]?.start ?? 0;
}
