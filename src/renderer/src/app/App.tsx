import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type {
  BookSummary,
  CollectionDetails,
  CollectionSummary,
  FolderCollectionImportProgress,
  FolderCollectionImportResult,
  LibraryImportBatchResult,
  LibraryImportProgress,
  ReaderApi,
  ReaderShortcutProfileV1,
  ReadingAppearance,
  ReadingLocationV1,
} from "../../../shared/contracts.js";
import type { ReadingRecord, ReadingRecordsApi } from "../../../shared/reading-records.js";
import {
  DefaultReaderShortcutProfile,
  DefaultReadingAppearance,
} from "../../../shared/contracts.js";
import { AllBooksView } from "../features/library/AllBooksView.js";
import { BookDetailsDialog } from "../features/library/BookDetailsDialog.js";
import { RemoveBooksDialog } from "../features/library/RemoveBooksDialog.js";
import { CollectionDetailPage } from "../features/library/CollectionDetailPage.js";
import { CollectionsPage } from "../features/library/CollectionsPage.js";
import { FolderImportSummary } from "../features/library/FolderImportSummary.js";
import { FileImportSummary } from "../features/library/FileImportSummary.js";
import { LibraryHome } from "../features/library/LibraryHome.js";
import { UncategorizedPage } from "../features/library/UncategorizedPage.js";
import { ScanPage } from "../features/scan/ScanPage.js";
import { ReaderView } from "../features/reader/ReaderView.js";
import { ReaderPreparingGate } from "../features/reader/ReaderPreparingGate.js";
import { EpubRunnerPrewarm } from "../renditions/EpubRunnerPrewarm.js";
import { ReaderStage } from "../features/reader/ReaderStage.js";
import {
  InitialReaderLifecycleState,
  transitionReader,
} from "../features/reader/reader-lifecycle.js";
import { readerOpenTraces } from "../features/reader/reader-open-trace.js";
import { AppShell, type AppPage } from "../features/shell/AppShell.js";
import { TransitionPresence } from "../features/shell/TransitionPresence.js";
import { describeReaderError, type ReaderNoticeModel } from "../errors/public-error.js";
import { InlineNotice } from "../components/InlineNotice.js";
import { QuoteLibrary } from "../features/quotes/QuoteLibrary.js";

type Props = { api?: ReaderApi };

function LoadingLibrary() {
  return (
    <main className="library-shell" aria-label="正在载入书库">
      <header className="library-header"><div className="skeleton skeleton--brand" /><div className="skeleton skeleton--button" /></header>
      <section className="library-content">
        <div className="skeleton skeleton--heading" />
        <div className="skeleton-grid" aria-hidden="true">
          {[0, 1, 2].map((item) => <div className="skeleton skeleton--book" key={item} />)}
        </div>
      </section>
    </main>
  );
}

