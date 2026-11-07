import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BookSummary } from "../../src/shared/contracts.js";
import {
  CustomCollectionService,
  normalizeCollectionName,
} from "../../src/backend/library/custom-collection-service.js";
import { migrate } from "../../src/backend/storage/database.js";

const book = (id: string): BookSummary => ({
  id,
  title: `书籍 ${id}`,
  author: `作者 ${id}`,
  format: id === "b4" ? "epub" : "txt",
  availabilityStatus: "available",
  progress: 0,
  addedAt: `2026-07-0${id.slice(1)}T00:00:00.000Z`,
  lastReadAt: null,
  updatedAt: `2026-07-0${id.slice(1)}T00:00:00.000Z`,
  coverUrl: id === "b4"
    ? "reader-resource://publication/b4/revision-4/cover"
    : null,
});

describe("CustomCollectionService", () => {
  let db: Database.Database;
  let service: CustomCollectionService;
  let ids: number;
  const books = ["b1", "b2", "b3", "b4"].map(book);

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db);
    for (const item of books) {
      db.prepare(
        "INSERT INTO books(id, format, title, author, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(item.id, item.format, item.title, item.author, item.addedAt, item.updatedAt);
    }
    ids = 0;
    service = new CustomCollectionService(db, {
      listBooks: async () => books,
      getBook: (bookId) => {
        const found = books.find(({ id }) => id === bookId);
        if (!found) throw new Error("missing");
        return found;
      },
    }, {
      now: () => "2026-07-29T00:00:00.000Z",
      id: () => `collection-${++ids}`,
    });
  });

  afterEach(() => db.close());

  it("normalizes NFKC, whitespace and case and reuses an existing name", async () => {
    expect(normalizeCollectionName("  ＦＡＮＴＡＳＹ   Books ")).toBe("fantasy books");
    const first = await service.create("  ＦＡＮＴＡＳＹ   Books ");
    const second = await service.create("fantasy books");
    expect(second.id).toBe(first.id);
    expect((await service.list())).toHaveLength(1);
  });

  it("reuses an existing collection for an equivalent folder and remembers the folder after membership changes", async () => {
    const old = await service.create("旧系列名");
    await service.addBooks(old.id, ["b1", "b2", "b3"]);

    const first = await service.resolveFolderImport("E:\\books\\新系列名", "新系列名", ["b1", "b2", "b3"]);
    expect(first.id).toBe(old.id);
    await service.addBooks(old.id, ["b4"]);
    const later = await service.resolveFolderImport("E:\\books\\新系列名", "新系列名", ["b1"]);
    expect(later.id).toBe(old.id);
    expect((await service.list())).toHaveLength(1);
  });

  it("does not guess a collection when folder books overlap two collections ambiguously", async () => {
    const one = await service.create("第一组");
    const two = await service.create("第二组");
    await service.addBooks(one.id, ["b1", "b2"]);
    await service.addBooks(two.id, ["b1", "b2"]);

    const created = await service.resolveFolderImport("E:\\books\\新分组", "新分组", ["b1", "b2"]);
    expect(created.id).not.toBe(one.id);
    expect(created.id).not.toBe(two.id);
  });

  it("does not reload the whole library for each small collection created during bulk organization", async () => {
    const listBooks = vi.fn(async () => books);
    const getBook = vi.fn((id: string) => books.find((item) => item.id === id)!);
    const bulk = new CustomCollectionService(db, { listBooks, getBook });

    for (let index = 0; index < 20; index += 1) {
      const collection = await bulk.create(`分组 ${index}`);
      await bulk.addBooks(collection.id, ["b1", "b2"]);
    }

    expect(listBooks).not.toHaveBeenCalled();
    expect(getBook).toHaveBeenCalledTimes(40);
  });

  it("rejects renaming a collection to another normalized name", async () => {
    const first = await service.create("待读");
    const second = await service.create("最爱");
    await expect(service.rename(second.id, `  ${first.name}  `)).rejects.toThrow();
  });

  it("allows one book in multiple collections and keeps additions idempotent", async () => {
    const first = await service.create("第一组");
    const second = await service.create("第二组");

    await service.addBooks(first.id, ["b1", "b2"]);
    await service.addBooks(first.id, ["b1", "b3"]);
    await service.addBooks(second.id, ["b1"]);

    expect((await service.get(first.id)).books.map(({ id }) => id)).toEqual(["b1", "b2", "b3"]);
    expect((await service.get(second.id)).books.map(({ id }) => id)).toEqual(["b1"]);
  });

  it("removes members idempotently and compacts positions", async () => {
    const collection = await service.create("顺序");
    await service.addBooks(collection.id, ["b1", "b2", "b3"]);
    await service.removeBooks(collection.id, ["b2", "missing-book"]);
    await service.removeBooks(collection.id, ["b2"]);

    const rows = db.prepare(
      "SELECT book_id, position FROM collection_books WHERE collection_id = ? ORDER BY position",
    ).all(collection.id);
    expect(rows).toEqual([
      { book_id: "b1", position: 0 },
      { book_id: "b3", position: 1 },
    ]);
  });

  it("reorders all current members atomically and rejects stale sets", async () => {
    const collection = await service.create("卷序");
    await service.addBooks(collection.id, ["b1", "b2", "b3"]);

    await expect(service.reorder(collection.id, ["b3", "b1"])).rejects.toThrow(/刷新/);
    expect((await service.get(collection.id)).books.map(({ id }) => id)).toEqual(["b1", "b2", "b3"]);

    await service.reorder(collection.id, ["b3", "b1", "b2"]);
    expect((await service.get(collection.id)).books.map(({ id }) => id)).toEqual(["b3", "b1", "b2"]);
  });

  it("deletes only the collection and preserves books", async () => {
    const collection = await service.create("临时");
    await service.addBooks(collection.id, ["b1"]);
    service.delete(collection.id);

    expect(await service.list()).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM books").get()).toEqual({ count: 4 });
  });

  it("lists only books without any collection membership", async () => {
    const collection = await service.create("已整理");
    await service.addBooks(collection.id, ["b1", "b2"]);
    expect((await service.listUnorganized()).map(({ id }) => id)).toEqual(["b3", "b4"]);

    await service.removeBooks(collection.id, ["b2"]);
    expect((await service.listUnorganized()).map(({ id }) => id)).toEqual(["b2", "b3", "b4"]);
  });

  it("returns at most three positioned preview books and membership intersections", async () => {
    const first = await service.create("四册");
    const second = await service.create("交叉");
    await service.addBooks(first.id, ["b4", "b2", "b3", "b1"]);
    await service.addBooks(second.id, ["b1", "b3"]);

    const [summary] = await service.list();
    expect(summary.previewBooks.map(({ id }) => id)).toEqual(["b4", "b2", "b3"]);
    expect(summary.previewBooks[0].coverUrl).toMatch(/^reader-resource:/);
    expect(service.getMemberships(["b1", "b2"])).toEqual([
      { collectionId: first.id, bookIds: ["b1", "b2"] },
      { collectionId: second.id, bookIds: ["b1"] },
    ]);
  });
});
