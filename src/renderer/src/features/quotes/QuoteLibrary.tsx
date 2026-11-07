import { TransitionPresence } from "../shell/TransitionPresence.js";
import { useEffect, useMemo, useState } from "react";
import { DownloadSimple, Plus, UploadSimple } from "@phosphor-icons/react";
import type { BookSummary } from "../../../../shared/contracts.js";
import type { ReadingRecord, ReadingRecordsApi, SaveReadingRecord } from "../../../../shared/reading-records.js";
import { parseQuoteImport, type ImportedQuote } from "./quote-transfer.js";
import "../../styles/quotes.css";

type Props = {
  api: ReadingRecordsApi | undefined;
  books: BookSummary[];
  onOpenSource(record: ReadingRecord): void;
  onChanged?(): void;
  onOpenUrl?(url: string): Promise<void>;
};
type Filter = "all" | "enabled" | "disabled" | "pinned";
type KindFilter = ReadingRecord["kind"] | "all";
const PAGE_SIZE = 12;

const KIND_LABELS: Record<ReadingRecord["kind"], string> = {
  quote: "摘录",
  highlight: "划线",
  note: "笔记",
  bookmark: "书签",
};

function download(name: string, content: string, mime: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function payload(record: ReadingRecord): SaveReadingRecord {
  return { id: record.id, kind: record.kind, bookId: record.bookId, bookTitle: record.bookTitle,
    author: record.author, text: record.text, excerpt: record.excerpt, sourceUrl: record.sourceUrl, note: record.note, color: record.color,
    location: record.location, endLocation: record.endLocation ?? null,
    enabled: record.enabled, pinned: record.pinned };
}

export function QuoteLibrary({ api, books, onOpenSource, onChanged, onOpenUrl }: Props) {
  const [records, setRecords] = useState<ReadingRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [kindFilter, setKindFilter] = useState<KindFilter>("quote");
  const [bookFilter, setBookFilter] = useState<string>("");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<ReadingRecord | null>(null);
  const [editing, setEditing] = useState<ReadingRecord | "new" | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importItems, setImportItems] = useState<ImportedQuote[]>([]);
  const [importSelected, setImportSelected] = useState<number[]>([]);
  const [importMessage, setImportMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!selected && !editing && !importOpen) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = Array.from(document.querySelectorAll<HTMLElement>(".quote-modal-backdrop [role=dialog]")).find(element => !element.closest("[inert]"));
    const focusables = () => Array.from(dialog?.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled])") ?? []);
    focusables()[0]?.focus();
    const onEscape = (event: KeyboardEvent) => {
      if (busy && event.key === "Escape") { event.preventDefault(); return; }
      if (event.key === "Tab") {
        const available = focusables();
        if (!available.length) return;
        const first = available[0], last = available[available.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        return;
      }
      if (event.key !== "Escape") return;
      if (editing) setEditing(null);
      else if (importOpen) setImportOpen(false);
      else setSelected(null);
    };
    window.addEventListener("keydown", onEscape);
    return () => { window.removeEventListener("keydown", onEscape); previousFocus?.focus(); };
  }, [selected, editing, importOpen, busy]);

  useEffect(() => {
    let alive = true;
    if (!api) { setLoading(false); setError("摘录服务尚未就绪。"); return; }
    setLoading(true);
    const listQuery = kindFilter === "all" ? {} : { kind: kindFilter };
    api.list(listQuery).then((items) => { if (alive) setRecords(items); })
      .catch(() => { if (alive) setError("无法读取摘录，请稍后重试。"); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [api, kindFilter]);

  const filtered = useMemo(() => records.filter((record) => {
    const matchesFilter = filter === "all" || (filter === "enabled" && record.enabled)
      || (filter === "disabled" && !record.enabled) || (filter === "pinned" && record.pinned);
    const matchesBook = !bookFilter || record.bookId === bookFilter;
    const searchText = `${record.text} ${record.excerpt} ${record.note} ${record.bookTitle} ${record.author ?? ""}`.toLocaleLowerCase();
    return matchesFilter && matchesBook && searchText.includes(query.trim().toLocaleLowerCase());
  }), [records, filter, bookFilter, query]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const visible = filtered.slice(Math.min(page, pageCount - 1) * PAGE_SIZE, (Math.min(page, pageCount - 1) + 1) * PAGE_SIZE);

  async function save(input: SaveReadingRecord) {
    if (!api) return;
    setBusy(true); setError("");
    try {
      const next = await api.save(input);
      setRecords((current) => [next, ...current.filter((record) => record.id !== next.id)]);
      setSelected((current) => current?.id === next.id ? next : current);
      setEditing(null); onChanged?.();
      if (next.pinned) {
        const listQuery = kindFilter === "all" ? {} : { kind: kindFilter };
        void api.list(listQuery).then(setRecords).catch(() => undefined);
      }
    } catch { setError("保存失败，填写的内容仍保留。请重试。"); }
    finally { setBusy(false); }
  }

  async function update(record: ReadingRecord, changes: Partial<SaveReadingRecord>) {
    if ((changes.enabled === true || changes.pinned === true) && (record.excerpt || record.text).length > 220) {
      setError("这段摘录较长，请先填写 220 字以内的首页节选。");
      return;
    }
    await save({ ...payload(record), ...changes, ...(changes.enabled === false ? { pinned: false } : {}) });
  }

  async function remove(record: ReadingRecord) {
    if (!api || !window.confirm("删除这条摘录？此操作无法撤销。")) return;
    setBusy(true); setError("");
    try {
      await api.remove({ id: record.id });
      setRecords((current) => current.filter((item) => item.id !== record.id));
      setSelected(null); onChanged?.();
    } catch { setError("删除失败，请重试。"); }
    finally { setBusy(false); }
  }

  function prepareImport(raw: string) {
    try {
      const result = parseQuoteImport(raw, records.map((record) => record.text));
      setImportItems(result.items);
      setImportSelected(result.items.map((_, index) => index));
      setImportMessage(`${result.items.length} 条可导入，${result.skipped} 条重复或无效项已跳过。`);
    } catch (cause) {
      setImportItems([]); setImportSelected([]);
      setImportMessage(cause instanceof Error ? cause.message : "无法解析文件。");
    }
  }

  async function commitImport() {
    if (!api) return;
    setBusy(true); setError("");
    let imported = 0;
    try {
      for (const index of importSelected) {
        const item = importItems[index];
        const saved = await api.save({ kind: "quote", bookId: null, bookTitle: item.bookTitle,
          author: item.author || null, text: item.text, excerpt: item.excerpt ?? "", sourceUrl: item.sourceUrl ?? "", note: item.note ?? "", color: item.color ?? "cyan",
          location: null, endLocation: null, enabled: item.enabled, pinned: false });
        setRecords((current) => [saved, ...current]);
        imported++;
        setImportSelected(current => current.filter(value => value !== index));
      }
      setImportOpen(false);
    } catch { setError(`已导入 ${imported} 条，其余未完成。请检查后重试。`); }
    finally { setBusy(false); if (imported) onChanged?.(); }
  }

  function exportJson() {
    download("aetherbound-quotes.json", JSON.stringify({ version: 1, items: filtered.map((record) => ({
      kind: record.kind, text: record.text, author: record.author, bookTitle: record.bookTitle,
      work: record.bookTitle, excerpt: record.excerpt, sourceUrl: record.sourceUrl, url: record.sourceUrl,
      note: record.note, color: record.color, enabled: record.enabled,
    })) }, null, 2), "application/json");
  }

  function exportMarkdown() {
    download("aetherbound-quotes.md", filtered.map((record) =>
      `> [${KIND_LABELS[record.kind]}] ${record.text.replace(/\n/g, "\n> ")}\n\n— ${record.author || "未署名"}${record.bookTitle ? `，《${record.bookTitle}》` : ""}${record.note ? `\n\n${record.note}` : ""}`).join("\n\n---\n\n"), "text/markdown");
  }

  return <section className="quote-library" aria-label="摘录库">
    <header className="quote-library__header">
      <div><span className="quote-library__eyebrow">WORDS TO KEEP</span><h1>摘录与阅读记录</h1><p>留住书中的句子、划线、笔记与书签，随时温故知新。</p></div>
      <div className="quote-library__header-actions">
        <button type="button" onClick={() => setEditing("new")}><Plus size={17} /> 添加摘录</button>
        <button type="button" onClick={() => { setImportOpen(true); setImportItems([]); setImportMessage(""); }}><UploadSimple size={17} /> 导入</button>
        <button type="button" onClick={exportJson} disabled={!filtered.length}><DownloadSimple size={17} /> JSON</button>
        <button type="button" onClick={exportMarkdown} disabled={!filtered.length}>Markdown</button>
      </div>
    </header>
    {error && <p className="quote-library__error" role="alert">{error}</p>}
    <div className="quote-library__kind-tabs" role="group" aria-label="记录类型切换">
      {([
        ["quote", "摘录"],
        ["highlight", "划线"],
        ["note", "笔记"],
        ["bookmark", "书签"],
        ["all", "全部记录"],
      ] as const).map(([key, label]) => (
        <button
          key={key}
          type="button"
          className={`library-filter-pill ${kindFilter === key ? "library-filter-pill--active" : ""}`}
          aria-pressed={kindFilter === key}
          onClick={() => { setKindFilter(key); setPage(0); }}
        >
          {label}
        </button>
      ))}
    </div>
    <div className="quote-library__tools">
      <label>搜索摘录<input value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} placeholder="文字、笔记、书名或作者" /></label>
      <label>筛选<select value={filter} onChange={(event) => { setFilter(event.target.value as Filter); setPage(0); }}>
        <option value="all">全部</option><option value="enabled">参与首页</option><option value="disabled">暂不展示</option><option value="pinned">已固定</option>
      </select></label>
      {books.length > 0 && (
        <label>书籍<select aria-label="按书籍筛选记录" value={bookFilter} onChange={(event) => { setBookFilter(event.target.value); setPage(0); }}>
          <option value="">全部书籍</option>
          {books.map((book) => <option key={book.id} value={book.id}>{book.title}</option>)}
        </select></label>
      )}
      <span>{filtered.length} 条</span>
    </div>
    {loading ? <p>正在读取摘录…</p> : visible.length ? <div className="quote-library__grid">
      {visible.map((record) => <article className={`quote-card ${record.pinned ? "quote-card--pinned" : ""}`} key={record.id}>
        <button className="quote-card__body" type="button" onClick={() => setSelected(record)} aria-label={`查看摘录：${record.text.slice(0, 40)}`}>
          {kindFilter !== "quote" && <small className="quote-card__kind-badge">{KIND_LABELS[record.kind]}</small>}
          <blockquote>{record.excerpt || record.text}</blockquote>
          {record.note && <p className="quote-card__note-preview">{record.note}</p>}
          <span>{record.author || "未署名"}{record.bookTitle ? ` · ${record.bookTitle}` : ""}</span>
        </button>
        <div className="quote-card__actions">
          <label><input type="checkbox" checked={record.enabled} disabled={busy} onChange={(event) => void update(record, { enabled: event.target.checked })} />首页</label>
          <button type="button" aria-pressed={record.pinned} disabled={busy} onClick={() => void update(record, { pinned: !record.pinned, enabled: !record.pinned ? true : record.enabled })}>{record.pinned ? "取消固定" : "固定"}</button>
          {record.bookId && record.location && books.some((book) => book.id === record.bookId && book.availabilityStatus === "available") && (
            <button type="button" onClick={() => onOpenSource(record)}>跳转原文</button>
          )}
          <button type="button" onClick={() => setEditing(record)}>编辑</button>
        </div>
      </article>)}
    </div> : <div className="quote-library__empty">{records.length ? "没有符合条件的摘录。" : "摘录库还是空的。添加一句喜欢的话，或在阅读时收藏选文。"}</div>}
    <nav className="quote-library__pages" aria-label="摘录分页"><button type="button" disabled={page <= 0} onClick={() => setPage(page - 1)}>上一页</button><span>{Math.min(page, pageCount - 1) + 1} / {pageCount}</span><button type="button" disabled={page >= pageCount - 1} onClick={() => setPage(page + 1)}>下一页</button></nav>
    <TransitionPresence>{selected && !editing && <div className="quote-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelected(null); }}><div className="quote-modal" role="dialog" aria-modal="true" aria-labelledby="quote-detail-title">
      <div className="quote-modal__head"><h2 id="quote-detail-title">摘录详情</h2><button type="button" onClick={() => setSelected(null)} aria-label="关闭">×</button></div>
      {error && <p role="alert">{error}</p>}
      <blockquote className="quote-modal__text">{selected.text}</blockquote><p>{selected.author || "未署名"}{selected.bookTitle ? ` · 《${selected.bookTitle}》` : ""}</p>
      {selected.excerpt && <p className="quote-modal__note">首页节选：{selected.excerpt}</p>}
      {selected.sourceUrl && <a className="quote-modal__source" href={selected.sourceUrl} onClick={event => { if (onOpenUrl) { event.preventDefault(); void onOpenUrl(selected.sourceUrl).catch(() => setError("出处链接暂时无法打开。")); } }} target="_blank" rel="noopener noreferrer">查看出处 ↗</a>}
      {selected.note && <p className="quote-modal__note">{selected.note}</p>}
      {selected.bookId && selected.location && <button type="button" disabled={!books.some((book) => book.id === selected.bookId && book.availabilityStatus === "available")} onClick={() => onOpenSource(selected)}>回到原文</button>}
      {(selected.bookId || selected.location) && !books.some((book) => book.id === selected.bookId && book.availabilityStatus === "available") && <p role="status">原书当前不可用；摘录仍会保留。</p>}
      <div className="quote-modal__actions"><button type="button" onClick={() => setEditing(selected)}>编辑</button><button type="button" onClick={() => void remove(selected)} disabled={busy}>删除</button></div>
    </div></div>}</TransitionPresence>
    <TransitionPresence>{editing && <QuoteEditor error={error} record={editing === "new" ? null : editing} busy={busy} onClose={() => setEditing(null)} onSave={(input) => void save(input)} />}</TransitionPresence>
    <TransitionPresence>{importOpen && <div className="quote-modal-backdrop"><div className="quote-modal" role="dialog" aria-modal="true" aria-labelledby="quote-import-title">
      <div className="quote-modal__head"><h2 id="quote-import-title">导入摘录</h2><button type="button" onClick={() => setImportOpen(false)} aria-label="关闭">×</button></div>
      <p>支持摘录库 JSON 文件及预览版语句库导出的 JSON。每次最多 2 MB、500 条。</p>
      <input disabled={busy} type="file" accept=".json,application/json" aria-label="选择 JSON 文件" onChange={(event) => { const file = event.target.files?.[0]; if (file) void file.text().then(prepareImport).catch(() => setImportMessage("文件读取失败。")); }} />
      <textarea disabled={busy} aria-label="粘贴 JSON" rows={4} placeholder="也可在此粘贴 JSON" onChange={(event) => prepareImport(event.target.value)} />
      {error && <p role="alert" className="quote-library__error">{error}</p>}
      {importMessage && <p role="status">{importMessage}</p>}
      <div className="quote-import-list">{importItems.map((item, index) => <label key={index}><input disabled={busy} type="checkbox" checked={importSelected.includes(index)} onChange={(event) => setImportSelected((current) => event.target.checked ? [...current, index] : current.filter((value) => value !== index))} /><span>{item.text.slice(0, 180)}</span></label>)}</div>
      <div className="quote-modal__actions"><button type="button" onClick={() => setImportOpen(false)}>取消</button><button type="button" disabled={busy || !importSelected.length} onClick={() => void commitImport()}>导入所选</button></div>
    </div></div>}</TransitionPresence>

  </section>;
}

function QuoteEditor({ record, busy, error, onClose, onSave }: { error: string; record: ReadingRecord | null; busy: boolean; onClose(): void; onSave(input: SaveReadingRecord): void }) {
  const [text, setText] = useState(record?.text ?? "");
  const [excerpt, setExcerpt] = useState(record?.excerpt ?? "");
  const [sourceUrl, setSourceUrl] = useState(record?.sourceUrl ?? "");
  const [author, setAuthor] = useState(record?.author ?? "");
  const [bookTitle, setBookTitle] = useState(record?.bookTitle ?? "");
  const [note, setNote] = useState(record?.note ?? "");
  const [enabled, setEnabled] = useState(record?.enabled ?? true);
  const [color, setColor] = useState<"cyan" | "yellow" | "pink">(record?.color ?? "cyan");
  const longWithoutExcerpt = enabled && (excerpt.trim() || text.trim()).length > 220;
  const invalidUrl = Boolean(sourceUrl.trim()) && !/^https?:\/\//i.test(sourceUrl.trim());
  return <div className="quote-modal-backdrop"><form className="quote-modal quote-editor" role="dialog" aria-modal="true" aria-labelledby="quote-editor-title" onSubmit={(event) => {
    event.preventDefault();
    if (!text.trim()) return;
    onSave({ ...(record ? payload(record) : { kind: "quote", bookId: null, location: null, endLocation: null, pinned: false }),
      text: text.trim(), excerpt: excerpt.trim(), sourceUrl: sourceUrl.trim(), author: author.trim() || null,
      bookTitle: bookTitle.trim(), note: note.trim(), color, enabled, pinned: enabled ? record?.pinned ?? false : false });
  }}>
    <div className="quote-modal__head"><h2 id="quote-editor-title">{record ? "编辑摘录" : "添加摘录"}</h2><button type="button" onClick={onClose} aria-label="关闭">×</button></div>
    <label>摘录原文<textarea required maxLength={8000} rows={5} value={text} onChange={(event) => setText(event.target.value)} /></label>
    <label>首页节选（可选，最多 220 字）<textarea maxLength={220} rows={2} value={excerpt} onChange={(event) => setExcerpt(event.target.value)} /></label>
    <div className="quote-editor__row"><label>作者<input maxLength={150} value={author} onChange={(event) => setAuthor(event.target.value)} /></label><label>作品 / 书名<input maxLength={200} value={bookTitle} onChange={(event) => setBookTitle(event.target.value)} /></label></div>
    <label>出处链接（可选）<input type="url" maxLength={2048} value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} placeholder="https://…" /></label>
    <label>感想<textarea maxLength={2000} rows={3} value={note} onChange={(event) => setNote(event.target.value)} /></label>
    <div className="quote-editor__row"><label>标记颜色<select value={color} onChange={(event) => setColor(event.target.value as typeof color)}><option value="cyan">青色</option><option value="yellow">黄色</option><option value="pink">粉色</option></select></label><label className="quote-editor__check"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> 参与首页轮换</label></div>
    {error && <p role="alert" className="quote-library__error">{error}</p>}
    {longWithoutExcerpt && <p className="quote-editor__warning">原文较长，请填写 220 字以内的首页节选，或取消首页轮换。</p>}
    {invalidUrl && <p className="quote-editor__warning">出处链接仅支持 http 或 https。</p>}
    <div className="quote-modal__actions"><button type="button" onClick={onClose}>取消</button><button type="submit" disabled={busy || !text.trim() || longWithoutExcerpt || invalidUrl}>保存</button></div>
  </form></div>;
}
