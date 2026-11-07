import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import {
  AppInfoSchema, BookDetailsSchema, BookSummarySchema, ChapterContentSchema,
  CollectionBookIdsRequestSchema, CollectionCreateRequestSchema,
  CollectionDetailsSchema, CollectionIdRequestSchema, CollectionMembershipSchema,
  CollectionMembershipsRequestSchema, CollectionRenameRequestSchema,
  CollectionSummarySchema, FolderCollectionImportProgressSchema,
  FolderCollectionImportResultSchema,
  EpubBinaryRequestSchema, EpubBinaryResponseSchema,
  FulltextSearchRequestSchema, FulltextSearchResponseSchema,
  LibraryImportBatchResultSchema,
  LibraryImportPathsRequestSchema,
  LibraryImportProgressSchema,
  LibraryRemoveRequestSchema, LibraryRemoveResultSchema,
  LibrarySetReadingStateRequestSchema,
  LibraryUpdateBookRequestSchema,
  PublicPreparationEventSchema,
  ReaderShortcutProfileSchema, ReadingAppearanceSchema, ReadingLocationSchema,
  RetainedReaderRequestSchema,
  LibraryScanJobRequestSchema,
  LibraryScanSnapshotSchema,
  ScanFolderSelectionSchema,
  ScanOverviewSchema,
  ScanFindingListRequestSchema,
  ScanFindingListSchema,
  ScanDecisionRequestSchema,
  ScanDecisionResultSchema,
  ScanBatchDecisionRequestSchema,
  ScanBatchDecisionResultSchema,
  ScanFileListRequestSchema,
  ScanFileListSchema,
  ScanImportRequestSchema,
  ScanOrganizeRequestSchema,
  ScanImportProgressSchema,
} from "../../shared/contracts.js";
import { channels } from "../../shared/ipc.js";
import { ListReadingRecordsSchema, ReadingRecordSchema, RemoveReadingRecordSchema, SaveReadingRecordSchema } from "../../shared/reading-records.js";
import { publicError, ReaderError } from "../../shared/errors.js";
import { reanchorTxtLocation } from "../../formats/txt/locator.js";
import { basename, extname } from "node:path";
import { realpath, stat } from "node:fs/promises";
import type { Services } from "../bootstrap/services.js";
import { moveFileToRecycleBin } from "../trash/recycle-bin.js";
import { validatedHandler } from "./validated-handler.js";

const bookIdSchema = z.string().min(1).max(128).regex(/^[^\\/:]+$/);
const bookRequest = z.object({ bookId: bookIdSchema }).strict();
const chapterRequest = z.object({ bookId: z.string().min(1), chapterId: z.string().min(1) }).strict();
const saveRequest = z.object({ bookId: z.string().min(1), sessionId: z.string().min(1), location: ReadingLocationSchema }).strict();
const closeRequest = z.object({ bookId: z.string().min(1), sessionId: z.string().min(1), location: ReadingLocationSchema.nullable() }).strict();

function register(
  channel: string,
  handler: (payload: unknown, event: IpcMainInvokeEvent) => Promise<unknown>,
) {
  ipcMain.handle(channel, async (event, payload) => {
    try {
      assertTrustedSender(event);
      return await handler(payload, event);
    }
    catch (error) {
      // The renderer only ever receives a stable public code, so without this the
      // real cause of an IPC failure is unrecoverable from a user report.
      logIpcFailure(channel, error);
      throw new Error(JSON.stringify(publicError(error)));
    }
  });
}

const MAX_LOGGED_STACK_LENGTH = 4000;

function logIpcFailure(channel: string, error: unknown) {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`[ipc] ${channel} failed: ${detail.slice(0, MAX_LOGGED_STACK_LENGTH)}`);
}

export function isTrustedRendererUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr);
    const isBundledRenderer = url.protocol === "reader-app:" && url.hostname === "bundle" && url.pathname === "/index.html";
    if (app.isPackaged) return isBundledRenderer;
    if (process.env.ELECTRON_RENDERER_URL) {
      const expected = new URL(process.env.ELECTRON_RENDERER_URL);
      return url.origin === expected.origin;
    }
    return isBundledRenderer;
  } catch {
    return false;
  }
}

