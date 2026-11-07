import { CrystalCollection } from "./CrystalCollection.js";
import { Books } from "@phosphor-icons/react";
import type { BookSummary, CollectionSummary } from "../../../../shared/contracts.js";
import { GeneratedBookCover } from "./GeneratedBookCover.js";
import { PublicationCoverImage } from "./PublicationCoverImage.js";

function CollectionStackCover({ book, index }: { book: BookSummary; index: number }) {
  return (
    <span
      className="collection-stack__cover"
      data-testid="collection-stack-cover"
      data-stack-index={index}
      aria-hidden="true"
    >
      <GeneratedBookCover book={book} />
      {book.coverUrl && (
        <PublicationCoverImage
          className="collection-stack__image"
          url={book.coverUrl}
          alt=""
          loading="lazy"
        />
      )}
    </span>
  );
}

type Props = {
  collection: CollectionSummary;
  onSelect(id: string): void;
  variant?: "stack" | "shelf" | "crystal";
};

export function CollectionStack({ collection, onSelect, variant = "stack" }: Props) {
  if (variant === "crystal") return <CrystalCollection collection={collection} onSelect={onSelect} />;
  if (variant === "shelf") {
    return (
      <article className="collection-shelf-card" data-collection-stack>
        <button
          className="collection-shelf-card__button"
          type="button"
          aria-label={`打开珍藏《${collection.name}》，共 ${collection.bookCount} 本`}
          onClick={() => onSelect(collection.id)}
        >
          <span className="collection-shelf-card__index" aria-hidden="true">{String(collection.bookCount).padStart(2, "0")}</span>
          <span className="collection-shelf-card__art" aria-hidden="true">
            {collection.previewBooks.length > 0
              ? collection.previewBooks.slice(0, 3).map((book, index) => (
                <span className={`collection-shelf-card__cover collection-shelf-card__cover--${index}`} key={book.id}>
                  <GeneratedBookCover book={book} />
                  {book.coverUrl && <PublicationCoverImage className="collection-stack__image" url={book.coverUrl} alt="" loading="lazy" />}
                </span>
              ))
              : <span className="collection-shelf-card__empty"><Books size={32} weight="duotone" /></span>}
          </span>
          <span className="collection-shelf-card__copy">
            <small>系列珍藏</small>
            <strong>{collection.name}</strong>
            <span>{collection.bookCount} 本书</span>
            <em>打开珍藏 <b aria-hidden="true">↗</b></em>
          </span>
        </button>
      </article>
    );
  }
  return (
    <article className="collection-stack-card" data-collection-stack>
      <button
        className="collection-stack-card__button"
        type="button"
        aria-label={`打开珍藏《${collection.name}》，共 ${collection.bookCount} 本`}
        onClick={() => onSelect(collection.id)}
      >
        <span className="collection-stack">
          {collection.previewBooks.length > 0
            ? collection.previewBooks.slice(0, 3).map((book, index) => (
              <CollectionStackCover book={book} index={index} key={book.id} />
            ))
            : <span className="collection-stack__empty" aria-hidden="true"><Books size={32} weight="duotone" /></span>}
        </span>
        <span className="collection-stack-card__copy">
          <strong>{collection.name}</strong>
          <small>{collection.bookCount} 本</small>
        </span>
      </button>
    </article>
  );
}
