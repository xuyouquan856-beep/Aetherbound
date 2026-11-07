import { describe, expect, it } from "vitest";
import { findSeriesSuggestions, suggestCollectionAdditions } from "../../src/renderer/src/features/library/series-suggestions.js";
import type { BookSummary, CollectionSummary } from "../../src/shared/contracts.js";

function book(id: string, title: string): BookSummary {
  return {
    id, title, author: null, format: "epub", availabilityStatus: "available",
    progress: 0, addedAt: "2026-01-01T00:00:00.000Z", lastReadAt: null,
    updatedAt: "2026-01-01T00:00:00.000Z", coverUrl: null,
  };
}

function collection(id: string, name: string, previewBooks: BookSummary[] = []): CollectionSummary {
  return { id, name, bookCount: previewBooks.length, previewBooks, updatedAt: "2026-01-01T00:00:00.000Z" };
}

describe("library series suggestions", () => {
  it("groups numbered Chinese and Japanese volumes while preserving editable book identities", () => {
    const books = [
      book("a", "【電子版限定特典付き】追放されるたびにスキルを手に入れた俺が 1"),
      book("b", "【電子版限定特典付き】追放されるたびにスキルを手に入れた俺が 2"),
      book("c", "你和我的故事 第一卷"),
      book("d", "你和我的故事 第二卷"),
      book("e", "完全无关的单本书"),
    ];
    const suggestions = findSeriesSuggestions(books, []);
    expect(suggestions.map((item) => item.bookIds)).toContainEqual(["a", "b"]);
    expect(suggestions.map((item) => item.bookIds)).toContainEqual(["c", "d"]);
    expect(suggestions.find((item) => item.bookIds.includes("a"))?.name)
      .toBe("追放されるたびにスキルを手に入れた俺が");
  });

  it("suggests one loose volume for an existing collection without automatically filing it", () => {
    const loose = book("loose", "あなたの未来を許さない 下");
    const existing = collection("old", "あなたの未来を許さない", [book("old-book", "あなたの未来を許さない 上")]);
    expect(findSeriesSuggestions([loose], [existing])[0]).toMatchObject({
      bookIds: ["loose"], targetCollectionId: "old",
    });
    expect(suggestCollectionAdditions(existing, [existing.previewBooks[0]!, loose])).toEqual(["loose"]);
  });

  it("recognizes a renamed collection from its member titles", () => {
    const old = collection("old", "我的旧译名", [book("in-old", "星河物语 第1卷")]);
    expect(findSeriesSuggestions([book("loose", "星河物语 第2卷")], [old])[0])
      .toMatchObject({ targetCollectionId: "old", bookIds: ["loose"] });
  });

  it("accepts short Chinese series names with explicit volume markers", () => {
    const old = collection("old", "夜航", [book("one", "夜航 第1卷")]);
    expect(suggestCollectionAdditions(old, [old.previewBooks[0]!, book("three", "夜航 第3卷")]))
      .toEqual(["three"]);
  });

  it("does not treat a number inside a standalone title as a series", () => {
    expect(findSeriesSuggestions([
      book("one", "86—不存在的战区—"),
      book("two", "2024年的故事"),
    ], [])).toEqual([]);
  });
});
