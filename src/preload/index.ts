import { contextBridge, ipcRenderer as electronIpc, webUtils } from "electron";
import type { IpcRenderer } from "electron";
import type {
  FolderCollectionImportProgress,
  LibraryImportProgress,
  LibraryScanSnapshot,
  PublicPreparationEvent,
  ReaderApi,
  ReaderShortcutProfileV1,
  ReadingAppearance,
  ReadingLocationV1,
  ScanImportProgress,
} from "../shared/contracts.js";
import {
  FolderCollectionImportProgressSchema,
  LibraryImportProgressSchema,
  LibraryScanSnapshotSchema,
  PublicPreparationEventSchema,
  ScanImportProgressSchema,
} from "../shared/contracts.js";
import { channels } from "../shared/ipc.js";

export function createReaderApi(ipc: Pick<IpcRenderer, "invoke" | "on" | "removeListener">): ReaderApi {
  return {
    app: { getInfo: () => ipc.invoke(channels.appInfo), openExternalUrl: url => ipc.invoke(channels.appOpenExternalUrl, url) },
    records: {
      list: (filter = {}) => ipc.invoke(channels.readerRecordsList, filter),
      save: (input) => ipc.invoke(channels.readerRecordsSave, input),
      remove: (request) => ipc.invoke(channels.readerRecordsRemove, request),
    },
    library: {
      list: () => ipc.invoke(channels.libraryList),
      importTxt: () => ipc.invoke(channels.libraryImportTxt),
      importEpub: () => ipc.invoke(channels.libraryImportEpub),
      importFiles: () => ipc.invoke(channels.libraryImportMixed),
      onImportProgress: (listener) => {
        const handler = (_event: unknown, payload: unknown) => {
          const parsed = LibraryImportProgressSchema.safeParse(payload);
          if (parsed.success) listener(parsed.data as LibraryImportProgress);
        };
        ipc.on(channels.libraryImportProgress, handler);
        return () => ipc.removeListener(channels.libraryImportProgress, handler);
      },
      remove: (bookIds, deleteOriginal) => ipc.invoke(channels.libraryRemove, { bookIds, ...(deleteOriginal ? { deleteOriginal } : {}) }),
      relocate: (bookId) => ipc.invoke(channels.libraryRelocate, { bookId }),
      updateBook: (input) => ipc.invoke(channels.libraryUpdateBook, input),
      setReadingState: (input) => ipc.invoke(channels.librarySetReadingState, input),
      revealInFolder: (bookId) => ipc.invoke(channels.libraryRevealInFolder, { bookId }),
      importPaths: (paths) => ipc.invoke(channels.libraryImportPaths, { paths }),
      getFilePath: (file) => {
        try {
          if (webUtils && typeof webUtils.getPathForFile === "function") {
            return webUtils.getPathForFile(file) || null;
          }
        } catch {
          // Fallback in non-Electron environments
        }
        return null;
      },
      retryPreparation: (bookId) =>
        ipc.invoke(channels.libraryPreparationRetry, { bookId }),
      onPreparationChanged: (listener) => {
        const handler = (_event: unknown, payload: unknown) => {
          const parsed = PublicPreparationEventSchema.safeParse(payload);
          if (parsed.success) listener(parsed.data as PublicPreparationEvent);
        };
        ipc.on(channels.libraryPreparationChanged, handler);
        return () => ipc.removeListener(channels.libraryPreparationChanged, handler);
      },
    },
    collections: {
      list: () => ipc.invoke(channels.collectionsList),
      get: (id) => ipc.invoke(channels.collectionsGet, { id }),
      create: (name) => ipc.invoke(channels.collectionsCreate, { name }),
      rename: (id, name) => ipc.invoke(channels.collectionsRename, { id, name }),
      delete: (id) => ipc.invoke(channels.collectionsDelete, { id }),
      addBooks: (id, bookIds) => ipc.invoke(channels.collectionsAddBooks, { id, bookIds }),
      removeBooks: (id, bookIds) => ipc.invoke(channels.collectionsRemoveBooks, { id, bookIds }),
      reorder: (id, bookIds) => ipc.invoke(channels.collectionsReorder, { id, bookIds }),
      getMemberships: (bookIds) => ipc.invoke(channels.collectionsGetMemberships, { bookIds }),
      listUnorganized: () => ipc.invoke(channels.collectionsListUnorganized),
      importFolder: (targetCollectionId) => targetCollectionId
        ? ipc.invoke(channels.collectionsImportFolder, { id: targetCollectionId })
        : ipc.invoke(channels.collectionsImportFolder),
      importOrganizedFolder: () => ipc.invoke(channels.collectionsImportOrganizedFolder),
      importFiles: (id) => ipc.invoke(channels.collectionsImportFiles, { id }),
      onFolderImportProgress: (listener) => {
        const handler = (_event: unknown, payload: unknown) => {
          const parsed = FolderCollectionImportProgressSchema.safeParse(payload);
          if (parsed.success) listener(parsed.data as FolderCollectionImportProgress);
        };
        ipc.on(channels.collectionsImportFolderProgress, handler);
        return () => ipc.removeListener(channels.collectionsImportFolderProgress, handler);
      },
    },
    reader: {
      open: (bookId) => ipc.invoke(channels.readerOpen, { bookId }),
      getEpubBinary: (bookId, sourceRevision) =>
        ipc.invoke(channels.readerEpubBinary, { bookId, sourceRevision }),
      canResume: (bookId, sourceRevision) =>
        ipc.invoke(channels.readerCanResume, { bookId, sourceRevision }),
      getChapter: (bookId, chapterId) => ipc.invoke(channels.readerChapter, { bookId, chapterId }),
      saveProgress: (bookId, sessionId, location) =>
        ipc.invoke(channels.readerSaveProgress, { bookId, sessionId, location }),
      closeSession: (bookId, sessionId, location) =>
        ipc.invoke(channels.readerCloseSession, { bookId, sessionId, location }),
    },
    settings: {
      getAppearance: () => ipc.invoke(channels.settingsGet),
      updateAppearance: (value: ReadingAppearance) => ipc.invoke(channels.settingsUpdate, value),
      getShortcuts: () => ipc.invoke(channels.settingsShortcutsGet),
      updateShortcuts: (value: ReaderShortcutProfileV1) =>
        ipc.invoke(channels.settingsShortcutsUpdate, value),
    },
    search: {
      fulltext: (request) => ipc.invoke(channels.searchFulltext, request),
    },
    scan: {
      /**
       * Opens a folder picker in the main process. The chosen path never crosses back
       * here — only a display name — so the renderer cannot learn or leak where the
       * user keeps their books.
       */
      chooseFolder: () => ipc.invoke(channels.scanChooseFolder),
      start: () => ipc.invoke(channels.scanStart),
      active: () => ipc.invoke(channels.scanActive),
      pause: (jobId: string) => ipc.invoke(channels.scanPause, { jobId }),
      resume: (jobId: string) => ipc.invoke(channels.scanResume, { jobId }),
      cancel: (jobId: string) => ipc.invoke(channels.scanCancel, { jobId }),
      overview: () => ipc.invoke(channels.scanOverview),
      findings: (request) => ipc.invoke(channels.scanFindings, request),
      decide: (request) => ipc.invoke(channels.scanDecide, request),
      decideBatch: (request) => ipc.invoke(channels.scanDecideBatch, request),
      files: (request) => ipc.invoke(channels.scanFiles, request),
      importFiles: (request) => ipc.invoke(channels.scanImport, request),
      organize: (request) => ipc.invoke(channels.scanOrganize, request),
      cancelImport: () => ipc.invoke(channels.scanImportCancel),
      activeImport: () => ipc.invoke(channels.scanImportActive),
      onProgress: (listener: (snapshot: LibraryScanSnapshot) => void) => {
        const handler = (_event: unknown, payload: unknown) => {
          const parsed = LibraryScanSnapshotSchema.safeParse(payload);
          if (parsed.success) listener(parsed.data as LibraryScanSnapshot);
        };
        ipc.on(channels.scanProgress, handler);
        return () => ipc.removeListener(channels.scanProgress, handler);
      },
      onImportProgress: (listener: (progress: ScanImportProgress) => void) => {
        const handler = (_event: unknown, payload: unknown) => {
          const parsed = ScanImportProgressSchema.safeParse(payload);
          if (parsed.success) listener(parsed.data as ScanImportProgress);
        };
        ipc.on(channels.scanImportProgress, handler);
        return () => ipc.removeListener(channels.scanImportProgress, handler);
      },
    },
  };
}

export function shouldExposeReaderApi(isMainFrame: boolean): boolean {
  return isMainFrame;
}

if (shouldExposeReaderApi(process.isMainFrame)) {
  contextBridge.exposeInMainWorld("readerApi", Object.freeze(createReaderApi(electronIpc)));
}
