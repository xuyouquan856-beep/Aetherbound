import { useState } from "react";
import type {
  BookSummary,
  CollectionDetails,
  CollectionMembership,
  CollectionSummary,
} from "../../../../shared/contracts.js";
import type { ReaderNoticeModel } from "../../errors/public-error.js";
import { AppShell, type AppPage } from "../shell/AppShell.js";
import { AllBooksView } from "./AllBooksView.js";
import { LibraryHome } from "./LibraryHome.js";

type Props = {
  books: BookSummary[];
  collections: CollectionSummary[];
  busy: boolean;
  notice: ReaderNoticeModel | null;
  onImportFiles(): void;
  onImportFolder(): void;
  onImportOrganizedFolder(): void;
  onOpen(book: BookSummary): void;
  onRemove(bookIds: string[], deleteOriginal?: boolean): Promise<boolean>;
  onGetMemberships(bookIds: string[]): Promise<CollectionMembership[]>;
  onCreateCollection(name: string): Promise<CollectionDetails>;
  onAddBooksToCollection(collectionId: string, bookIds: string[]): Promise<CollectionDetails>;
  onNavigateFulltext(): void;
};

export function LibraryView({
  books,
  collections,
  busy,
  notice,
  onImportFiles,
  onImportFolder,
  onImportOrganizedFolder,
  onOpen,
  onRemove,
  onGetMemberships,
  onCreateCollection,
  onAddBooksToCollection,
  onNavigateFulltext,
}: Props) {
  const [page, setPage] = useState<AppPage>("home");
  const [query, setQuery] = useState("");

  return (
    <AppShell
      page={page}
      books={books}
      search={page === "books" ? {
        query,
        placeholder: "搜索书名或作者…",
        label: "搜索全部书籍",
        onChange: setQuery,
      } : undefined}
      busy={busy}
      onNavigate={setPage}
      onImportFiles={onImportFiles}
      onImportFolder={onImportFolder}
      onImportOrganizedFolder={onImportOrganizedFolder}
    >
      {page === "home" ? (
        <LibraryHome
          books={books}
          collections={collections}
          unorganizedCount={0}
          onOpen={onOpen}
          onNavigateToBooks={() => setPage("books")}
          onNavigateToCollections={() => setPage("collections")}
          onNavigateUnorganized={() => setPage("uncategorized")}
        />
      ) : (
        <AllBooksView
          books={books}
          collections={collections}
          query={query}
          busy={busy}
          notice={notice}
          onImportFiles={onImportFiles}
          onOpen={onOpen}
          onRemove={onRemove}
          onGetMemberships={onGetMemberships}
          onCreateCollection={onCreateCollection}
          onAddBooksToCollection={onAddBooksToCollection}
        />
      )}
    </AppShell>
  );
}
