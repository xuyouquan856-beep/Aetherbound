import { useContext } from "react";
import { HomeImportContext } from "../shell/HomeImportContext.js";
import { useHomeDisplay, resolveHomeDisplay } from "./home-display.js";
import { ArrowRight, FolderSimple } from "@phosphor-icons/react";
import type { BookSummary, CollectionSummary } from "../../../../shared/contracts.js";
import type { ReadingRecordsApi } from "../../../../shared/reading-records.js";
import { HomeQuote } from "../quotes/HomeQuote.js";
import { BookTile } from "./BookTile.js";
import { ButterflyMark } from "../shell/ButterflyMark.js";
import { CollectionStack } from "./CollectionStack.js";

type LibraryHomeProps = {
  books: BookSummary[];
  collections: CollectionSummary[];
  unorganizedCount: number;
  onOpen(book: BookSummary): void;
  onOpenDetails?(book: BookSummary): void;
  onNavigateToBooks(): void;
  onNavigateToCollections(collectionId?: string): void;
  onNavigateUnorganized(): void;
  recordsApi?: ReadingRecordsApi;
  quoteRevision?: number;
  onManageQuotes?(): void;
};

export function LibraryHome({
  books,
  collections,
  unorganizedCount,
  onOpen,
  onOpenDetails,
  onNavigateToBooks,
  onNavigateToCollections,
  onNavigateUnorganized,
  recordsApi,
  quoteRevision = 0,
  onManageQuotes,
}: LibraryHomeProps) {
  const display = useHomeDisplay();
  const importControl = useContext(HomeImportContext);
  const availableBooks = books.filter((book) => book.availabilityStatus === "available");
  const readingQueue = availableBooks
    .filter((book) => (book.lastReadAt || book.progress > 0) && book.progress < 0.995)
    .sort((left, right) =>
      (right.lastReadAt ?? "").localeCompare(left.lastReadAt ?? "") || left.id.localeCompare(right.id));
  const continuation = availableBooks
    .filter((book) => book.lastReadAt && book.progress < 0.995)
    .sort((left, right) =>
      (right.lastReadAt ?? "").localeCompare(left.lastReadAt ?? "") || left.id.localeCompare(right.id))[0];
  const recentBooks = availableBooks
    .slice()
    .sort((left, right) => right.addedAt.localeCompare(left.addedAt) || left.id.localeCompare(right.id))
    .slice(0, 6);
  const recentCollections = collections
    .slice()
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
    .slice(0, 6);

  const featured = continuation ?? recentBooks[0];
  const { front, back: companion } = resolveHomeDisplay([...availableBooks].sort((a, b) => b.addedAt.localeCompare(a.addedAt)), display, featured);
  return (
    <div className="library-home library-home--constellation">
      <header className="library-home__masthead"><div className="library-home__title"><span className="library-page-index">01</span><h1>书房</h1><span className="library-home__rule" /></div><div className="home-import-control">{importControl}</div></header>
      <section className="home-hero" aria-label="继续阅读">
        <div className="home-hero__copy">
          <div className="home-hero__eyebrow"><span />A PLACE FOR YOUR STORIES</div>
          <HomeQuote api={recordsApi} revision={quoteRevision} onManage={onManageQuotes ?? (() => undefined)} />
          {featured ? <div className="home-hero__continuation">
            <h2 className="continuation-label" aria-label={continuation ? "继续阅读" : "开始阅读"}>{continuation ? "继续上次的旅程" : "从这里开始阅读"}</h2>
            <h2 className="home-hero__book-title">{featured.title}</h2>
            <div className="reading-line">
              <span>{featured.author || "未知作者"}</span>
              <span className="reading-line__meta">
                <span>已读 {Math.round(featured.progress * 100)}%</span>
                {onOpenDetails && (
                  <button className="text-action home-hero__details-link" type="button" onClick={() => onOpenDetails(featured)}>
                    书籍详情
                  </button>
                )}
              </span>
            </div>
            <div className="progress-track"><span style={{ width: `${Math.round(featured.progress * 100)}%` }} /></div>
            <button className="primary-button home-continue" type="button" aria-label={`${continuation ? "继续阅读" : "开始阅读"}《${featured.title}》`} onClick={() => onOpen(featured)}><ButterflyMark />{continuation ? "继续阅读" : "开始阅读"}<ArrowRight size={21} /></button>
          </div> : <div className="home-empty-copy"><h2>把想读的书放在这里</h2><p>从右上角导入 TXT 或 EPUB，开启你的书房。</p></div>}
        </div>
        <div className="home-hero__art" aria-label="书籍展台">
          <div className="hero-orbit hero-orbit--one" /><div className="hero-orbit hero-orbit--two" /><div className="hero-orbit hero-orbit--three" />
          {companion && <div className="hero-cover hero-cover--back"><BookTile book={companion} onOpen={onOpen} coverOnly /></div>}
          {front ? <div className="hero-cover hero-cover--front"><BookTile book={front} onOpen={onOpen} coverOnly /><span className="hero-reading-ribbon">{display.mode === "custom" ? "FAVORITES" : "READING"}</span></div> : <ButterflyMark className="home-empty-butterfly" />}
          <span className="hero-art-star hero-art-star--one">✦</span><span className="hero-art-star hero-art-star--two">✧</span>
          <div className="hero-art-caption">THE NEXT CHAPTER <i /> 未完 · 待续</div>
        </div>
      </section>

      {readingQueue.length > 1 && (
        <div className="home-section home-reading-queue" aria-label="在读队列">
          <div className="home-section__header">
            <h2><span className="section-index">01 · B /</span> 正在阅读</h2>
            <button className="text-action" type="button" onClick={onNavigateToBooks}>
              查看全部<ArrowRight size={16} />
            </button>
          </div>
          <div className="book-grid book-grid--compact">
            {readingQueue.slice(0, 6).map((book) => (
              <BookTile key={book.id} book={book} onOpen={onOpen} onOpenDetails={onOpenDetails} />
            ))}
          </div>
        </div>
      )}

      {recentBooks.length > 0 && (
        <section className="home-section home-recent-section" aria-label="最近加入">
          <div className="home-section__header">
            <h2><span className="section-index">02 /</span> 新入书架</h2>
            <button className="text-action" type="button" onClick={onNavigateToBooks}>
              查看全部<ArrowRight size={16} />
            </button>
          </div>
          <div className="book-grid book-grid--compact">
            {recentBooks.map((book) => (
              <BookTile key={book.id} book={book} onOpen={onOpen} onOpenDetails={onOpenDetails} />
            ))}
          </div>
        </section>
      )}

      {recentCollections.length > 0 && (
        <section className="home-section home-collections" aria-label="我的珍藏">
          <div className="home-section__header">
            <h2>我的珍藏</h2>
            <button className="text-action" type="button" onClick={() => onNavigateToCollections()}>
              查看全部<ArrowRight size={16} />
            </button>
          </div>
          <div className="collection-stack-grid collection-stack-grid--home">
            {recentCollections.map((collection) => (
              <CollectionStack collection={collection} variant="shelf" onSelect={onNavigateToCollections} key={collection.id} />
            ))}
          </div>
        </section>
      )}

      {unorganizedCount > 0 && (
        <section className="home-section home-unorganized" aria-label="等待整理">
          <div>
            <span aria-hidden="true"><FolderSimple size={23} weight="duotone" /></span>
            <div>
              <h2>等待整理</h2>
              <p>{unorganizedCount} 本书还没有加入任何珍藏。</p>
            </div>
          </div>
          <button className="button" type="button" onClick={onNavigateUnorganized}>去整理</button>
        </section>
      )}
    </div>
  );
}