function assertTrustedSender(event: IpcMainInvokeEvent) {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame) throw new ReaderError("INVALID_REQUEST", "Untrusted IPC frame.");
  if (!isTrustedRendererUrl(frame.url)) {
    throw new ReaderError("INVALID_REQUEST", "Untrusted IPC origin.");
  }
}

export function registerIpc(services: Services) {
  services.preparations.subscribe((value) => {
    const event = PublicPreparationEventSchema.parse(value);
    for (const window of BrowserWindow.getAllWindows()) {
      if (!isTrustedRendererUrl(window.webContents.getURL())) continue;
      window.webContents.send(channels.libraryPreparationChanged, event);
    }
  });
  services.scan.jobs.subscribe((value) => {
    // Re-validated on the way out as well as in the preload: a scan snapshot is built
    // from database rows and counters, and this is the boundary it crosses.
    const parsed = LibraryScanSnapshotSchema.safeParse(value);
    if (!parsed.success) return;
    for (const window of BrowserWindow.getAllWindows()) {
      if (!isTrustedRendererUrl(window.webContents.getURL())) continue;
      window.webContents.send(channels.scanProgress, parsed.data);
    }
  });
  services.scan.imports.subscribe((value) => {
    const parsed = ScanImportProgressSchema.safeParse(value);
    if (!parsed.success) return;
    for (const window of BrowserWindow.getAllWindows()) {
      if (!isTrustedRendererUrl(window.webContents.getURL())) continue;
      window.webContents.send(channels.scanImportProgress, parsed.data);
    }
  });
  async function chooseAndImportMixed(event: IpcMainInvokeEvent) {
    const selection = await dialog.showOpenDialog({
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "书籍文件", extensions: ["txt", "epub"] }],
    });
    if (selection.canceled || selection.filePaths.length === 0) {
      return { status: "cancelled" as const };
    }
    const files = selection.filePaths.map((path) => ({
      path,
      format: extname(path).toLowerCase() === ".epub" ? "epub" as const : "txt" as const,
    }));
    const items = await services.importer.importMixedFiles(files, (progress) => {
      event.sender.send(channels.libraryImportProgress, LibraryImportProgressSchema.parse(progress));
    });
    return { status: "completed" as const, items };
  }
  register(channels.appOpenExternalUrl, validatedHandler(
    z.string().max(2048).url().refine(value => ["http:", "https:"].includes(new URL(value).protocol)),
    z.void(), async url => { await shell.openExternal(url); },
  ));
  register(channels.appInfo, validatedHandler(z.void(), AppInfoSchema, () => ({ name: "Aetherbound", version: app.getVersion(), platform: process.platform })));
  register(channels.libraryList, validatedHandler(z.void(), z.array(BookSummarySchema), () => services.library.listBooks()));
  register(channels.libraryImportTxt, validatedHandler(z.void(), LibraryImportBatchResultSchema, async () => {
    const selection = await dialog.showOpenDialog({
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "TXT 小说", extensions: ["txt"] }],
    });
    if (selection.canceled || selection.filePaths.length === 0) {
      return { status: "cancelled" as const };
    }
    return services.importer.importFiles(selection.filePaths, "txt");
  }));
  register(channels.libraryImportEpub, validatedHandler(z.void(), LibraryImportBatchResultSchema, async () => {
    const selection = await dialog.showOpenDialog({
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "EPUB 电子书", extensions: ["epub"] }],
    });
    if (selection.canceled || selection.filePaths.length === 0) {
      return { status: "cancelled" as const };
    }
    return services.importer.importFiles(selection.filePaths, "epub");
  }));
  register(channels.libraryImportMixed, async (payload, event) =>
    validatedHandler(z.void(), LibraryImportBatchResultSchema, () => chooseAndImportMixed(event))(payload),
  );
  register(channels.libraryRemove, validatedHandler(
    LibraryRemoveRequestSchema,
    LibraryRemoveResultSchema,
    ({ bookIds, deleteOriginal }) => services.library.removeBooks(bookIds, {
      deleteOriginal,
      moveToTrash: moveFileToRecycleBin,
    }),
  ));
  register(channels.libraryPreparationRetry, validatedHandler(
    bookRequest,
    z.void(),
    ({ bookId }) => services.preparations.retry(bookId),
  ));
  register(channels.libraryRelocate, validatedHandler(
    bookRequest,
    BookSummarySchema.nullable(),
    async ({ bookId }) => {
      const book = services.library.getBook(bookId);
      const selection = await dialog.showOpenDialog({
        properties: ["openFile"],
        filters: book.format === "epub"
          ? [{ name: "EPUB 电子书", extensions: ["epub"] }]
          : [{ name: "TXT 小说", extensions: ["txt"] }],
      });
      if (selection.canceled || selection.filePaths.length === 0) {
        return null;
      }
      const updated = await services.library.replaceSource(bookId, selection.filePaths[0]);
      services.textIndexer.enqueue(updated.id);
      return updated;
    },
  ));
  register(channels.libraryUpdateBook, validatedHandler(
    LibraryUpdateBookRequestSchema,
    BookSummarySchema,
    ({ bookId, title, author }) => services.library.updateBookMetadata(bookId, { title, author }),
  ));
  register(channels.librarySetReadingState, validatedHandler(
    LibrarySetReadingStateRequestSchema,
    BookSummarySchema,
    ({ bookId, state }) => services.library.setReadingState(bookId, state),
  ));
  register(channels.libraryRevealInFolder, validatedHandler(
    bookRequest,
    z.boolean(),
    async ({ bookId }) => {
      const source = services.library.getSourceForBook(bookId);
      const present = await stat(source.sourcePath).then((s) => s.isFile()).catch(() => false);
      if (!present) return false;
      shell.showItemInFolder(source.sourcePath);
      return true;
    },
  ));
  register(channels.libraryImportPaths, async (payload, event) =>
    validatedHandler(
      LibraryImportPathsRequestSchema,
      LibraryImportBatchResultSchema,
      async ({ paths }) => {
        const validFiles: Array<{ path: string; format: "txt" | "epub" }> = [];
        for (const rawPath of paths) {
          const ext = extname(rawPath).toLowerCase();
          if (ext !== ".txt" && ext !== ".epub") continue;
          validFiles.push({
            path: rawPath,
            format: ext === ".epub" ? "epub" : "txt",
          });
        }
        if (validFiles.length === 0) {
          return { status: "cancelled" as const };
        }
        const items = await services.importer.importMixedFiles(validFiles, (progress) => {
          event.sender.send(channels.libraryImportProgress, LibraryImportProgressSchema.parse(progress));
        });
        return { status: "completed" as const, items };
      },
    )(payload),
  );
  register(channels.collectionsList, validatedHandler(
    z.void(),
    z.array(CollectionSummarySchema),
    () => services.collections.list(),
  ));
  register(channels.collectionsGet, validatedHandler(
    CollectionIdRequestSchema,
    CollectionDetailsSchema,
    ({ id }) => services.collections.get(id),
  ));
  register(channels.collectionsCreate, validatedHandler(
    CollectionCreateRequestSchema,
    CollectionDetailsSchema,
    ({ name }) => services.collections.create(name),
  ));
  register(channels.collectionsRename, validatedHandler(
    CollectionRenameRequestSchema,
    CollectionDetailsSchema,
    ({ id, name }) => services.collections.rename(id, name),
  ));
  register(channels.collectionsDelete, validatedHandler(
    CollectionIdRequestSchema,
    z.void(),
    ({ id }) => services.collections.delete(id),
  ));
  register(channels.collectionsAddBooks, validatedHandler(
    CollectionBookIdsRequestSchema,
    CollectionDetailsSchema,
    ({ id, bookIds }) => services.collections.addBooks(id, bookIds),
  ));
  register(channels.collectionsRemoveBooks, validatedHandler(
    CollectionBookIdsRequestSchema,
    CollectionDetailsSchema,
    ({ id, bookIds }) => services.collections.removeBooks(id, bookIds),
  ));
  register(channels.collectionsReorder, validatedHandler(
    CollectionBookIdsRequestSchema,
    CollectionDetailsSchema,
    ({ id, bookIds }) => services.collections.reorder(id, bookIds),
  ));
  register(channels.collectionsGetMemberships, validatedHandler(
    CollectionMembershipsRequestSchema,
    z.array(CollectionMembershipSchema),
    ({ bookIds }) => services.collections.getMemberships(bookIds),
  ));
  register(channels.collectionsListUnorganized, validatedHandler(
    z.void(),
    z.array(BookSummarySchema),
    () => services.collections.listUnorganized(),
  ));
  register(channels.collectionsImportFolder, async (payload, event) =>
    validatedHandler(
      z.union([z.void(), CollectionIdRequestSchema]),
      FolderCollectionImportResultSchema,
      async (request) => {
        const selection = await dialog.showOpenDialog({ properties: ["openDirectory"] });
        if (selection.canceled || selection.filePaths.length === 0) {
          return { status: "cancelled" as const };
        }
        return services.folderCollectionImporter.import(selection.filePaths[0], (progress) => {
          const safe = FolderCollectionImportProgressSchema.parse(progress);
          event.sender.send(channels.collectionsImportFolderProgress, safe);
        }, request?.id);
      },
    )(payload),
  );
  register(channels.collectionsImportOrganizedFolder, async (payload, event) =>
    validatedHandler(z.void(), FolderCollectionImportResultSchema, async () => {
      const selection = await dialog.showOpenDialog({ properties: ["openDirectory"] });
      if (selection.canceled || selection.filePaths.length === 0) {
        return { status: "cancelled" as const };
      }
      return services.folderCollectionImporter.importOrganized(selection.filePaths[0], (progress) => {
        event.sender.send(channels.collectionsImportFolderProgress, FolderCollectionImportProgressSchema.parse(progress));
      });
    })(payload),
  );
  register(channels.collectionsImportFiles, async (payload, event) =>
    validatedHandler(CollectionIdRequestSchema, LibraryImportBatchResultSchema, async ({ id }) => {
      await services.collections.get(id);
      const result = await chooseAndImportMixed(event);
      if (result.status === "completed") {
        const ids = [...new Set(result.items.flatMap((item) =>
          item.status === "imported" || item.status === "duplicate" ? [item.book.id] : []))];
        for (let index = 0; index < ids.length; index += 1000) {
          await services.collections.addBooks(id, ids.slice(index, index + 1000));
        }
      }
      return result;
    })(payload),
  );

  register(channels.readerOpen, validatedHandler(bookRequest, BookDetailsSchema, async ({ bookId }) => {
    const book = services.library.getBook(bookId);
    if (book.format === "epub") {
      await services.preparations.ensureReady(bookId);
      const publication = await services.library.readPublication(bookId);
      const source = services.library.getSourceForBook(bookId);
      const persisted = services.progress.get(bookId);
      const savedLocation = persisted?.format === "epub" ? persisted : null;
      const sessionId = services.sessions.openSession(bookId, source.sourceRevision, savedLocation);
      return { book, sourceRevision: source.sourceRevision, publication, savedLocation, sessionId };
    }
    const document = await services.library.readDocument(bookId);
    const source = services.library.getSourceForBook(bookId);
    const persistedLocation = services.progress.get(bookId);
    let savedLocation = persistedLocation?.format === "txt" ? persistedLocation : null;
    if (savedLocation && (savedLocation.sourceRevision !== source.sourceRevision || !document.chapters.some((chapter) => chapter.id === savedLocation?.primary.chapterId))) {
      savedLocation = reanchorTxtLocation(document.chapters.map((chapter) => ({
        chapter,
        text: document.text.slice(chapter.startOffset, chapter.endOffset),
      })), savedLocation, source.sourceRevision);
      services.progress.save(bookId, savedLocation, new Date().toISOString());
    }
    const sessionId = services.sessions.openSession(bookId, source.sourceRevision, savedLocation);
    return { book, sourceRevision: source.sourceRevision, chapters: document.chapters, savedLocation, sessionId };
  }));
  register(channels.readerEpubBinary, validatedHandler(
    EpubBinaryRequestSchema,
    EpubBinaryResponseSchema,
    (request) => services.epubBinary.read(request),
  ));
  register(channels.readerCanResume, validatedHandler(
    RetainedReaderRequestSchema,
    z.boolean(),
    ({ bookId, sourceRevision }) => services.library.isSourceCurrent(bookId, sourceRevision),
  ));
  register(channels.readerChapter, validatedHandler(chapterRequest, ChapterContentSchema, ({ bookId, chapterId }) => services.library.getChapter(bookId, chapterId)));
  register(channels.readerSaveProgress, validatedHandler(saveRequest, z.void(), ({ bookId, sessionId, location }) => services.sessions.heartbeat(sessionId, bookId, location)));
  register(channels.readerCloseSession, validatedHandler(closeRequest, z.void(), ({ bookId, sessionId, location }) => services.sessions.closeSession(sessionId, bookId, location)));
  register(channels.readerRecordsList, validatedHandler(
    ListReadingRecordsSchema, z.array(ReadingRecordSchema),
    (filter) => services.records.list(filter),
  ));
  register(channels.readerRecordsSave, validatedHandler(
    SaveReadingRecordSchema, ReadingRecordSchema,
    (input) => services.records.save(input),
  ));
  register(channels.readerRecordsRemove, validatedHandler(
    RemoveReadingRecordSchema, z.void(),
    (request) => services.records.remove(request),
  ));
  register(channels.settingsGet, validatedHandler(z.void(), ReadingAppearanceSchema, () => services.settings.getAppearance()));
  register(channels.settingsUpdate, validatedHandler(ReadingAppearanceSchema, ReadingAppearanceSchema, (value) => services.settings.saveAppearance(value)));
  register(channels.settingsShortcutsGet, validatedHandler(
    z.void(),
    ReaderShortcutProfileSchema,
    () => services.settings.getShortcuts(),
  ));
  register(channels.settingsShortcutsUpdate, validatedHandler(
    ReaderShortcutProfileSchema,
    ReaderShortcutProfileSchema,
    (value) => services.settings.saveShortcuts(value),
  ));
  register(channels.searchFulltext, validatedHandler(
    FulltextSearchRequestSchema, FulltextSearchResponseSchema,
    async ({ query, limit, offset }) => {
      const results = services.textIndexer.search(query, limit, offset);
      return results.map(r => ({
        bookId: r.bookId,
        title: r.title,
        matchSnippet: r.matchSnippet,
        unitIndex: r.unitIndex,
      }));
    }
  ));
  registerScan(services);
}

