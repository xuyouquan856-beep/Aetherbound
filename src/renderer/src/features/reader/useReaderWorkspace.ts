import { useCallback, useEffect, useRef, useState } from "react";
import type { ReaderApi, ReadingLocationV1 } from "../../../../shared/contracts.js";
import type { ReadingRecord, SaveReadingRecord } from "../../../../shared/reading-records.js";
import type { ReaderMark, ReaderSearchResult, ReaderSelection } from "../../renditions/reading-tools.js";

export type ReaderPanel = "toc" | "appearance" | "images" | "bookmarks" | "notes" | "search" | null;
type Options = {
  api: ReaderApi;
  book: { id: string; title: string; author: string | null };
  sourceRevision: string;
  navigate(location: ReadingLocationV1): void;
  clearSelection(): void;
  setMarks(marks: ReaderMark[]): void;
  search(query: string, isCurrent: () => boolean): Promise<ReaderSearchResult[]>;
  active: boolean;
};

export function editableRecord(record: ReadingRecord): SaveReadingRecord {
  const { id, kind, bookId, bookTitle, author, text, excerpt, sourceUrl, note, color, location, endLocation, enabled, pinned } = record;
  return { id, kind, bookId, bookTitle, author, text, excerpt, sourceUrl, note, color, location, endLocation, enabled, pinned };
}

