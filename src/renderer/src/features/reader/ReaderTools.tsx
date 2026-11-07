import { TransitionPresence } from "../shell/TransitionPresence.js";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, BookmarkSimple, Books, CaretLeft, CaretRight, Copy, Export, GearSix, Highlighter, Image, List, MagnifyingGlass, NotePencil, Quotes, X } from "@phosphor-icons/react";
import type { ReadingRecord } from "../../../../shared/reading-records.js";
import type { ReaderSelection } from "../../renditions/reading-tools.js";
import type { ReaderWorkspace } from "./useReaderWorkspace.js";
import "../../styles/reader-tools.css";

type Props = {
  tools: ReaderWorkspace;
  chapter: string;
  title: string;
  author?: string | null;
  epub?: boolean;
  onBack(): void;
  saveError?: string | null;
  history?: { canGoBack: boolean; canGoForward: boolean; back(): void; forward(): void };
};

const COLOR_LABELS: Record<ReadingRecord["color"], string> = {
  cyan: "冰蓝",
  yellow: "浅金",
  pink: "樱粉",
};

export function formatRecordsMarkdown(records: ReadingRecord[], title: string, author?: string | null): string {
  const headerLines = [`# ${title}`];
  if (author?.trim()) headerLines.push(`> 作者：${author.trim()}`);
  headerLines.push(`> 导出共 ${records.length} 条记录`);
  const body = records.map(r => {
    const kindLabel = r.kind === "bookmark" ? "书签" : r.kind === "note" ? "笔记" : r.kind === "quote" ? "摘录" : "高亮";
    const colorTag = r.kind === "highlight" || r.kind === "note" ? ` [${COLOR_LABELS[r.color]}]` : "";
    const dateLabel = new Date(r.createdAt).toLocaleDateString();
    const quoted = r.text.split("\n").map(line => `> ${line}`).join("\n");
    const noteSection = r.note.trim() ? `\n\n${r.note.trim()}` : "";
    return `## ${kindLabel}${colorTag} · ${dateLabel}\n\n${quoted}${noteSection}\n`;
  }).join("\n---\n\n");
  return `${headerLines.join("\n")}\n\n${body}`;
}