/**
 * The folder-scan surface.
 *
 * Two rules hold across all of it. First, every handler goes through the same
 * `register` wrapper as everything else, so `assertTrustedSender` runs and a caller
 * from a non-main frame or an untrusted origin is rejected before the filesystem is
 * touched. Second, no handler accepts or returns a filesystem path: the folder is
 * chosen through a main-process dialog, and the renderer afterwards refers to it only
 * by the opaque root the main process remembers. A compromised renderer therefore
 * cannot point the scanner at an arbitrary directory, because it has no way to name
 * one.
 */
function registerScan(services: Services) {
  const { scan } = services;

  register(channels.scanChooseFolder, validatedHandler(
    z.void(),
    ScanFolderSelectionSchema,
    async () => {
      const selection = await dialog.showOpenDialog({
        title: "选择要扫描的书籍文件夹",
        properties: ["openDirectory"],
      });
      if (selection.canceled || selection.filePaths.length === 0) {
        return { status: "cancelled" as const };
      }

      const chosen = selection.filePaths[0];
      let canonical: string;
      try {
        canonical = await realpath(chosen);
      } catch {
        throw new ReaderError("FILE_NOT_READABLE", "无法读取所选文件夹。");
      }
      const facts = await stat(canonical).catch(() => null);
      if (!facts?.isDirectory()) {
        throw new ReaderError("INVALID_REQUEST", "所选项目不是文件夹。");
      }

      const now = new Date().toISOString();
      const displayName = basename(canonical) || canonical;
      // `countForPath` has to run before `ensureRoot`, which would otherwise create
      // the row and make every folder look like one we have seen before.
      const alreadyAuthorized = scan.roots.countForPath(canonical) > 0;
      scan.roots.ensureRoot(canonical, displayName, now);
      return { status: "selected" as const, displayName, alreadyAuthorized };
    },
  ));

  register(channels.scanStart, validatedHandler(
    z.void(),
    LibraryScanSnapshotSchema,
    () => scan.jobs.start(),
  ));

  register(channels.scanActive, validatedHandler(
    z.void(),
    LibraryScanSnapshotSchema.nullable(),
    () => scan.jobs.getActive(),
  ));

  register(channels.scanPause, validatedHandler(
    LibraryScanJobRequestSchema,
    LibraryScanSnapshotSchema,
    ({ jobId }) => scan.jobs.pause(jobId),
  ));

  register(channels.scanResume, validatedHandler(
    LibraryScanJobRequestSchema,
    LibraryScanSnapshotSchema,
    ({ jobId }) => scan.jobs.resume(jobId),
  ));

  register(channels.scanCancel, validatedHandler(
    LibraryScanJobRequestSchema,
    LibraryScanSnapshotSchema,
    ({ jobId }) => scan.jobs.cancel(jobId),
  ));

  register(channels.scanFindings, validatedHandler(
    ScanFindingListRequestSchema,
    ScanFindingListSchema,
    (request) => {
      const root = scan.review.requireActiveRoot();
      return scan.review.listFindings(root.id, request);
    },
  ));

  register(channels.scanOverview, validatedHandler(
    z.void(),
    ScanOverviewSchema,
    () => {
      const root = scan.review.requireActiveRoot();
      return scan.review.overview(root.id, root.rootPath);
    },
  ));

  register(channels.scanDecide, validatedHandler(
    ScanDecisionRequestSchema,
    ScanDecisionResultSchema,
    ({ findingId, decision }) => {
      const root = scan.review.requireActiveRoot();
      return scan.review.decide(root.id, root.rootPath, findingId, decision);
    },
  ));

  register(channels.scanDecideBatch, validatedHandler(
    ScanBatchDecisionRequestSchema,
    ScanBatchDecisionResultSchema,
    ({ kind, decision }) => {
      const root = scan.review.requireActiveRoot();
      return scan.review.decideBatch(root.id, root.rootPath, kind, decision);
    },
  ));

  register(channels.scanFiles, validatedHandler(
    ScanFileListRequestSchema,
    ScanFileListSchema,
    (request) => {
      const root = scan.review.requireActiveRoot();
      return scan.review.listFiles(root.id, root.rootPath, request);
    },
  ));

  register(channels.scanImport, validatedHandler(
    ScanImportRequestSchema,
    ScanImportProgressSchema,
    (request) => scan.imports.start({
      inventoryIds: request.scope === "all-unimported" ? null : request.inventoryIds,
    }),
  ));

  register(channels.scanOrganize, validatedHandler(
    ScanOrganizeRequestSchema,
    ScanImportProgressSchema,
    async ({ inventoryIds, collectionId, newCollectionName }) => {
      const collection = await scan.review.prepareCollection(newCollectionName, collectionId);
      return scan.imports.start({ inventoryIds, collection });
    },
  ));

  register(channels.scanImportCancel, validatedHandler(
    z.void(),
    ScanImportProgressSchema.nullable(),
    () => scan.imports.cancel(),
  ));

  register(channels.scanImportActive, validatedHandler(
    z.void(),
    ScanImportProgressSchema.nullable(),
    () => scan.imports.active(),
  ));
}
