import { describe, expect, it, vi } from "vitest";
import { searchTxtBook } from "../../src/renderer/src/features/reader/reader-book-search.js";

const chapters = [0, 1].map(index => ({ id: `c${index}`, index, title: `章${index}`, startOffset: 0, endOffset: 100 }));
describe("TXT whole-book search", () => {
  it("searches later chapters and produces Unicode character locations", async () => {
    const getChapter = vi.fn(async (_bookId: string, id: string) => ({ bookId: "b", sourceRevision: "r", chapter: chapters[id === "c0" ? 0 : 1], text: id === "c0" ? "没有结果" : "😀开头 星空 与 星空", totalCharacters: 20 }));
    const results = await searchTxtBook("b", chapters, getChapter, "星空");
    expect(results).toHaveLength(2);
    expect(results[0].location.primary).toMatchObject({ chapterId: "c1", characterOffset: 4 });
    expect(results[0].endLocation?.primary).toMatchObject({ characterOffset: 6 });
  });
  it("stops reading when cancelled and caps results", async () => {
    const getChapter = vi.fn(async () => ({ bookId: "b", sourceRevision: "r", chapter: chapters[0], text: "星".repeat(600), totalCharacters: 600 }));
    expect(await searchTxtBook("b", chapters, getChapter, "星", () => false)).toEqual([]);
    expect(getChapter).not.toHaveBeenCalled();
    expect(await searchTxtBook("b", chapters, getChapter, "星")).toHaveLength(200);
    expect(getChapter).toHaveBeenCalledTimes(1);
  });
});
