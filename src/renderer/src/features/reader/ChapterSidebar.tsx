import { CaretDown, CaretRight, X } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import type { ChapterSummary } from "../../../../shared/contracts.js";

type Props = {
  chapters: Array<ChapterSummary & { depth?: number }>;
  activeId: string;
  open: boolean;
  onSelect(chapterId: string): void;
  onClose(): void;
  onOpenImages?(): void;
};

export function ChapterSidebar({ chapters, activeId, open, onSelect, onClose, onOpenImages }: Props) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const listRef = useRef<HTMLElement | null>(null);
  const active = chapters.find(chapter => chapter.id === activeId)
    ?? chapters.find(chapter => chapter.id.split("#")[0] === activeId.split("#")[0]);

  useEffect(() => {
    if (!open) return;
    const activeButton = listRef.current?.querySelector<HTMLElement>(".chapter-link[data-active='true']");
    activeButton?.scrollIntoView?.({ block: "nearest" });
  }, [active?.id, open]);

  let hiddenBelow: number | null = null;
  const visible = chapters.filter(chapter => {
    const depth = chapter.depth ?? 0;
    if (query.trim()) return chapter.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
    if (hiddenBelow !== null && depth > hiddenBelow) return false;
    hiddenBelow = collapsed.has(chapter.id) ? depth : null;
    return true;
  });
  return (
    <aside className="reader-panel reader-panel--chapters" data-open={open} aria-label="目录" aria-hidden={!open}>
      <header className="panel-header">
        <div><strong>目录</strong><span>{chapters.length} 章</span></div>
        <button className="icon-button" type="button" aria-label="收起目录" onClick={onClose}><X size={20} /></button>
      </header>
      {onOpenImages && <div className="reader-catalog-tabs" role="group" aria-label="目录类型">
        <button type="button" data-active="true" aria-current="page">章节</button>
        <button type="button" onClick={onOpenImages}>图片</button>
      </div>}
      <div className="reader-directory-search"><input aria-label="查找章节" placeholder="查找章节" value={query} onChange={event => setQuery(event.target.value)} /></div>
      <nav ref={listRef} className="chapter-list" aria-label="章节列表">
        {visible.map((chapter) => (
          <div className="chapter-row" key={chapter.id} style={{ paddingLeft: Math.min(chapter.depth ?? 0, 5) * 12 }}>
          {(chapters[chapter.index + 1]?.depth ?? 0) > (chapter.depth ?? 0) && <button type="button" className="chapter-collapse" aria-label={collapsed.has(chapter.id) ? "展开章节" : "折叠章节"} aria-expanded={!collapsed.has(chapter.id)} onClick={() => setCollapsed(previous => { const next = new Set(previous); if (next.has(chapter.id)) next.delete(chapter.id); else next.add(chapter.id); return next; })}>{collapsed.has(chapter.id) ? <CaretRight size={14} /> : <CaretDown size={14} />}</button>}
          <button
            className="chapter-link"
            data-active={chapter.id === active?.id}
            aria-current={chapter.id === active?.id ? "location" : undefined}
            type="button"
            key={chapter.id}
            onClick={() => onSelect(chapter.id)}
          >
            <span>{chapter.index + 1}</span>{chapter.title}
          </button>
          </div>
        ))}
        {!visible.length && <p className="reader-record-empty">没有匹配的章节。</p>}
      </nav>
    </aside>
  );
}
