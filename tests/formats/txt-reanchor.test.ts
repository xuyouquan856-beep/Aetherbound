import { describe, expect, it } from "vitest";
import { createTxtLocator, reanchorTxtLocation } from "../../src/formats/txt/locator.js";

const oldChapter = { id: "old-2", title: "第二章", index: 1, startOffset: 20, endOffset: 40 };
const newChapters = [
  { chapter: { id: "new-1", title: "第一章", index: 0, startOffset: 0, endOffset: 18 }, text: "第一章\n完全不同的内容。" },
  { chapter: { id: "new-2", title: "第二章", index: 1, startOffset: 18, endOffset: 50 }, text: "第二章\n新增开场。她推开门，看见晨光。" },
];

describe("TXT source revision reanchoring", () => {
  it("moves an old quote to the matching chapter in a new revision", () => {
    const old = createTxtLocator({ sourceRevision: "old-revision", chapter: oldChapter, chapterText: "第二章\n她推开门，看见晨光。", characterOffset: 4, totalProgression: 0.6 });
    const next = reanchorTxtLocation(newChapters, old, "new-revision");

    expect(next.sourceRevision).toBe("new-revision");
    expect(next.primary.chapterId).toBe("new-2");
    expect(next.text.exact).toContain("她推开门");
  });

  it("uses total progression when the quote no longer exists", () => {
    const old = createTxtLocator({ sourceRevision: "old-revision", chapter: oldChapter, chapterText: "已经删除的句子", characterOffset: 2, totalProgression: 0.75 });
    const next = reanchorTxtLocation(newChapters, old, "new-revision");
    expect(next.primary.chapterId).toBe("new-2");
    expect(next.progression.total).toBeGreaterThan(0.5);
  });
});
