import { useEffect, useMemo, useState, useRef, useLayoutEffect, type CSSProperties } from "react";
import type { ReadingRecord, ReadingRecordsApi } from "../../../../shared/reading-records.js";

export function HomeQuote({ api, revision, onManage }: { api: ReadingRecordsApi | undefined; revision: number; onManage(): void }) {
  const [records, setRecords] = useState<ReadingRecord[]>([]);
  const [index, setIndex] = useState(0);
  useEffect(() => {
    let alive = true;
    void api?.list({ kind: "quote" }).then((items) => { if (alive) { setRecords(items.filter((item) => item.enabled && (item.excerpt || item.text).length <= 220)); setIndex(Math.floor(Math.random() * Math.max(1, items.length))); } }).catch(() => undefined);
    return () => { alive = false; };
  }, [api, revision]);
  const pool = useMemo(() => {
    const pinned = records.find((item) => item.pinned);
    return pinned ? [pinned] : records;
  }, [records]);
  const current = pool[index % pool.length];
  const quoteText = current?.excerpt || current?.text || "There is no frigate like a book\nTo take us lands away,";
  const inscription = useRef<HTMLDivElement>(null);
  const previousText = useRef(quoteText);
  useLayoutEffect(() => {
    const changed = previousText.current !== quoteText;
    previousText.current = quoteText;
    if (!changed || !inscription.current?.animate || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const animation = inscription.current.animate([{ opacity: .15, translate: "0 5px" }, { opacity: 1, translate: "0 0" }], { duration: 260, easing: "cubic-bezier(.22,1,.36,1)" });
    return () => animation.cancel();
  }, [quoteText]);
  const attribution = current ? current.author || "未署名" : "Emily Dickinson";
  return <section className="quote-home" aria-label="首页摘录">

    <div className="quote-home__inscription" ref={inscription}>
    <button className="quote-home__text" type="button" onClick={() => { if (pool.length > 1) setIndex(value => (value + 1 + Math.floor(Math.random() * (pool.length - 1))) % pool.length); }} aria-label="更换首页摘录" title={pool.length === 0 ? "在设置中添加摘录后可轮换" : pool.length === 1 ? current?.pinned ? "当前摘录已固定" : "当前只有一条参与轮换的摘录" : "点击更换摘录"}>{quoteText}</button>
    {[[7,13,21,-1],[48,19,26,.4],[24,49,18,-3],[56,82,24,-.4],[83,88,15,-4]].map(([x,y,size,delay], i) => <span key={i} className="quote-jewel" aria-hidden="true" style={{ left:`${x}%`, top:`${y}%`, "--spark-size":`${size}px`, "--spark-delay":`${delay}s` } as CSSProperties} />)}
    </div>
    <cite>{attribution}{current?.bookTitle ? ` · ${current.bookTitle}` : ""}</cite>
  </section>;
}
