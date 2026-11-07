import { describe, expect, it } from "vitest";
import { createTxtLocator, restoreTxtLocator } from "../../src/formats/txt/locator.js";

describe("TXT ReadingLocation v1", () => {
  const chapter = { id: "c1", title: "第一章", index: 0, startOffset: 0, endOffset: 30 };

  it("restores an exact code-point offset after validation", () => {
    const text = "前文🙂精确锚点文本，后文继续。";
    const offset = [..."前文🙂"].length;
    const locator = createTxtLocator({ sourceRevision: "r1", chapter, chapterText: text, characterOffset: offset, totalProgression: 0.2 });
    expect(restoreTxtLocator(text, locator)).toMatchObject({ status: "exact", characterOffset: offset });
  });

  it("reanchors by text quote after text is inserted", () => {
    const original = "前文｜精确锚点文本：后文";
    const locator = createTxtLocator({ sourceRevision: "r1", chapter, chapterText: original, characterOffset: 3, totalProgression: 0.2 });
    const restored = restoreTxtLocator("新增。前文｜精确锚点文本：后文", locator);
    expect(restored.status).toBe("quote");
    expect(restored.characterOffset).toBe(6);
  });

  it("falls back to progression when the quote disappeared", () => {
    const locator = createTxtLocator({ sourceRevision: "r1", chapter, chapterText: "旧文本", characterOffset: 2, totalProgression: 0.5 });
    expect(restoreTxtLocator("完全不同的新文本", locator)).toMatchObject({ status: "progression", characterOffset: 5 });
  });
});