function exportNotes(records: ReadingRecord[], title: string, author?: string | null) {
  const content = formatRecordsMarkdown(records, title, author);
  const url = URL.createObjectURL(new Blob([content], { type: "text/markdown;charset=utf-8" }));
  const link = document.createElement("a"); link.href = url; link.download = `${title.replace(/[\\/:*?"<>|]/g, "_")}-阅读摘录.md`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ReaderTools({ tools: t, chapter, title, author, epub, onBack, saveError, history }: Props) {
  const [filter, setFilter] = useState("");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<ReadingRecord | "selection" | null>(null);
  const [selectionDraft, setSelectionDraft] = useState<ReaderSelection | null>(null);
  const [note, setNote] = useState("");
  const [color, setColor] = useState<ReadingRecord["color"]>("cyan");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [copiedRecordId, setCopiedRecordId] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) { dialog.current?.showModal?.(); dialog.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus(); }
    else dialog.current?.close?.();
  }, [editing]);
  useEffect(() => { setCopied(null); }, [t.selection]);
  useEffect(() => {
    if (t.panel === "search") {
      searchInputRef.current?.focus();
      searchInputRef.current?.select?.();
    }
  }, [t.panel]);
  const openEdit = (record: ReadingRecord | "selection") => {
    if (record === "selection") setSelectionDraft(t.selection);
    setEditing(record); setNote(record === "selection" ? "" : record.note); setColor(record === "selection" ? "cyan" : record.color);
  };
  const copyText = (text: string, id: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopiedRecordId(id);
      setTimeout(() => setCopiedRecordId(current => current === id ? null : current), 1600);
    }).catch(() => undefined);
  };
  const records = t.records.filter(r => t.panel === "bookmarks" ? r.kind === "bookmark" : r.kind !== "bookmark")
    .filter(r => `${r.text} ${r.note}`.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
  const closePanel = () => { t.setPanel(null); t.cancelSearch(); };
  return <>
    <button className="reader-tools-trigger icon-button" type="button" title="阅读工具" aria-label="阅读工具" aria-expanded={t.toolbarOpen || t.panel !== null} onClick={t.toggleToolbar}><List size={23} /></button>
    <TransitionPresence kind="toolbar">{(t.toolbarOpen || t.panel) && <nav className="reader-toolbar" aria-label="阅读工具栏">
      <button type="button" onClick={onBack}><ArrowLeft size={18} />书库</button>
      <span className="reader-toolbar__title" title={title}>{title}</span>
      <button type="button" aria-pressed={t.panel === "toc"} onClick={() => t.setPanel(t.panel === "toc" ? null : "toc")}><Books size={18} />目录</button>
      {epub && <button type="button" aria-pressed={t.panel === "images"} onClick={() => t.setPanel(t.panel === "images" ? null : "images")}><Image size={18} />图片</button>}
      <button type="button" aria-pressed={t.panel === "bookmarks"} onClick={() => t.setPanel(t.panel === "bookmarks" ? null : "bookmarks")}><BookmarkSimple size={18} />书签</button>
      <button type="button" aria-pressed={t.panel === "notes"} onClick={() => t.setPanel(t.panel === "notes" ? null : "notes")}><NotePencil size={18} />笔记与摘录</button>
      <button type="button" aria-label="书内搜索" aria-pressed={t.panel === "search"} onClick={() => t.setPanel(t.panel === "search" ? null : "search")}><MagnifyingGlass size={18} /></button>
      <button type="button" aria-label="阅读外观设置" aria-pressed={t.panel === "appearance"} onClick={() => t.setPanel(t.panel === "appearance" ? null : "appearance")}><GearSix size={18} /></button>
      <button type="button" aria-label="收起阅读工具" onClick={() => { t.setToolbarOpen(false); closePanel(); }}><X size={18} /></button>
    </nav>}</TransitionPresence>
    {(t.returnLocation || history?.canGoBack || history?.canGoForward) && <div className="reader-return-navigation" aria-label="阅读位置导航">
      <button type="button" disabled={!t.returnLocation && !history?.canGoBack} onClick={() => t.returnLocation ? t.goBack() : history?.back()}><CaretLeft size={16} />返回刚才的位置</button>
      {history?.canGoForward && <button type="button" aria-label="再次前进" onClick={history.forward}><CaretRight size={16} /></button>}
    </div>}
    {t.selection && !editing && <div className="reader-selection-tools" role="toolbar" aria-label="选文操作" style={{ left: Math.max(8, Math.min(t.selection.rect.x + t.selection.rect.width / 2 - 165, window.innerWidth - 350)), top: Math.max(70, Math.min(t.selection.rect.y + t.selection.rect.height + 12, window.innerHeight - 65)) }} onPointerDown={e => e.preventDefault()}>
      <button type="button" title="复制选文" aria-label="复制选文" onClick={() => void navigator.clipboard.writeText(t.selection!.text).then(() => setCopied("已复制")).catch(() => setCopied("复制失败，请重试"))}><Copy size={18} />{copied ?? "复制"}</button>
      <button type="button" disabled={t.busy} onClick={() => void t.saveSelection("highlight")}><Highlighter size={18} />高亮</button>
      <button type="button" disabled={t.busy} onClick={() => openEdit("selection")}><NotePencil size={18} />笔记</button>
      <button type="button" disabled={t.busy} onClick={() => void t.saveSelection("quote")}><Quotes size={18} />收藏语句</button>
      <button type="button" aria-label="取消选文" onClick={t.clearSelection}><X size={16} /></button>
    </div>}
    {(t.panel === "bookmarks" || t.panel === "notes" || t.panel === "search") && <aside className="reader-panel reader-panel--chapters reader-record-panel" data-open="true" aria-label={t.panel === "search" ? "书内搜索" : t.panel === "bookmarks" ? "书签" : "笔记与摘录"}>
      <header className="panel-header"><div><strong>{t.panel === "search" ? "书内搜索" : t.panel === "bookmarks" ? "书签" : "笔记与摘录"}</strong><span>{title}</span></div><button type="button" className="icon-button" aria-label="关闭阅读面板" onClick={closePanel}><X size={20} /></button></header>
      <div className="reader-record-controls">
        {t.panel === "search" ? <form onSubmit={e => { e.preventDefault(); void t.search(query); }}><label className="reader-sr-only" htmlFor="reader-search">搜索本书正文</label><input ref={searchInputRef} id="reader-search" value={query} onChange={e => { setQuery(e.target.value); t.cancelSearch(); }} onKeyDown={e => { if (e.code === "Escape") { e.preventDefault(); closePanel(); } }} placeholder="搜索本书正文" maxLength={200} /><button type="submit" disabled={!query.trim()}>查找</button></form> : <>
          <input aria-label="筛选阅读记录" placeholder="查找内容或笔记" value={filter} onChange={e => setFilter(e.target.value)} />
          {t.panel === "bookmarks" ? <button className="reader-add-bookmark" type="button" disabled={t.busy} onClick={() => void t.addBookmark(chapter)}><BookmarkSimple size={18} />添加当前位置</button> : <div className="reader-record-export-row">
            <button type="button" disabled={!records.length} onClick={() => exportNotes(records, title, author)}><Export size={16} />导出摘录</button>
            <button type="button" disabled={!records.length} onClick={() => copyText(formatRecordsMarkdown(records, title, author), "__all__")}><Copy size={16} />{copiedRecordId === "__all__" ? "已复制全部" : "复制全部"}</button>
          </div>}
        </>}
      </div>
      <div className="reader-record-list">
        {t.panel === "search" ? <>
          {t.searching && <p role="status">正在查找…</p>}
          {!t.searching && t.searched && <p className="reader-record-meta">{t.results.length >= 200 ? "显示前 200 个结果，请缩小关键词范围" : `找到 ${t.results.length} 处`}</p>}
          {!t.searching && !t.searched && <p className="reader-record-empty">输入关键词，查找这本书中的文字。</p>}
          {t.results.map(result => <button type="button" className="reader-search-result" key={result.id} onClick={() => t.jump(result.location)}>{result.text}</button>)}
        </> : <>
          {!records.length && <p className="reader-record-empty">{filter ? "没有匹配的记录。" : t.panel === "bookmarks" ? "把想再次翻看的位置留在这里。" : "选中正文，即可高亮、写笔记或收藏语句。"}</p>}
          {records.map(record => <article className="reader-record" id={`reading-record-${record.id}`} key={record.id} data-color={record.color}>
            <div className="reader-record-meta">{record.kind === "bookmark" ? "书签" : record.kind === "quote" ? "语句库" : record.kind === "note" ? "笔记" : "高亮"}<span>{new Date(record.createdAt).toLocaleDateString()}</span></div>
            <button type="button" className="reader-record-source" disabled={!record.location} onClick={() => record.location && t.jump(record.location)} title="回到原文">{record.kind === "bookmark" ? record.note || "未命名书签" : record.text}</button>
            {record.kind !== "bookmark" && record.note && <p className="reader-record-note">{record.note}</p>}
            <div className="reader-record-actions">
              {record.kind !== "bookmark" && <button type="button" onClick={() => copyText(record.note ? `${record.text}\n—— ${record.note}` : record.text, record.id)}>{copiedRecordId === record.id ? "已复制" : "复制"}</button>}
              <button type="button" onClick={() => openEdit(record)}>{record.kind === "bookmark" ? "重命名" : "编辑笔记"}</button>
              {confirmDelete === record.id ? <><button type="button" disabled={t.busy} onClick={() => void t.remove(record.id).then(ok => { if (ok) setConfirmDelete(null); })}>确认删除</button><button type="button" onClick={() => setConfirmDelete(null)}>取消</button></> : <button type="button" onClick={() => setConfirmDelete(record.id)}>删除</button>}
            </div>
          </article>)}
        </>}
      </div>
    </aside>}
    {(t.error || saveError || t.notice) && <div className="reader-tools-feedback" role={t.error || saveError ? "alert" : "status"}>{t.error || saveError || t.notice}{t.error && <button type="button" onClick={() => { t.setError(null); void t.refresh().catch(() => t.setError("记录载入失败，请重试。")); }}>重试载入</button>}</div>}
    <dialog ref={dialog} className="reader-note-dialog" aria-labelledby="reader-note-heading" onCancel={e => { e.preventDefault(); if (!t.busy) setEditing(null); }}>
      <form onSubmit={e => { e.preventDefault(); void (editing === "selection" ? t.saveSelection("note", note, color, selectionDraft) : editing ? t.update(editing, { note, color, ...(editing.kind === "highlight" && note.trim() ? { kind: "note" as const } : {}) }) : Promise.resolve(false)).then(ok => { if (ok) setEditing(null); }); }}>
        <header><h2 id="reader-note-heading">{editing && editing !== "selection" && editing.kind === "bookmark" ? "书签名称" : "阅读笔记"}</h2><button type="button" className="icon-button" aria-label="关闭笔记编辑" onClick={() => setEditing(null)}><X size={20} /></button></header>
        <blockquote>{editing === "selection" ? selectionDraft?.text : editing?.text}</blockquote>
        <label> {editing && editing !== "selection" && editing.kind === "bookmark" ? "名称" : "我的笔记"}<textarea value={note} maxLength={10000} onChange={e => setNote(e.target.value)} rows={4} /></label>
        {(!editing || editing === "selection" || editing.kind === "highlight" || editing.kind === "note") && <fieldset><legend>标记颜色</legend>{(["cyan", "yellow", "pink"] as const).map((value, i) => <label key={value}><input type="radio" name="highlight-color" value={value} checked={color === value} onChange={() => setColor(value)} />{["冰蓝", "浅金", "樱粉"][i]}</label>)}</fieldset>}
        {t.error && <p role="alert">{t.error}</p>}
        <footer><button type="button" onClick={() => setEditing(null)}>取消</button><button type="submit" disabled={t.busy}>{t.busy ? "保存中…" : "保存"}</button></footer>
      </form>
    </dialog>
  </>;
}
