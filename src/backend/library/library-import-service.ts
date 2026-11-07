import { basename, extname } from "node:path";
import type {
  BookSummary,
  LibraryImportBatchResult,
  LibraryImportFormat,
  LibraryImportItemResult,
} from "../../shared/contracts.js";
import { publicError, ReaderError } from "../../shared/errors.js";
import type { LibraryAdmissionService } from "./library-admission-service.js";

type Dependencies = {
  admission: Pick<LibraryAdmissionService, "admitTxt" | "admitEpub">
    & Partial<Pick<LibraryAdmissionService, "knownBookIds">>;
  preparations: { notifyQueued(): void };
  /**
   * TXT books are readable the moment they are admitted, so they are handed to the
   * indexer here. EPUB books are indexed when preparation finishes instead, because
   * only then does a sanitized revision exist.
   */
  textIndexer: { enqueue(bookId: string): void };
};

export type MixedImportFile = {
  path: string;
  format: LibraryImportFormat;
};

export type ImportProgress = {
  processed: number;
  total: number;
  fileName: string | null;
};

export class LibraryImportService {
  constructor(private readonly dependencies: Dependencies) {}

  async importFiles(
    paths: readonly string[],
    format: LibraryImportFormat,
  ): Promise<LibraryImportBatchResult> {
    if (paths.length > 500) {
      throw new ReaderError("INVALID_REQUEST", "一次最多导入 500 个文件。");
    }

    const items = await this.importMixedFiles(paths.map((path) => ({ path, format })));
    return { status: "completed", items };
  }

  async importMixedFiles(
    files: readonly MixedImportFile[],
    onProgress?: (value: ImportProgress) => void,
  ): Promise<LibraryImportItemResult[]> {
    if (files.length > 10000) {
      throw new ReaderError("INVALID_REQUEST", "一次最多导入 10000 个文件，请分批选择。");
    }

    const items: LibraryImportItemResult[] = [];
    const admittedBookIds = new Set<string>();
    const knownBookIds = this.dependencies.admission.knownBookIds?.() ?? new Set<string>();

    for (const [index, entry] of files.entries()) {
      const { path, format } = entry;
      const fileName = basename(path);
      if (extname(path).toLowerCase() !== `.${format}`) {
        items.push({
          status: "unsupported",
          fileName,
          errorCode: "FORMAT_NOT_SUPPORTED",
        });
        onProgress?.({ processed: index + 1, total: files.length, fileName });
        continue;
      }

      try {
        let book: BookSummary;
        if (format === "txt") {
          book = await this.dependencies.admission.admitTxt(path);
          this.dependencies.textIndexer.enqueue(book.id);
        } else {
          book = await this.dependencies.admission.admitEpub(path);
          this.dependencies.preparations.notifyQueued();
        }
        const duplicate = knownBookIds.has(book.id) || admittedBookIds.has(book.id);
        admittedBookIds.add(book.id);
        items.push({
          status: duplicate ? "duplicate" : "imported",
          fileName,
          book,
        });
      } catch (error) {
        const exposed = publicError(error);
        items.push({
          status: "failed",
          fileName,
          errorCode: exposed.code,
          message: exposed.message,
        });
      }
      onProgress?.({ processed: index + 1, total: files.length, fileName });
    }

    return items;
  }
}
