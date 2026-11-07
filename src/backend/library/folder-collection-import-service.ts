import { realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { CollectionNameSchema } from "../../shared/contracts.js";
import type {
  CollectionDetails,
  CollectionSummary,
  FolderCollectionImportProgress,
  FolderCollectionImportResult,
  LibraryImportItemResult,
} from "../../shared/contracts.js";
import { ReaderError } from "../../shared/errors.js";
import { walkInventory } from "../library-scan/inventory-walker.js";
import type {
  ImportProgress,
  LibraryImportService,
  MixedImportFile,
} from "./library-import-service.js";

type MixedImporter = Pick<LibraryImportService, "importMixedFiles">;

type CollectionPort = {
  create(name: string): Promise<CollectionDetails>;
  resolveFolderImport(folderPath: string, name: string, bookIds: readonly string[]): Promise<CollectionDetails>;
  addBooks(id: string, bookIds: readonly string[]): Promise<CollectionDetails>;
  list(): Promise<CollectionSummary[]>;
};

const collator = new Intl.Collator("zh-CN", {
  numeric: true,
  sensitivity: "base",
});

const ImportBatchSize = 250;
const MembershipBatchSize = 1000;
const MaxFolderFiles = 10000;

export class FolderCollectionImportService {
  constructor(
    private readonly importer: MixedImporter,
    private readonly collections: CollectionPort,
  ) {}

  async import(
    folderPath: string,
    onProgress?: (value: FolderCollectionImportProgress) => void,
    targetCollectionId?: string,
  ): Promise<Exclude<FolderCollectionImportResult, { status: "cancelled" }>> {
    const existingCollection = targetCollectionId
      ? (await this.collections.list()).find((item) => item.id === targetCollectionId)
      : null;
    if (targetCollectionId && !existingCollection) {
      throw new ReaderError("INVALID_REQUEST", "目标珍藏不存在。");
    }
    const { root, folderName, files, ignoredEntries, items } = await this.readFolder(folderPath, onProgress);
    if (files.length === 0) return { status: "empty", folderName };

    const successful = items.filter(
      (item): item is Extract<LibraryImportItemResult, { status: "imported" | "duplicate" }> =>
        item.status === "imported" || item.status === "duplicate",
    );
    if (successful.length === 0) {
      return { status: "failed", folderName, items, ignoredEntries };
    }

    const collection = existingCollection ?? await this.collections.resolveFolderImport(
      root, folderName, successful.map(({ book }) => book.id),
    );
    await this.addMemberships(collection.id, successful.map(({ book }) => book.id));
    const summary = (await this.collections.list()).find(({ id }) => id === collection.id);
    if (!summary) throw new ReaderError("DATABASE_ERROR", "无法读取刚创建的珍藏。");
    return { status: "completed", folderName, collection: summary, items, ignoredEntries };
  }

  async importOrganized(
    folderPath: string,
    onProgress?: (value: FolderCollectionImportProgress) => void,
  ): Promise<Exclude<FolderCollectionImportResult, { status: "cancelled" }>> {
    const { root, folderName, files, ignoredEntries, items } = await this.readFolder(folderPath, onProgress);
    if (files.length === 0) return { status: "empty", folderName };
    const groups = new Map<string, string[]>();
    let rootFiles = 0;
    for (let index = 0; index < files.length; index += 1) {
      const item = items[index];
      if (!item || (item.status !== "imported" && item.status !== "duplicate")) continue;
      const segments = files[index]!.relativePath.split("/");
      const name = segments[0] ?? "";
      if (segments.length < 2 || !CollectionNameSchema.safeParse(name).success) {
        rootFiles += 1;
        continue;
      }
      const ids = groups.get(name) ?? [];
      ids.push(item.book.id);
      groups.set(name, ids);
    }
    if (groups.size === 0 && rootFiles === 0) {
      return { status: "failed", folderName, items, ignoredEntries };
    }
    const collectionIds: string[] = [];
    for (const [name, ids] of groups) {
      const collection = await this.collections.resolveFolderImport(join(root, name), name, ids);
      await this.addMemberships(collection.id, ids);
      collectionIds.push(collection.id);
    }
    const summaries = await this.collections.list();
    return {
      status: "organized",
      folderName,
      collections: collectionIds.flatMap((id) => {
        const found = summaries.find((item) => item.id === id);
        return found ? [found] : [];
      }),
      rootFiles,
      items,
      ignoredEntries,
    };
  }

  private async addMemberships(collectionId: string, bookIds: string[]) {
    const uniqueBookIds = [...new Set(bookIds)];
    for (let index = 0; index < uniqueBookIds.length; index += MembershipBatchSize) {
      await this.collections.addBooks(collectionId, uniqueBookIds.slice(index, index + MembershipBatchSize));
    }
  }

  private async readFolder(
    folderPath: string,
    onProgress?: (value: FolderCollectionImportProgress) => void,
  ) {
    const root = await realpath(folderPath);
    const folderName = basename(root);
    const files: Array<MixedImportFile & { relativePath: string }> = [];
    let ignoredEntries = 0;

    for await (const entry of walkInventory(root, new AbortController().signal, () => {
      ignoredEntries += 1;
    })) {
      files.push({
        path: entry.absolutePath,
        format: entry.format,
        relativePath: entry.relativePath,
      });
      if (files.length > MaxFolderFiles) {
        throw new ReaderError("INVALID_REQUEST", "单次文件夹导入最多支持 10000 本，请分批选择文件夹。");
      }
    }

    files.sort((left, right) => collator.compare(left.path, right.path));
    if (files.length === 0) return { root, folderName, files, ignoredEntries, items: [] as LibraryImportItemResult[] };

    const items: LibraryImportItemResult[] = [];
    for (let index = 0; index < files.length; index += ImportBatchSize) {
      const batch = files.slice(index, index + ImportBatchSize);
      const progress = (value: ImportProgress) => onProgress?.({
        processed: index + value.processed,
        total: files.length,
        fileName: value.fileName,
      });
      items.push(...await this.importer.importMixedFiles(batch, progress));
    }
    return { root, folderName, files, ignoredEntries, items };
  }
}
