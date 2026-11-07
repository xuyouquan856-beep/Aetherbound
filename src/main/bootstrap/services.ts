import { app } from "electron";
import { realpath } from "node:fs/promises";
import { createBookTextExtractor } from "../../backend/indexing/book-text-extractor.js";
import { TextIndexer } from "../../backend/indexing/text-indexer.js";
import { BookPreparationCoordinator } from "../../backend/library/book-preparation-coordinator.js";
import { BookPreparationJobRepository } from "../../backend/library/book-preparation-job-repository.js";
import { EpubPreparationService } from "../../backend/library/epub-preparation-service.js";
import { LibraryAdmissionService } from "../../backend/library/library-admission-service.js";
import { LibraryImportService } from "../../backend/library/library-import-service.js";
import { LibraryService } from "../../backend/library/library-service.js";
import { PreparedEpubBinaryService } from "../../backend/library/prepared-epub-binary-service.js";
import { CustomCollectionService } from "../../backend/library/custom-collection-service.js";
import { FolderCollectionImportService } from "../../backend/library/folder-collection-import-service.js";
import { ReadingSessionService } from "../../backend/sessions/reading-session-service.js";
import { ReadingRecordsService } from "../../backend/records/reading-records-service.js";
import { openDatabase } from "../../backend/storage/database.js";
import { ProgressRepository } from "../../backend/storage/progress-repository.js";
import { SettingsRepository } from "../../backend/storage/settings-repository.js";
// The folder-scan subsystem. Reader Core does not depend on any of this: the modules
// below are wired here because this is the composition root, and nothing they do is
// reachable from opening, rendering or indexing a book.
import { FileInventoryRepository } from "../../backend/library-scan/file-inventory-repository.js";
import { LibraryRootRepository } from "../../backend/library-scan/library-root-repository.js";
import { LightweightMetadataExtractor } from "../../backend/library-scan/lightweight-metadata-extractor.js";
import { LocalResolutionService } from "../../backend/library-scan/local-resolution-service.js";
import { DuplicateRecycleService } from "../../backend/library-scan/duplicate-recycle-service.js";
import { ScanFindingRepository } from "../../backend/library-scan/scan-finding-repository.js";
import { ScanJobRepository } from "../../backend/library-scan/scan-job-repository.js";
import { ScanJobService } from "../../backend/library-scan/scan-job-service.js";
import { ScanOperationRepository } from "../../backend/library-scan/operation-repository.js";
import { ScanReviewService } from "../../backend/library-scan/scan-review-service.js";
import { ScanImportService } from "../../backend/library-scan/scan-import-service.js";
import { loadLibraryLinks } from "../../backend/library-scan/library-link.js";
import { walkInventory } from "../../backend/library-scan/inventory-walker.js";
import { quickFingerprint, fullContentHash } from "../../backend/library/fingerprint.js";
import { coverThumbnailer } from "../covers/cover-thumbnail.js";
import { moveFileToRecycleBin } from "../trash/recycle-bin.js";
import { recycleManagedFile } from "../../backend/library-scan/recycle-file.js";

export function createServices() {
  const opened = openDatabase(process.env.READER_DATA_ROOT || app.getPath("userData"));
  const library = new LibraryService(opened.db, opened.dataRoot, coverThumbnailer);
  const epubBinary = new PreparedEpubBinaryService(
    (bookId, sourceRevision) =>
      library.getPreparedEpubPath(bookId, sourceRevision),
  );
  const admission = new LibraryAdmissionService(opened.db);
  const preparationJobs = new BookPreparationJobRepository(opened.db);
  const preparations = new BookPreparationCoordinator(
    preparationJobs,
    new EpubPreparationService(opened.db, opened.dataRoot, {
      createCoverThumbnail: coverThumbnailer,
    }),
  );
  const textIndexer = new TextIndexer(
    opened.db,
    createBookTextExtractor(
      opened.db,
      (bookId, sourceRevision) =>
        library.getPreparedEpubPath(bookId, sourceRevision),
    ),
  );
  preparations.subscribe((event) => {
    if (event.state === "ready") textIndexer.enqueue(event.bookId);
  });
  // EPUB books gain an indexable revision when preparation finishes; TXT books are
  // readable immediately and were previously never enqueued at all.
  textIndexer.recoverPending();
  const importer = new LibraryImportService({ admission, preparations, textIndexer });
  const collections = new CustomCollectionService(opened.db, library);

  const scan = createScanServices(opened, { importer, collections });

  return {
    db: opened,
    admission,
    importer,
    collections,
    folderCollectionImporter: new FolderCollectionImportService(importer, collections),
    library,
    epubBinary,
    preparations,
    progress: new ProgressRepository(opened.db),
    sessions: new ReadingSessionService(opened.db),
    records: new ReadingRecordsService(opened.db),
    settings: new SettingsRepository(opened.db),
    textIndexer,
    scan,
  };
}

/**
 * Composition root for the folder-scan subsystem.
 *
 * Kept in its own function so the scan's dependencies are visible in one place, and so
 * it is obvious that none of them are Reader Core's: a scan can be wired, run and
 * reviewed without a window, a rendition or a reader session existing.
 */
function createScanServices(
  opened: ReturnType<typeof openDatabase>,
  core: {
    importer: LibraryImportService;
    collections: CustomCollectionService;
  },
) {
  const { db } = opened;
  const roots = new LibraryRootRepository(db);
  const inventory = new FileInventoryRepository(db);
  const findings = new ScanFindingRepository(db);
  const operations = new ScanOperationRepository(db);

  const jobs = new ScanJobService({
    roots,
    inventory,
    jobs: new ScanJobRepository(db),
    metadataExtractor: new LightweightMetadataExtractor(),
    resolutionService: new LocalResolutionService(db),
    loadLibraryLinks: () => loadLibraryLinks(db),
    // The folder the user last chose. Null until they pick one, which the service
    // reports as MANAGED_FOLDER_REQUIRED so the UI can ask instead of guessing.
    getManagedRoot: async () => roots.getMostRecent()?.rootPath ?? null,
    canonicalizeRoot: (path) => realpath(path),
    walk: walkInventory,
    now: () => new Date().toISOString(),
  });

  // A scan that was running when the app closed is left `running` in the database.
  // Marking it recoverable at startup is what lets the UI offer to continue it rather
  // than showing a job that will never progress.
  jobs.recoverInterruptedJobs();

  const review = new ScanReviewService({
    db,
    roots,
    inventory,
    findings,
    operations,
    recycler: new DuplicateRecycleService({
      inventory,
      findings,
      operations,
      quickFingerprint,
      fullContentHash,
      trash: (root, path) => recycleManagedFile(root, path, moveFileToRecycleBin),
      now: () => new Date().toISOString(),
    }),
    collections: core.collections,
    importer: core.importer,
    now: () => new Date().toISOString(),
  });

  // Bringing a scanned folder into the library can take minutes over a thousand books,
  // so it runs as a job with progress and a cancel, not as a request that returns when
  // it is all over.
  const imports = new ScanImportService({
    review,
    importer: core.importer,
    now: () => new Date().toISOString(),
  });

  return { roots, inventory, findings, operations, jobs, review, imports };
}

export type Services = ReturnType<typeof createServices>;
