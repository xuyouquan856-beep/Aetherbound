import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FolderCollectionImportResultSchema } from "../../src/shared/contracts.js";
import type {
  BookSummary,
  CollectionDetails,
  CollectionSummary,
  LibraryImportItemResult,
} from "../../src/shared/contracts.js";
import { FolderCollectionImportService } from "../../src/backend/library/folder-collection-import-service.js";
import { BookPreparationJobRepository } from "../../src/backend/library/book-preparation-job-repository.js";
import { CustomCollectionService } from "../../src/backend/library/custom-collection-service.js";
import { LibraryAdmissionService } from "../../src/backend/library/library-admission-service.js";
import { LibraryImportService } from "../../src/backend/library/library-import-service.js";
import { LibraryService } from "../../src/backend/library/library-service.js";
import { openDatabase } from "../../src/backend/storage/database.js";

const roots: string[] = [];

const book = (id: string, title: string): BookSummary => ({
  id,
  title,
  author: null,
  format: id.endsWith("epub") ? "epub" : "txt",
  availabilityStatus: "available",
  progress: 0,
  addedAt: "2026-07-29T00:00:00.000Z",
  lastReadAt: null,
  updatedAt: "2026-07-29T00:00:00.000Z",
  coverUrl: null,
});

const details = (id: string, name: string, books: BookSummary[] = []): CollectionDetails => ({
  id,
  name,
  createdAt: "2026-07-29T00:00:00.000Z",
  updatedAt: "2026-07-29T00:00:00.000Z",
  books,
});

