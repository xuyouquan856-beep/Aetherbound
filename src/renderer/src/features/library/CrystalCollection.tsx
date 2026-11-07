import { useEffect, useRef, useState } from "react";
import { Books } from "@phosphor-icons/react";
import type { CollectionSummary } from "../../../../shared/contracts.js";
import { crystalStyle, useCrystalAppearance, type CrystalAppearance } from "./crystal-preferences.js";
import { GeneratedBookCover } from "./GeneratedBookCover.js";
import { PublicationCoverImage } from "./PublicationCoverImage.js";

const paths = ["M260 357Q224 391 174 380T45 405", "M260 357Q308 392 354 376T475 405", "M260 370Q268 414 199 422T81 413", "M260 370Q300 422 345 421T450 410", "M176 382Q141 362 105 382L60 367", "M352 379Q385 359 427 380L487 367", "M180 383Q144 410 116 398L87 387", "M345 381Q375 409 410 396L442 386", "M213 417Q169 438 142 425", "M310 416Q351 439 398 427"];
export function CrystalCollection({ collection, onSelect, previewAppearance }: { collection: CollectionSummary; onSelect(id: string): void; previewAppearance?: CrystalAppearance }) {
  const stored = useCrystalAppearance(collection.id);
  const appearance = previewAppearance ?? stored.appearance;
  const Surface = previewAppearance ? "div" : "button";
  const root = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!root.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: "80px" });
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  return <article ref={root} className="crystal-collection" data-collection-stack data-visible={visible} style={crystalStyle(appearance)}>
    <Surface className="crystal-collection__button" aria-label={previewAppearance ? "水晶配色预览" : `打开珍藏《${collection.name}》，共 ${collection.bookCount} 本`} onClick={() => !previewAppearance && onSelect(collection.id)} onPointerMove={event => {
      const rect = event.currentTarget.getBoundingClientRect();
      event.currentTarget.style.setProperty("--crystal-reflection-x", `${Math.round((event.clientX - rect.left) / rect.width * 100)}%`);
    }} onPointerLeave={event => event.currentTarget.style.removeProperty("--crystal-reflection-x")}>
      <span className="crystal-stage" aria-hidden="true">
        <svg className="crystal-veins" viewBox="0 0 520 464">{paths.map((d, i) => <g key={d}><path d={d} /><path className="crystal-flow" pathLength="1" d={d} style={{ animationDelay: `${-i * .3}s` }} /></g>)}</svg>
        {collection.previewBooks.slice(0, 3).map((book, index) => <span key={book.id} className={`crystal-book crystal-book--${index}`}>
          <span className="crystal-book__body"><GeneratedBookCover book={book} />{book.coverUrl && <PublicationCoverImage className="crystal-book__image" url={book.coverUrl} alt="" loading="lazy" />}<span className="crystal-book__tint" /><span className="crystal-book__reflection" /><span className="crystal-book__light" /></span>
          <svg className="crystal-facets" viewBox="0 0 200 300" preserveAspectRatio="none"><path d="M10 0H190L181 9H19Z M0 10L10 0L19 9L9 18V282L0 290Z M190 0L200 10V290L191 282V18L181 9Z M0 290L10 300H190L200 290L181 291H19Z" /><path className="crystal-facets__edge" d="M10 1H190L199 10V290L190 299H10L1 290V10Z M19 9H181L191 18V282L181 291H19L9 282V18Z" /></svg>
        </span>)}
        {!collection.previewBooks.length && <span className="crystal-empty"><Books size={48} /><span>等待收藏第一本书</span></span>}
      </span>
      {!previewAppearance && <span className="crystal-caption"><strong>{collection.name}</strong><span>{collection.bookCount} 本藏书</span><em>走进珍藏 <b>→</b></em></span>}
    </Surface>
  </article>;
}