export function App({ api = window.readerApi }: Props) {
  const [page, setPage] = useState<AppPage>("home");
  const [lastLibraryPage, setLastLibraryPage] = useState<AppPage>("home");
  const [bookQuery, setBookQuery] = useState("");
  const [collectionQuery, setCollectionQuery] = useState("");
  const [books, setBooks] = useState<BookSummary[]>([]);
  const [collections, setCollections] = useState<CollectionSummary[]>([]);
  const [unorganizedBooks, setUnorganizedBooks] = useState<BookSummary[]>([]);
  const [folderImportProgress, setFolderImportProgress] =
    useState<FolderCollectionImportProgress | null>(null);
  const [folderImportResult, setFolderImportResult] =
    useState<FolderCollectionImportResult | null>(null);
  const [folderImporting, setFolderImporting] = useState(false);
  const [fileImportProgress, setFileImportProgress] = useState<LibraryImportProgress | null>(null);
  const [fileImportResult, setFileImportResult] = useState<LibraryImportBatchResult | null>(null);
  const [fileImporting, setFileImporting] = useState(false);
  const [appearance, setAppearance] = useState<ReadingAppearance>(DefaultReadingAppearance);
  const [shortcuts, setShortcuts] = useState<ReaderShortcutProfileV1>(DefaultReaderShortcutProfile);
  const [readerState, dispatchReader] = useReducer(
    transitionReader,
    InitialReaderLifecycleState,
  );
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<ReaderNoticeModel | null>(null);
  const [selectedCollectionId, setSelectedCollectionId] = useState<string | null>(null);
  const [settingsSubpage, setSettingsSubpage] = useState<"quotes" | "reading" | null>(null);
  const [openingBook, setOpeningBook] = useState<BookSummary | null>(null);
  const [detailsBookId, setDetailsBookId] = useState<string | null>(null);
  const [removingSingleBook, setRemovingSingleBook] = useState<BookSummary | null>(null);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [pendingQuoteLocation, setPendingQuoteLocation] = useState<ReadingLocationV1 | null>(null);
  const [pendingSearchTarget, setPendingSearchTarget] = useState<{ query: string; unitIndex: number } | null>(null);
  const [quoteRevision, setQuoteRevision] = useState(0);
  const recordsApi = (api as ReaderApi & { records?: ReadingRecordsApi }).records;
  const openingAttempt = useRef<{ bookId: string; cancelled: boolean } | null>(null);
  const gridVisibility = useRef(new Map<string, number>());
  const dragDepthRef = useRef(0);
  const detailsBook = useMemo(
    () => books.find((item) => item.id === detailsBookId) ?? null,
    [books, detailsBookId],
  );
  const hydratedCollections = useMemo(() => {
    const currentBooks = new Map(books.map((book) => [book.id, book]));
    return collections.map((collection) => ({
      ...collection,
      previewBooks: collection.previewBooks.map((book) =>
        currentBooks.get(book.id) ?? book),
    }));
  }, [books, collections]);

  useEffect(() => {
    let current = true;
    Promise.all([
      api.library.list(),
      api.collections.list(),
      api.collections.listUnorganized(),
      api.settings.getAppearance(),
      api.settings.getShortcuts(),
    ])
      .then(([
        nextBooks,
        nextCollections,
        nextUnorganizedBooks,
        nextAppearance,
        nextShortcuts,
      ]) => {
        if (!current) return;
        setBooks(nextBooks);
        setCollections(nextCollections);
        setUnorganizedBooks(nextUnorganizedBooks);
        setAppearance(nextAppearance);
        setShortcuts(nextShortcuts);
      })
      .catch((error) => current && setNotice(describeReaderError(error, "library-load")))
      .finally(() => current && setLoading(false));
    return () => {
      current = false;
    };
  }, [api]);

  useEffect(() => api.collections.onFolderImportProgress((value) => {
    setFolderImportProgress(value);
  }), [api]);

  useEffect(() => api.library.onImportProgress(setFileImportProgress), [api]);

  useEffect(() => api.library.onPreparationChanged((event) => {
    const updateMatching = (items: BookSummary[]) => items.map((book) =>
      book.id === event.bookId
        ? {
            ...book,
            preparationStatus: event.state,
            preparationErrorCode: event.errorCode,
          }
        : book);
    setBooks(updateMatching);
    setUnorganizedBooks(updateMatching);
    setOpeningBook((book) => book?.id === event.bookId
      ? {
          ...book,
          preparationStatus: event.state,
          preparationErrorCode: event.errorCode,
        }
      : book);
    if (event.state === "ready") {
      void api.library.list().then((fresh) => {
        const prepared = fresh.find((book) => book.id === event.bookId);
        if (!prepared || prepared.preparationStatus !== "ready") return;
        setBooks((current) => current.map((book) =>
          book.id === event.bookId ? prepared : book));
      }).catch(() => undefined);
    }
  }), [api]);

  useEffect(() => {
    const readerActive = readerState.slot?.phase === "presenting" || readerState.slot?.phase === "active";
    if (readerActive) return;
    function onKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (selectedCollectionId || (page !== "books" && page !== "collections")) {
          setSelectedCollectionId(null);
          setSettingsSubpage(null);
          setPage("books");
        }
        setTimeout(() => {
          document.querySelector<HTMLInputElement>(".command-bar__search-input")?.focus();
        }, 0);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [page, readerState.slot?.phase, selectedCollectionId]);

  async function importFiles(targetCollectionId?: string): Promise<LibraryImportBatchResult> {
    setBusy(true);
    setFileImporting(true);
    setFileImportProgress(null);
    setFileImportResult(null);
    setNotice(null);
    try {
      const result = targetCollectionId
        ? await api.collections.importFiles(targetCollectionId)
        : await api.library.importFiles();
      if (result.status === "completed") {
        setFileImportResult(result);
        await refreshLibraryAndCollections();
      }
      return result;
    } catch (error) {
      setNotice(describeReaderError(error, "import-txt"));
      return { status: "cancelled" };
    } finally {
      setFileImporting(false);
      setFileImportProgress(null);
      setBusy(false);
    }
  }

  async function importDroppedPaths(paths: string[]): Promise<void> {
    if (!paths.length || !api.library.importPaths || busy) return;
    setBusy(true);
    setFileImporting(true);
    setFileImportProgress(null);
    setFileImportResult(null);
    setNotice(null);
    try {
      const result = await api.library.importPaths(paths);
      if (result.status === "completed") {
        setFileImportResult(result);
        if (selectedCollectionId) {
          const importedIds = result.items
            .flatMap((item) => (item.status === "imported" || item.status === "duplicate") ? [item.book.id] : []);
          if (importedIds.length > 0) {
            await api.collections.addBooks(selectedCollectionId, importedIds).catch(() => undefined);
          }
        }
        await refreshLibraryAndCollections();
      }
    } catch (error) {
      setNotice(describeReaderError(error, "import-txt"));
    } finally {
      setFileImporting(false);
      setFileImportProgress(null);
      setBusy(false);
    }
  }

  async function updateBookMetadata(input: {
    bookId: string;
    title: string;
    author: string | null;
  }): Promise<BookSummary | null> {
    if (api.library.updateBook) {
      const updated = await api.library.updateBook(input);
      await refreshLibraryAndCollections();
      return updated;
    }
    let updatedBook: BookSummary | null = null;
    const applyPatch = (book: BookSummary): BookSummary => {
      if (book.id !== input.bookId) return book;
      const next: BookSummary = {
        ...book,
        title: input.title,
        author: input.author,
        updatedAt: new Date().toISOString(),
      };
      updatedBook = next;
      return next;
    };
    setBooks((current) => current.map(applyPatch));
    setUnorganizedBooks((current) => current.map(applyPatch));
    return updatedBook;
  }

  async function setSingleBookReadingState(input: {
    bookId: string;
    state: "unread" | "finished";
  }): Promise<BookSummary | null> {
    if (api.library.setReadingState) {
      const updated = await api.library.setReadingState(input);
      await refreshLibraryAndCollections();
      return updated;
    }
    await setBooksReadingState([input.bookId], input.state);
    return books.find((item) => item.id === input.bookId) ?? null;
  }

  async function setBooksReadingState(
    bookIds: string[],
    state: "unread" | "finished",
  ): Promise<void> {
    if (!bookIds.length) return;
    if (api.library.setReadingState) {
      for (const bookId of bookIds) {
        await api.library.setReadingState({ bookId, state });
      }
      await refreshLibraryAndCollections();
      return;
    }
    const idSet = new Set(bookIds);
    const now = new Date().toISOString();
    const applyState = (book: BookSummary): BookSummary =>
      idSet.has(book.id)
        ? {
            ...book,
            progress: state === "finished" ? 1 : 0,
            lastReadAt: state === "finished" ? now : null,
            updatedAt: now,
          }
        : book;
    setBooks((current) => current.map(applyState));
    setUnorganizedBooks((current) => current.map(applyState));
  }

  async function revealBookInFolder(bookId: string): Promise<boolean> {
    if (!api.library.revealInFolder) return false;
    try {
      return await api.library.revealInFolder(bookId);
    } catch (error) {
      setNotice(describeReaderError(error, "open-book"));
      return false;
    }
  }

  async function relocateBook(bookId: string): Promise<BookSummary | null> {
    if (!api.library.relocate) return null;
    setBusy(true);
    setNotice(null);
    try {
      const relocated = await api.library.relocate(bookId);
      if (relocated) await refreshLibraryAndCollections();
      return relocated;
    } catch (error) {
      setNotice(describeReaderError(error, "open-book"));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function openBook(
    book: BookSummary,
    targetLocation?: ReadingLocationV1 | null,
    searchTarget?: { query: string; unitIndex: number } | null,
  ) {
    if (book.availabilityStatus !== "available") {
      await relocateBook(book.id);
      return;
    }
    if (openingAttempt.current) return;
    if (targetLocation) setPendingQuoteLocation(targetLocation);
    if (searchTarget) setPendingSearchTarget(searchTarget);
    const retained = readerState.slot;
    if (retained?.details.book.id === book.id && retained.phase !== "suspended") return;
    const traceId = readerOpenTraces.start(book.id);
    if (retained?.details.book.id === book.id) {
      const reusable = await api.reader.canResume(
        book.id,
        retained.details.sourceRevision,
      ).catch(() => false);
      if (reusable) {
        dispatchReader({ type: "resume", traceId });
        return;
      }
      dispatchReader({ type: "evict" });
    }
    const attempt = { bookId: book.id, cancelled: false };
    openingAttempt.current = attempt;
    if (
      book.format === "epub"
      && (
        book.preparationStatus === "queued"
        || book.preparationStatus === "preparing"
        || book.preparationStatus === "error"
      )
    ) {
      setOpeningBook(book);
    }
    setLastLibraryPage(page);
    setNotice(null);
    try {
      if (book.preparationStatus === "error") {
        await api.library.retryPreparation(book.id);
      }
      const details = await api.reader.open(book.id);
      if (openingAttempt.current !== attempt || attempt.cancelled) return;
      readerOpenTraces.mark(traceId, "details-ready");
      dispatchReader({ type: "prepare", details, traceId });
    } catch (error) {
      if (openingAttempt.current !== attempt || attempt.cancelled) return;
      if (targetLocation) setPendingQuoteLocation(null);
      if (searchTarget) setPendingSearchTarget(null);
      setNotice(describeReaderError(error, "open-book"));
      void api.library.list().then(setBooks).catch(() => undefined);
    } finally {
      if (openingAttempt.current === attempt) {
        openingAttempt.current = null;
        setOpeningBook(null);
      }
    }
  }

  function dismissOpeningBook() {
    const attempt = openingAttempt.current;
    if (attempt) attempt.cancelled = true;
    openingAttempt.current = null;
    setOpeningBook(null);
  }

  async function removeBooks(bookIds: string[], deleteOriginal = false) {
    setBusy(true);
    setNotice(null);
    try {
      const result = deleteOriginal
        ? await api.library.remove(bookIds, true)
        : await api.library.remove(bookIds);
      await refreshLibraryAndCollections();
      if (result.failedToDelete) {
        setNotice({
          code: "FILE_NOT_READABLE",
          title: "部分原文件未能移入系统回收站",
          detail: `${result.failedToDelete} 本书仍保留在书架。可取消“同时删除原始文件”后只移出书目。`,
        });
        return false;
      }
      return true;
    } catch (error) {
      setNotice(describeReaderError(error, "library-remove"));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function createCollection(name: string): Promise<CollectionDetails> {
    const created = await api.collections.create(name);
    setCollections(await api.collections.list());
    return created;
  }

  async function refreshCollectionsAndUnorganized() {
    const [nextCollections, nextUnorganizedBooks] = await Promise.all([
      api.collections.list(),
      api.collections.listUnorganized(),
    ]);
    setCollections(nextCollections);
    setUnorganizedBooks(nextUnorganizedBooks);
  }

  async function refreshLibraryAndCollections() {
    const [nextBooks, nextCollections, nextUnorganizedBooks] = await Promise.all([
      api.library.list(),
      api.collections.list(),
      api.collections.listUnorganized(),
    ]);
    setBooks(nextBooks);
    setCollections(nextCollections);
    setUnorganizedBooks(nextUnorganizedBooks);
  }

  async function addBooksToCollection(
    collectionId: string,
    bookIds: string[],
  ): Promise<CollectionDetails> {
    const updated = await api.collections.addBooks(collectionId, bookIds);
    await refreshCollectionsAndUnorganized();
    return updated;
  }

  async function removeBooksFromCollection(
    collectionId: string,
    bookIds: string[],
  ): Promise<CollectionDetails> {
    const updated = await api.collections.removeBooks(collectionId, bookIds);
    await refreshCollectionsAndUnorganized();
    return updated;
  }

  async function importCollectionFolder(targetCollectionId?: string): Promise<FolderCollectionImportResult> {
    return runFolderImport(() => api.collections.importFolder(targetCollectionId));
  }

  async function importOrganizedFolder(): Promise<FolderCollectionImportResult> {
    return runFolderImport(() => api.collections.importOrganizedFolder());
  }

  async function runFolderImport(operation: () => Promise<FolderCollectionImportResult>): Promise<FolderCollectionImportResult> {
    setBusy(true);
    setNotice(null);
    setFolderImporting(true);
    setFolderImportProgress(null);
    setFolderImportResult(null);
    try {
      const result = await operation();
      if (result.status === "completed") {
        await refreshLibraryAndCollections();
        setSelectedCollectionId(result.collection.id);
        setPage("collections");
      } else if (result.status === "organized") {
        await refreshLibraryAndCollections();
        setSelectedCollectionId(null);
        setPage("collections");
      }
      if (result.status !== "cancelled") setFolderImportResult(result);
      return result;
    } catch (error) {
      setNotice(describeReaderError(error, "import-folder"));
      throw error;
    } finally {
      setFolderImportProgress(null);
      setFolderImporting(false);
      setBusy(false);
    }
  }

  function suspendReader() {
    if (readerState.slot?.phase !== "active") return;
    dispatchReader({ type: "suspend" });
    setQuoteRevision(value => value + 1);
    setPage(lastLibraryPage);
    void api.library.list()
      .then(setBooks)
      .catch(() => undefined);
  }

  function handleNavigate(next: AppPage) {
    setSelectedCollectionId(null);
    setSettingsSubpage(null);
    setNotice(null);
    setPage(next);
  }

  function openQuoteSource(record: ReadingRecord) {
    const book = books.find((item) => item.id === record.bookId && item.availabilityStatus === "available");
    if (book && record.location) void openBook(book, record.location);
  }

  const regularPageContent = selectedCollectionId ? (
    <CollectionDetailPage
      collectionId={selectedCollectionId}
      libraryBooks={books}
      busy={busy}
      onGet={api.collections.get}
      onRename={api.collections.rename}
      onDelete={api.collections.delete}
      onAddBooks={api.collections.addBooks}
      onRemoveBooks={api.collections.removeBooks}
      onReorder={api.collections.reorder}
      onImportFolder={importCollectionFolder}
      onImportFiles={importFiles}
      onOpen={openBook}
      onOpenDetails={(book) => setDetailsBookId(book.id)}
      onBack={() => setSelectedCollectionId(null)}
      onDeleted={() => setSelectedCollectionId(null)}
      onChanged={refreshCollectionsAndUnorganized}
    />
  ) : page === "home" ? (
    <LibraryHome
      books={books}
      collections={hydratedCollections}
      unorganizedCount={unorganizedBooks.length}
      onOpen={openBook}
      onOpenDetails={(book) => setDetailsBookId(book.id)}
      onNavigateToBooks={() => setPage("books")}
      onNavigateToCollections={(collectionId) => {
        setPage("collections");
        setSelectedCollectionId(collectionId ?? null);
      }}
      onNavigateUnorganized={() => setPage("uncategorized")}
      recordsApi={recordsApi}
      quoteRevision={quoteRevision}
      onManageQuotes={() => {
        setSettingsSubpage("quotes");
        setPage("settings");
      }}
    />
  ) : page === "settings" ? (
    <QuoteLibrary onOpenUrl={api.app.openExternalUrl} api={recordsApi} books={books} onOpenSource={openQuoteSource} onChanged={() => setQuoteRevision((value) => value + 1)} />
  ) : page === "books" ? (
    <AllBooksView
      books={books}
      collections={hydratedCollections}
      query={bookQuery}
      visibilityStore={gridVisibility.current}
      busy={busy}
      notice={notice}
      onImportFiles={importFiles}
      onNavigateUnorganized={() => setPage("uncategorized")}
      onOpen={openBook}
      onOpenDetails={(book) => setDetailsBookId(book.id)}
      onBatchSetReadingState={setBooksReadingState}
      onRemove={removeBooks}
      onGetMemberships={api.collections.getMemberships}
      onCreateCollection={createCollection}
      onAddBooksToCollection={addBooksToCollection}
    />
  ) : page === "collections" ? (
    <CollectionsPage
      collections={hydratedCollections}
      query={collectionQuery}
      busy={busy}
      onCreate={createCollection}
      onImportFolder={importCollectionFolder}
      onSelect={setSelectedCollectionId}
    />
  ) : page === "uncategorized" ? (
    <UncategorizedPage
      books={unorganizedBooks}
      libraryBooks={books}
      collections={hydratedCollections}
      busy={busy}
      onOpen={openBook}
      onOpenDetails={(book) => setDetailsBookId(book.id)}
      onGetMemberships={api.collections.getMemberships}
      onGetCollection={api.collections.get}
      onCreateCollection={createCollection}
      onAddBooksToCollection={addBooksToCollection}
    />
  ) : page === "scan" ? (
    <ScanPage
      api={api.scan}
      onNavigateUnorganized={() => setPage("uncategorized")}
      onImportFolder={() => void importCollectionFolder().catch(() => undefined)}
      onImportOrganizedFolder={() => void importOrganizedFolder().catch(() => undefined)}
      collections={hydratedCollections.map((collection) => ({
        id: collection.id,
        name: collection.name,
      }))}
      onCreateCollection={async (name) => {
        const created = await createCollection(name);
        return { id: created.id, name: created.name };
      }}
      onLibraryChanged={() => void refreshLibraryAndCollections().catch(() => undefined)}
    />
  ) : null;

  const pageContent = openingBook ? (
    <ReaderPreparingGate book={openingBook} onBack={dismissOpeningBook} />
  ) : regularPageContent;

  const libraryContent = (
    <>
      {notice && page !== "books" && <InlineNotice notice={notice} />}
      <FolderImportSummary
        active={folderImporting}
        progress={folderImportProgress}
        result={folderImportResult}
        onDismiss={() => setFolderImportResult(null)}
      />
      <FileImportSummary
        active={fileImporting}
        progress={fileImportProgress}
        result={fileImportResult}
        onDismiss={() => setFileImportResult(null)}
      />
      {pageContent}
      <TransitionPresence>{detailsBook && (
        <BookDetailsDialog
          book={detailsBook}
          collections={hydratedCollections}
          recordsApi={recordsApi}
          busy={busy}
          onClose={() => setDetailsBookId(null)}
          onOpen={(book, location) => {
            setDetailsBookId(null);
            void openBook(book, location);
          }}
          onUpdateMetadata={updateBookMetadata}
          onSetReadingState={setSingleBookReadingState}
          onRevealInFolder={api.library.revealInFolder ? revealBookInFolder : undefined}
          onRelocate={api.library.relocate ? relocateBook : undefined}
          onRequestRemove={(book) => {
            setDetailsBookId(null);
            setRemovingSingleBook(book);
          }}
          onGetMemberships={api.collections.getMemberships}
          onCreateCollection={createCollection}
          onAddBooksToCollection={addBooksToCollection}
          onRemoveBooksFromCollection={removeBooksFromCollection}
        />
      )}</TransitionPresence>
      <TransitionPresence>{removingSingleBook && (
        <RemoveBooksDialog
          count={1}
          busy={busy}
          onCancel={() => setRemovingSingleBook(null)}
          onConfirm={async (deleteOriginal) => {
            const target = removingSingleBook;
            const removed = await removeBooks([target.id], deleteOriginal);
            if (removed) setRemovingSingleBook(null);
          }}
        />
      )}</TransitionPresence>
    </>
  );

  const libraryView = (
    <AppShell
      page={selectedCollectionId ? "collections" : page}
      viewKey={selectedCollectionId ? `collection:${selectedCollectionId}` : page === "books" ? `books:${bookQuery}` : page === "collections" ? `collections:${collectionQuery}` : page}
      scrollFrozen={Boolean(openingBook) || readerState.slot?.phase === "presenting" || readerState.slot?.phase === "active"}
      books={books}
      settingsSubpage={settingsSubpage}
      onSettingsSubpageChange={setSettingsSubpage}
      appearance={appearance}
      onAppearanceChange={(next) => {
        setAppearance(next);
        void api.settings.updateAppearance(next).catch(() => undefined);
      }}
      shortcuts={shortcuts}
      onShortcutsChange={(next) => {
        setShortcuts(next);
        void api.settings.updateShortcuts(next).catch(() => undefined);
      }}
      search={selectedCollectionId ? undefined : page === "books" ? {
        query: bookQuery,
        placeholder: "搜索书名或作者… (Ctrl+K)",
        label: "搜索全部书籍",
        onChange: setBookQuery,
      } : page === "collections" ? {
        query: collectionQuery,
        placeholder: "搜索珍藏名称… (Ctrl+K)",
        label: "搜索珍藏",
        onChange: setCollectionQuery,
      } : undefined}
      busy={busy}
      onNavigate={handleNavigate}
      onImportFiles={importFiles}
      onImportFolder={() => void importCollectionFolder().catch(() => undefined)}
      onImportOrganizedFolder={() => void importOrganizedFolder().catch(() => undefined)}
    >
      {libraryContent}
    </AppShell>
  );

  return (
    <div
      className="app"
      data-theme={appearance.theme}
      onDragEnter={(event) => {
        if (!event.dataTransfer?.types?.includes("Files")) return;
        event.preventDefault();
        dragDepthRef.current += 1;
        setDraggingFiles(true);
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer?.types?.includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(event) => {
        if (!event.dataTransfer?.types?.includes("Files")) return;
        event.preventDefault();
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) setDraggingFiles(false);
      }}
      onDrop={(event) => {
        if (!event.dataTransfer?.files?.length) return;
        event.preventDefault();
        dragDepthRef.current = 0;
        setDraggingFiles(false);
        const files = Array.from(event.dataTransfer.files);
        const paths = files
          .map((file) => api.library.getFilePath?.(file) || (file as File & { path?: string }).path || "")
          .filter((item) => /\.(txt|epub)$/i.test(item));
        if (paths.length > 0) {
          void importDroppedPaths(paths);
        }
      }}
    >
      <EpubRunnerPrewarm />
      {draggingFiles && (
        <div className="drop-import-overlay" role="status" aria-label="拖拽导入提示">
          <div className="drop-import-overlay__card">
            <strong>释放以导入书籍</strong>
            <span>支持拖入 .epub 与 .txt 文件{selectedCollectionId ? "（将自动加入当前珍藏）" : ""}</span>
          </div>
        </div>
      )}
      {loading ? <LoadingLibrary /> : (
        <ReaderStage
          phase={readerState.slot?.phase ?? "library"}
          library={libraryView}
          reader={readerState.slot ? (
            <ReaderView
              key={`${readerState.slot.details.book.id}:${readerState.slot.details.sessionId}`}
              api={api}
              details={readerState.slot.details}
              appearance={appearance}
              shortcuts={shortcuts}
              active={readerState.slot.phase === "active"}
              initialLocation={pendingQuoteLocation}
              onLocationConsumed={() => setPendingQuoteLocation(null)}
              initialSearchTarget={pendingSearchTarget}
              onSearchTargetConsumed={() => setPendingSearchTarget(null)}
              onAppearanceChange={setAppearance}
              onShortcutsChange={setShortcuts}
              onReady={() => {
                if (readerState.slot?.phase !== "preparing") return;
                readerOpenTraces.mark(readerState.slot.traceId, "stable-paint");
                dispatchReader({ type: "ready" });
                dispatchReader({ type: "present" });
              }}
              onOpenPhase={(phase) => {
                if (!readerState.slot) return;
                readerOpenTraces.mark(readerState.slot.traceId, phase);
              }}
              onSuspend={suspendReader}
              onBack={suspendReader}
            />
          ) : null}
          onPresented={() => {
            if (readerState.slot?.phase !== "presenting") return;
            readerOpenTraces.mark(readerState.slot.traceId, "interactive");
            dispatchReader({ type: "presented" });
          }}
        />
      )}
    </div>
  );
}
