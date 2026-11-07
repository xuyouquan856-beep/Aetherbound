import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../src/backend/storage/database.js";
import { CollectionService } from "../../src/backend/library/collection-service.js";

function seedBooks(db: Database.Database) {
  db.exec("INSERT INTO books(id, title, format, created_at, updated_at) VALUES ('b1','三体','txt','now','now'), ('b2','三体 II','epub','now','now'), ('b3','One Piece','epub','now','now')");
}

describe("CollectionService", () => {
  let db: Database.Database;
  let svc: CollectionService;

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db);
    seedBooks(db);
    svc = new CollectionService(db);
  });

  afterEach(() => db.close());

  // --- Series CRUD ---

  it("createSeries returns an object with id, name, and normalizedName", () => {
    const s = svc.createSeries("三体系列");
    expect(s.id).toBeTruthy();
    expect(typeof s.id).toBe("string");
    expect(s.name).toBe("三体系列");
    expect(s.normalizedName).toBe("三体系列");
  });

  it("deduplicates by normalizedName — creating same name returns existing series", () => {
    const first = svc.createSeries("三体");
    const second = svc.createSeries("三体");
    expect(second.id).toBe(first.id);
  });

  it("renameSeries changes the name", () => {
    const s = svc.createSeries("三体");
    svc.renameSeries(s.id, "三体系列");
    const updated = svc.getSeries(s.id);
    expect(updated?.name).toBe("三体系列");
  });

  it("deleteSeries cascade-deletes series_books entries", () => {
    const s = svc.createSeries("三体系列");
    svc.addBookToSeries(s.id, "b1", { confidence: 1, source: "automatic" });
    svc.deleteSeries(s.id);
    const books = db.prepare("SELECT * FROM series_books WHERE series_id = ?").all(s.id);
    expect(books).toHaveLength(0);
    expect(svc.getSeries(s.id)).toBeNull();
  });

  it("listSeries returns all series sorted by updatedAt desc", () => {
    svc.createSeries("A");
    svc.createSeries("B");
    expect(svc.listSeries()).toHaveLength(2);
  });

  it("getSeries returns series with sorted books", () => {
    const s = svc.createSeries("三体系列");
    svc.addBookToSeries(s.id, "b2", { volumeIndex: 1, confidence: 1, source: "automatic" });
    svc.addBookToSeries(s.id, "b1", { volumeIndex: 2, confidence: 1, source: "automatic" });
    const result = svc.getSeries(s.id)!;
    expect(result.books).toHaveLength(2);
    expect(result.books[0].bookId).toBe("b2");
    expect(result.books[0].volumeIndex).toBe(1);
    expect(result.books[1].bookId).toBe("b1");
    expect(result.books[1].volumeIndex).toBe(2);
  });

  // --- Volume ordering ---

  it("addBookToSeries with volumeLabel stores the label", () => {
    const s = svc.createSeries("三体系列");
    svc.addBookToSeries(s.id, "b1", { volumeLabel: "上卷", confidence: 1, source: "automatic" });
    const r = svc.getSeries(s.id)!;
    expect(r.books[0].volumeLabel).toBe("上卷");
  });

  it("removeBookFromSeries removes a single entry", () => {
    const s = svc.createSeries("三体系列");
    svc.addBookToSeries(s.id, "b1", { confidence: 1, source: "automatic" });
    svc.addBookToSeries(s.id, "b2", { confidence: 1, source: "automatic" });
    svc.removeBookFromSeries(s.id, "b1");
    const r = svc.getSeries(s.id)!;
    expect(r.books).toHaveLength(1);
    expect(r.books[0].bookId).toBe("b2");
  });

  it("reorderBooks rewrites all volumeIndex values", () => {
    const s = svc.createSeries("三体系列");
    svc.addBookToSeries(s.id, "b1", { confidence: 1, source: "automatic" });
    svc.addBookToSeries(s.id, "b2", { confidence: 1, source: "automatic" });
    svc.reorderBooks(s.id, ["b2", "b1"]);
    const r = svc.getSeries(s.id)!;
    expect(r.books[0].bookId).toBe("b2");
    expect(r.books[0].volumeIndex).toBe(1);
    expect(r.books[1].bookId).toBe("b1");
    expect(r.books[1].volumeIndex).toBe(2);
  });

  it("rejects adding the same book to the same series twice", () => {
    const s = svc.createSeries("三体系列");
    svc.addBookToSeries(s.id, "b1", { confidence: 1, source: "automatic" });
    expect(() => svc.addBookToSeries(s.id, "b1", { confidence: 1, source: "automatic" })).toThrow();
  });

  // --- Locking ---

  it("locked series rejects source='automatic' writes", () => {
    const s = svc.createSeries("三体系列");
    svc.lockSeries(s.id);
    expect(svc.isLocked(s.id)).toBe(true);
    expect(() => svc.addBookToSeries(s.id, "b3", { confidence: 0.9, source: "automatic" })).toThrow();
  });

  it("locked series still accepts source='manual' writes", () => {
    const s = svc.createSeries("三体系列");
    svc.lockSeries(s.id);
    expect(() => svc.addBookToSeries(s.id, "b3", { confidence: 1, source: "manual" })).not.toThrow();
  });

  it("unlockSeries allows automatic writes again", () => {
    const s = svc.createSeries("三体系列");
    svc.lockSeries(s.id);
    svc.unlockSeries(s.id);
    expect(svc.isLocked(s.id)).toBe(false);
    expect(() => svc.addBookToSeries(s.id, "b3", { confidence: 0.9, source: "automatic" })).not.toThrow();
  });

  // --- Aliases ---

  it("addBookAlias and listBookAliases round-trip", () => {
    svc.addBookAlias("b1", "三体1", "zh", "manual");
    const aliases = svc.listBookAliases("b1");
    expect(aliases).toHaveLength(1);
    expect(aliases[0].alias).toBe("三体1");
    expect(aliases[0].source).toBe("manual");
  });

  it("removeBookAlias deletes the alias", () => {
    svc.addBookAlias("b1", "三体1", "zh", "manual");
    const aliases = svc.listBookAliases("b1");
    svc.removeBookAlias(aliases[0].id);
    expect(svc.listBookAliases("b1")).toHaveLength(0);
  });

  it("addBookAlias with source='agent' is accepted (book_aliases CHECK allows agent)", () => {
    svc.addBookAlias("b1", "3 Body", "en", "agent");
    expect(svc.listBookAliases("b1")[0].source).toBe("agent");
  });

  // --- Book Relations ---

  it("addBookRelation and listRelations round-trip", () => {
    svc.addBookRelation("b1", "b2", "same_work_different_edition", 1, "automatic");
    const rels = svc.listBookRelations("b1");
    expect(rels).toHaveLength(1);
    expect(rels[0].kind).toBe("same_work_different_edition");
    expect(rels[0].confidence).toBe(1);
  });

  it("addBookRelation with source='agent' is accepted", () => {
    svc.addBookRelation("b1", "b3", "related", 0.8, "agent");
    expect(svc.listBookRelations("b1")[0].source).toBe("agent");
  });

  it("removeBookRelation deletes a relation", () => {
    svc.addBookRelation("b1", "b2", "same_work_different_edition", 1, "automatic");
    svc.removeBookRelation("b1", "b2", "same_work_different_edition");
    expect(svc.listBookRelations("b1")).toHaveLength(0);
  });

  // --- Edge cases ---

  it("getSeries returns null for unknown id", () => {
    expect(svc.getSeries("no-such-id")).toBeNull();
  });

  it("renameSeries throws for unknown id", () => {
    expect(() => svc.renameSeries("no-such-id", "X")).toThrow();
  });

  it("deleteSeries throws for unknown id", () => {
    expect(() => svc.deleteSeries("no-such-id")).toThrow();
  });
});