const summary = (value: CollectionDetails): CollectionSummary => ({
  id: value.id,
  name: value.name,
  bookCount: value.books.length,
  previewBooks: value.books.slice(0, 3),
  updatedAt: value.updatedAt,
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("FolderCollectionImportService", () => {
  it("imports nested EPUB/TXT files in natural order without following directory links", async () => {
    const parent = await mkdtemp(join(tmpdir(), "aetherbound-folder-import-"));
    roots.push(parent);
    const root = join(parent, "无职转生");
    const nested = join(root, "nested");
    const outside = join(parent, "outside");
    await mkdir(nested, { recursive: true });
    await mkdir(outside);
    await Promise.all([
      writeFile(join(root, "第10卷.epub"), "epub-10"),
      writeFile(join(root, "第2卷.txt"), "txt-2"),
      writeFile(join(root, "broken.epub"), "broken"),
      writeFile(join(root, "cover.jpg"), "image"),
      writeFile(join(nested, "nested.epub"), "nested"),
      writeFile(join(outside, "outside.epub"), "outside"),
    ]);
    await symlink(outside, join(root, "linked"), "junction");

    const importMixedFiles = vi.fn(async (
      files: readonly { path: string; format: "txt" | "epub" }[],
      onProgress?: (value: { processed: number; total: number; fileName: string | null }) => void,
    ): Promise<LibraryImportItemResult[]> => {
      const items = files.map(({ path, format }, index) => {
        onProgress?.({ processed: index + 1, total: files.length, fileName: basename(path) });
        if (basename(path) === "broken.epub") {
          return {
            status: "failed" as const,
            fileName: basename(path),
            errorCode: "INVALID_PACKAGE" as const,
            message: "损坏",
          };
        }
        const imported = book(`book-${format}-${index}`, basename(path));
        return { status: "imported" as const, fileName: basename(path), book: imported };
      });
      return items;
    });
    let collection = details("collection-1", "无职转生");
    const collections = {
      create: vi.fn(async () => collection),
      resolveFolderImport: vi.fn(async () => collection),
      addBooks: vi.fn(async (_id: string, ids: readonly string[]) => {
        const imported = (await importMixedFiles.mock.results[0].value)
          .filter((item: LibraryImportItemResult) => item.status === "imported")
          .map((item: Extract<LibraryImportItemResult, { status: "imported" }>) => item.book)
          .filter((item: BookSummary) => ids.includes(item.id));
        collection = details(collection.id, collection.name, imported);
        return collection;
      }),
      list: vi.fn(async () => [summary(collection)]),
    };
    const progress = vi.fn();
    const service = new FolderCollectionImportService({ importMixedFiles }, collections);

    const result = await service.import(root, progress);

    expect(importMixedFiles).toHaveBeenCalledOnce();
    const files = importMixedFiles.mock.calls[0][0];
    const names = files.map(({ path }) => basename(path));
    expect(names).toContain("nested.epub");
    expect(names).not.toContain("outside.epub");
    expect(names.indexOf("第2卷.txt")).toBeLessThan(names.indexOf("第10卷.epub"));
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("expected completed");
    expect(result.folderName).toBe("无职转生");
    expect(result.ignoredEntries).toBe(1);
    expect(result.items.filter(({ status }) => status === "failed")).toHaveLength(1);
    expect(collections.addBooks).toHaveBeenCalledWith(
      "collection-1",
      expect.arrayContaining([expect.stringContaining("book-txt"), expect.stringContaining("book-epub")]),
    );
    expect(JSON.stringify(result)).not.toContain(parent);
    expect(progress).toHaveBeenLastCalledWith({
      processed: 4,
      total: 4,
      fileName: expect.any(String),
    });
  });

  it("appends a folder to an existing collection without creating another one", async () => {
    const root = await mkdtemp(join(tmpdir(), "aetherbound-append-folder-"));
    roots.push(root);
    await mkdir(join(root, "more"));
    await writeFile(join(root, "more", "new.txt"), "new book");
    const existing = details("existing-collection", "收藏", [book("old", "原有书籍")]);
    const create = vi.fn();
    const addBooks = vi.fn(async () => existing);
    const collections = {
      create,
      resolveFolderImport: vi.fn(),
      addBooks,
      list: vi.fn(async () => [summary(existing)]),
    };
    const imported = book("new", "新书");
    const importer = { importMixedFiles: vi.fn(async () => [
      { status: "imported" as const, fileName: "new.txt", book: imported },
    ]) };

    const result = await new FolderCollectionImportService(importer, collections)
      .import(root, undefined, existing.id);

    expect(result.status).toBe("completed");
    expect(create).not.toHaveBeenCalled();
    expect(addBooks).toHaveBeenCalledWith(existing.id, [imported.id]);
  });

  it("imports more than 2000 books in bounded batches", async () => {
    const root = await mkdtemp(join(tmpdir(), "aetherbound-large-folder-"));
    roots.push(root);
    for (let offset = 0; offset < 2201; offset += 200) {
      await Promise.all(Array.from({ length: Math.min(200, 2201 - offset) }, (_, i) =>
        writeFile(join(root, `book-${offset + i}.txt`), `book ${offset + i}`)));
    }
    const importedIds: string[] = [];
    const collection = details("large-collection", "大书库");
    const importMixedFiles = vi.fn(async (files: readonly { path: string; format: "txt" | "epub" }[]) =>
      files.map(({ path }) => ({
        status: "imported" as const,
        fileName: basename(path),
        book: book(basename(path), basename(path)),
      })));
    const addBooks = vi.fn(async (_id: string, ids: readonly string[]) => {
      importedIds.push(...ids);
      return collection;
    });
    const service = new FolderCollectionImportService({ importMixedFiles }, {
      create: vi.fn(async () => collection),
      resolveFolderImport: vi.fn(async () => collection),
      addBooks,
      list: vi.fn(async () => [{ ...summary(collection), bookCount: importedIds.length }]),
    });

    const result = await service.import(root);

    expect(result.status).toBe("completed");
    expect(importedIds).toHaveLength(2201);
    expect(importMixedFiles.mock.calls.every(([files]) => files.length <= 250)).toBe(true);
    expect(addBooks.mock.calls.every(([, ids]) => ids.length <= 1000)).toBe(true);
    expect(FolderCollectionImportResultSchema.safeParse(result).success).toBe(true);
  });

  it("files first-level folders into matching collections and leaves root books unfiled", async () => {
    const root = await mkdtemp(join(tmpdir(), "aetherbound-organized-folder-"));
    roots.push(root);
    await mkdir(join(root, "科幻", "series"), { recursive: true });
    await mkdir(join(root, "文学"));
    await Promise.all([
      writeFile(join(root, "科幻", "series", "星河.txt"), "space"),
      writeFile(join(root, "文学", "诗集.epub"), "poetry"),
      writeFile(join(root, "散书.txt"), "loose"),
    ]);
    const known = details("existing-scifi", "科幻");
    const literature = details("new-literature", "文学");
    const create = vi.fn(async (name: string) => name === "科幻" ? known : literature);
    const addBooks = vi.fn(async () => known);
    const collections = {
      create,
      resolveFolderImport: vi.fn(async (_path: string, name: string) => create(name)),
      addBooks,
      list: vi.fn(async () => [summary(known), summary(literature)]),
    };
    const importer = { importMixedFiles: vi.fn(async (files: readonly { path: string }[]) =>
      files.map(({ path }) => ({
        status: "imported" as const,
        fileName: basename(path),
        book: book(basename(path), basename(path)),
      }))) };

    const result = await new FolderCollectionImportService(importer, collections)
      .importOrganized(root);

    expect(result.status).toBe("organized");
    if (result.status !== "organized") throw new Error("expected organized result");
    expect(result.rootFiles).toBe(1);
    expect(create).toHaveBeenCalledWith("科幻");
    expect(create).toHaveBeenCalledWith("文学");
    expect(addBooks).toHaveBeenCalledWith("existing-scifi", ["星河.txt"]);
    expect(addBooks).toHaveBeenCalledWith("new-literature", ["诗集.epub"]);
    expect(FolderCollectionImportResultSchema.safeParse(result).success).toBe(true);
  });

  it("uses the old collection for a renamed series folder instead of creating a duplicate", async () => {
    const parent = await mkdtemp(join(tmpdir(), "aetherbound-series-alias-"));
    roots.push(parent);
    const root = join(parent, "书库");
    await mkdir(join(root, "新文件夹名"), { recursive: true });
    await writeFile(join(root, "新文件夹名", "第一卷.txt"), "existing book");
    const opened = openDatabase(join(parent, "data"));
    try {
      const importedBook = book("existing-book", "第一卷");
      const collections = new CustomCollectionService(opened.db, {
        listBooks: async () => [importedBook],
        getBook: () => importedBook,
      });
      const old = await collections.create("旧珍藏名");
      opened.db.prepare(
        "INSERT INTO books(id, format, title, author, created_at, updated_at) VALUES (?, 'txt', ?, NULL, 'now', 'now')",
      ).run(importedBook.id, importedBook.title);
      await collections.addBooks(old.id, [importedBook.id]);
      const importer = { importMixedFiles: vi.fn(async () => [{
        status: "duplicate" as const,
        fileName: "第一卷.txt",
        book: importedBook,
      }]) };

      const result = await new FolderCollectionImportService(importer, collections).importOrganized(root);

      expect(result.status).toBe("organized");
      expect((await collections.list()).map(({ name }) => name)).toEqual(["旧珍藏名"]);
      expect(opened.db.prepare("SELECT collection_id FROM collection_import_aliases").all())
        .toEqual([{ collection_id: old.id }]);
    } finally {
      opened.close();
    }
  });

  it("returns empty without creating a collection when no supported files exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "aetherbound-empty-folder-"));
    roots.push(root);
    await writeFile(join(root, "cover.jpg"), "image");
    const importer = { importMixedFiles: vi.fn() };
    const collections = {
      create: vi.fn(),
      resolveFolderImport: vi.fn(),
      addBooks: vi.fn(),
      list: vi.fn(),
    };

    const result = await new FolderCollectionImportService(importer, collections).import(root);

    expect(result).toEqual({
      status: "empty",
      folderName: basename(root),
    });
    expect(collections.create).not.toHaveBeenCalled();
  });

  it("returns failed without creating a collection when every supported book fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "aetherbound-failed-folder-"));
    roots.push(root);
    await writeFile(join(root, "broken.epub"), "broken");
    const items: LibraryImportItemResult[] = [{
      status: "failed",
      fileName: "broken.epub",
      errorCode: "INVALID_PACKAGE",
      message: "损坏",
    }];
    const collections = {
      create: vi.fn(),
      resolveFolderImport: vi.fn(),
      addBooks: vi.fn(),
      list: vi.fn(),
    };

    const result = await new FolderCollectionImportService({
      importMixedFiles: vi.fn(async () => items),
    }, collections).import(root);

    expect(result).toEqual({
      status: "failed",
      folderName: basename(root),
      items,
      ignoredEntries: 0,
    });
    expect(collections.create).not.toHaveBeenCalled();
  });

  it("adds a same-content duplicate book to the collection only once", async () => {
    const root = await mkdtemp(join(tmpdir(), "aetherbound-duplicate-folder-"));
    roots.push(root);
    await Promise.all([
      writeFile(join(root, "one.txt"), "same"),
      writeFile(join(root, "copy.txt"), "same"),
    ]);
    const sameBook = book("same-book", "同一本书");
    let collection = details("collection-1", basename(root));
    const addBooks = vi.fn(async (_id: string, ids: readonly string[]) => {
      collection = details(collection.id, collection.name, ids.map(() => sameBook));
      return collection;
    });
    const collections = {
      create: vi.fn(async () => collection),
      resolveFolderImport: vi.fn(async () => collection),
      addBooks,
      list: vi.fn(async () => [summary(collection)]),
    };
    const importer = {
      importMixedFiles: vi.fn(async (): Promise<LibraryImportItemResult[]> => [
        { status: "imported", fileName: "copy.txt", book: sameBook },
        { status: "duplicate", fileName: "one.txt", book: sameBook },
      ]),
    };

    await new FolderCollectionImportService(importer, collections).import(root);

    expect(addBooks).toHaveBeenCalledWith("collection-1", ["same-book"]);
  });

  it("commits admitted membership before preparation and keeps it after preparation failure", async () => {
    const parent = await mkdtemp(join(tmpdir(), "aetherbound-staged-folder-"));
    roots.push(parent);
    const folder = join(parent, "待准备珍藏");
    const nested = join(folder, "nested");
    const dataRoot = join(parent, "data");
    await mkdir(nested, { recursive: true });
    await writeFile(join(folder, "queued.epub"), "not parsed during admission");
    await writeFile(join(nested, "nested.epub"), "nested");
    const opened = openDatabase(dataRoot);
    try {
      const library = new LibraryService(opened.db, dataRoot);
      const importer = new LibraryImportService({
        admission: new LibraryAdmissionService(opened.db),
        preparations: { notifyQueued: vi.fn() },
        textIndexer: { enqueue: vi.fn() },
      });
      const collections = new CustomCollectionService(opened.db, library, {
        id: () => "collection-staged",
        now: () => "2026-07-29T00:00:00.000Z",
      });
      const service = new FolderCollectionImportService(importer, collections);

      const result = await service.import(folder);

      expect(result.status).toBe("completed");
      if (result.status !== "completed") throw new Error("expected completed");
      expect(result.collection.bookCount).toBe(2);
      const queued = result.items.find((item) => item.fileName === "queued.epub");
      expect(queued).toMatchObject({
        status: "imported",
        book: { preparationStatus: "queued" },
      });
      const imported = queued;
      if (!imported || imported.status !== "imported") throw new Error("expected imported");
      const source = library.getSourceForBook(imported.book.id);
      const jobs = new BookPreparationJobRepository(opened.db);
      expect(jobs.markPreparing(
        imported.book.id,
        source.sourceRevision,
        "2026-07-29T00:00:01.000Z",
      )).toBe(true);
      expect(jobs.markError(
        imported.book.id,
        source.sourceRevision,
        "INVALID_PACKAGE",
        "2026-07-29T00:00:02.000Z",
      )).toBe(true);

      const persisted = await collections.get("collection-staged");
      expect(persisted.books).toContainEqual(expect.objectContaining({
        id: imported.book.id,
        preparationStatus: "error",
        preparationErrorCode: "INVALID_PACKAGE",
      }));
      expect(JSON.stringify(persisted)).not.toContain(parent);
    } finally {
      opened.close();
    }
  });
});
