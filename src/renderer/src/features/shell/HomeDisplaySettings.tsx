import { useState } from "react";
import type { BookSummary } from "../../../../shared/contracts.js";
import { resolveHomeDisplay, saveHomeDisplay, useHomeDisplay, type HomeDisplay } from "../library/home-display.js";

export function HomeDisplaySettings({ books }: { books: BookSummary[] }) {
  const preference = useHomeDisplay();
  const [slot, setSlot] = useState<"front" | "back" | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [error, setError] = useState("");
  const available = books.filter(book => book.availabilityStatus === "available").sort((a,b) => b.addedAt.localeCompare(a.addedAt));
  const continuation = available.filter(book => book.lastReadAt && book.progress < .995).sort((a,b) => (b.lastReadAt ?? "").localeCompare(a.lastReadAt ?? ""))[0];
  const pair = resolveHomeDisplay(available, preference, continuation ?? available[0]);
  function save(value: HomeDisplay) {
    try { saveHomeDisplay(value); setError(""); return true; }
    catch { setError("未能保存设置，请重试。"); return false; }
  }
  const results = available.filter(book => `${book.title} ${book.author ?? ""}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  function choose(book: BookSummary) {
    if (!slot) return;
    const other = slot === "front" ? "back" : "front";
    const next = { mode: "custom" as const, front: pair.front?.id ?? "", back: pair.back?.id ?? "" };
    if (next[other] === book.id) next[other] = next[slot];
    next[slot] = book.id;
    if (save(next)) setSlot(null);
  }
  return <section className="home-display-settings" aria-label="首页展示">
    <h2>首页展示</h2><p>挑选展台上的两本书。左侧“继续阅读”仍跟随实际阅读进度。</p>
    <div className="home-display-modes"><button className="button" aria-pressed={preference.mode === "auto"} onClick={() => { save({ ...preference, mode: "auto" }); setSlot(null); }}>自动选择</button><button className="button" aria-pressed={preference.mode === "custom"} onClick={() => save({ mode: "custom", front: pair.front?.id ?? "", back: pair.back?.id ?? "" })}>自定义</button></div>
    <div className="home-display-pair">{(["front", "back"] as const).map(position => {
      const book = pair[position];
      return <button key={position} className="home-display-slot" onClick={() => { setSlot(position); setQuery(""); setPage(0); }} aria-label={position === "front" ? "选择主封面" : "选择副封面"}>
        {book?.coverUrl ? <img src={book.coverUrl} alt="" /> : <span className="home-display-placeholder">暂无封面</span>}
        <span><small>{position === "front" ? "前面 · 主封面" : "后面 · 副封面"}</small><strong>{book?.title ?? "请选择书籍"}</strong><em>点击更换</em></span>
      </button>;
    })}</div>
    <button className="text-action" disabled={!pair.front || !pair.back} onClick={() => save({ mode: "custom", front: pair.back!.id, back: pair.front!.id })}>交换位置</button>
    <p className="home-display-hint">设置自动保存。书籍被移出书库时，展台会暂用其他可用书籍。</p>
    {error && <p role="alert">{error}</p>}
    {slot && <section className="home-display-picker" aria-label="选择展示书籍"><header><h3>{slot === "front" ? "选择主封面" : "选择副封面"}</h3><button className="text-action" onClick={() => setSlot(null)}>取消</button></header><input type="search" aria-label="搜索展示书籍" placeholder="搜索书名或作者" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} />
      <div className="home-display-results">{results.slice(page * 12, page * 12 + 12).map(book => <button key={book.id} onClick={() => choose(book)}>{book.coverUrl && <img src={book.coverUrl} alt="" loading="lazy" />}<span><strong>{book.title}</strong><small>{book.author || "未知作者"}</small></span></button>)}</div>
      {!results.length && <p>没有找到可展示的书籍。</p>}
      {results.length > 12 && <footer><button className="button" disabled={!page} onClick={() => setPage(page - 1)}>上一页</button><span>{page + 1} / {Math.ceil(results.length / 12)}</span><button className="button" disabled={(page + 1) * 12 >= results.length} onClick={() => setPage(page + 1)}>下一页</button></footer>}
    </section>}
  </section>;
}