export function useReaderWorkspace(options: Options) {
  const ref = useRef(options); ref.current = options;
  const [panel, setPanel] = useState<ReaderPanel>(null);
  const [toolbarOpen, setToolbarOpen] = useState(false);
  const [selection, setSelection] = useState<ReaderSelection | null>(null);
  const [records, setRecords] = useState<ReadingRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<ReaderSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [returnLocation, setReturnLocation] = useState<ReadingLocationV1 | null>(null);
  const currentLocation = useRef<ReadingLocationV1 | null>(null);
  const mutation = useRef(false);
  const searchVersion = useRef(0);
  const alive = useRef(true);
  const readVersion = useRef(0);

  const refresh = useCallback(async () => {
    const { api, book } = ref.current;
    if (!api.records) return;
    const version = ++readVersion.current;
    const next = await api.records.list({ bookId: book.id });
    if (alive.current && version === readVersion.current && ref.current.book.id === book.id) setRecords(next);
  }, []);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; readVersion.current++; searchVersion.current++; };
  }, [options.book.id]);
  useEffect(() => {
    if (options.active) void refresh().catch(() => { if (alive.current) setError("阅读记录暂时无法载入，请重试。"); });
  }, [options.book.id, options.active, refresh]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  const applyMarks = useCallback(() => {
    ref.current.setMarks(records.filter(r => (r.kind === "highlight" || r.kind === "note") && r.location?.sourceRevision === ref.current.sourceRevision)
      .map(r => ({ id: r.id, location: r.location!, endLocation: r.endLocation ?? undefined, color: r.color })));
  }, [records]);
  useEffect(applyMarks, [applyMarks]);

  const transact = useCallback(async (action: () => Promise<void>, success: string) => {
    if (mutation.current) return false;
    if (!ref.current.api.records) { setError("当前版本未连接阅读记录服务。"); return false; }
    readVersion.current++;
    mutation.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      await action();
      if (alive.current) setNotice(success);
      return true;
    } catch {
      if (alive.current) setError("保存失败，内容已保留。请重试。");
      return false;
    } finally {
      mutation.current = false;
      if (alive.current) setBusy(false);
    }
  }, []);
  const save = useCallback(async (input: SaveReadingRecord) => {
    const saved = await ref.current.api.records!.save(input);
    if (alive.current) setRecords(previous => [saved, ...previous.filter(r => r.id !== saved.id)]);
  }, []);
  const clearSelection = useCallback(() => { ref.current.clearSelection(); setSelection(null); }, []);
  const saveSelection = useCallback(async (kind: "quote" | "highlight" | "note", note = "", color: ReadingRecord["color"] = "cyan", source = selection) => {
    if (!source?.text.trim()) return false;
    const { book } = ref.current;
    const longQuote = kind === "quote" && source.text.length > 220;
    const ok = await transact(() => save({ kind, bookId: book.id, bookTitle: book.title, author: book.author,
      text: source.text, note, color, location: source.location, endLocation: source.endLocation,
      enabled: kind === "quote" && !longQuote, pinned: false }), longQuote ? "已收藏全文；在语句库填写首页节选后可加入轮换" : kind === "quote" ? "已收藏到语句库" : kind === "note" ? "笔记已保存" : "已添加高亮");
    if (ok) clearSelection();
    return ok;
  }, [clearSelection, save, selection, transact]);
  const addBookmark = useCallback(async (name: string) => {
    const location = currentLocation.current;
    if (!location) { setError("正文位置尚未就绪，请稍后添加书签。"); return; }
    const { book } = ref.current;
    await transact(() => save({ kind: "bookmark", bookId: book.id, bookTitle: book.title, author: book.author,
      text: location.text.exact, note: name, color: "cyan", location, enabled: false, pinned: false }), "书签已保存");
  }, [save, transact]);
  const update = useCallback((record: ReadingRecord, changes: Partial<SaveReadingRecord>) =>
    transact(() => save({ ...editableRecord(record), ...changes }), "修改已保存"), [save, transact]);
  const remove = useCallback((id: string) => transact(async () => {
    await ref.current.api.records!.remove({ id });
    if (alive.current) setRecords(previous => previous.filter(r => r.id !== id));
  }, "记录已删除"), [transact]);
  const jump = useCallback((location: ReadingLocationV1) => {
    if (location.sourceRevision !== ref.current.sourceRevision) {
      setError("书籍版本已变化，原文位置需要重新确认。已保留收藏内容。"); return false;
    }
    setError(null); setReturnLocation(currentLocation.current);
    ref.current.navigate(location); clearSelection(); setPanel(null);
    return true;
  }, [clearSelection]);
  const goBack = useCallback(() => {
    if (!returnLocation) return;
    ref.current.navigate(returnLocation); setReturnLocation(null); setPanel(null); clearSelection();
  }, [clearSelection, returnLocation]);
  const search = useCallback(async (query: string) => {
    const version = ++searchVersion.current;
    setResults([]); setSearched(false); setError(null);
    if (!query.trim()) { setSearching(false); return; }
    setSearching(true);
    const isCurrent = () => alive.current && version === searchVersion.current;
    try {
      const next = await ref.current.search(query.trim(), isCurrent);
      if (isCurrent()) { setResults(next); setSearched(true); }
    } catch { if (isCurrent()) setError("搜索失败，请重试。"); }
    finally { if (isCurrent()) setSearching(false); }
  }, []);
  const searchAndJump = useCallback(async (query: string, preferredChapterId?: string) => {
    const trimmed = query.trim();
    if (!trimmed) return;
    const version = ++searchVersion.current;
    setResults([]); setSearched(false); setError(null); setSearching(true);
    const isCurrent = () => alive.current && version === searchVersion.current;
    try {
      const next = await ref.current.search(trimmed, isCurrent);
      if (!isCurrent()) return;
      setResults(next);
      setSearched(true);
      const target = (preferredChapterId
        ? next.find((item) =>
            (item.location.format === "txt" && item.location.primary.chapterId === preferredChapterId)
            || (item.location.format === "epub" && item.location.primary.spineHref.split("#", 1)[0] === preferredChapterId.split("#", 1)[0]))
        : undefined) ?? next[0];
      if (target) {
        setReturnLocation(currentLocation.current);
        ref.current.navigate(target.location);
        clearSelection();
      }
    } catch {
      if (isCurrent()) setError("搜索失败，请重试。");
    } finally {
      if (isCurrent()) setSearching(false);
    }
  }, [clearSelection]);
  const cancelSearch = useCallback(() => { searchVersion.current++; setSearching(false); setResults([]); setSearched(false); }, []);
  const onLocation = useCallback((location: ReadingLocationV1) => { currentLocation.current = location; }, []);
  const toggleToolbar = useCallback(() => { if (ref.current.active) { setToolbarOpen(v => !v); setPanel(null); } }, []);
  const onMarkClick = useCallback((id: string) => { setPanel("notes"); setToolbarOpen(true); setNotice("已打开笔记列表");
    requestAnimationFrame(() => document.getElementById(`reading-record-${id}`)?.scrollIntoView({ block: "nearest" }));
  }, []);
  return { panel, setPanel, toolbarOpen, setToolbarOpen, toggleToolbar, selection, setSelection, clearSelection,
    records, error, setError, notice, busy, addBookmark, saveSelection, update, remove, jump, goBack, returnLocation,
    results, search, searchAndJump, searching, searched, cancelSearch, onLocation, applyMarks, refresh, onMarkClick };
}
export type ReaderWorkspace = ReturnType<typeof useReaderWorkspace>;
