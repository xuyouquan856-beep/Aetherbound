import { beforeAll, describe, expect, it } from "vitest";

// Import will fail until module is created — this is the red test
describe("EditionAndLanguageResolver", () => {
  let resolve: typeof import("../../src/backend/library-scan/edition-language-resolver.js").resolveEditionAndLanguage;

  beforeAll(async () => {
    const mod = await import("../../src/backend/library-scan/edition-language-resolver.js");
    resolve = mod.resolveEditionAndLanguage;
  });

  it("classifies pure Chinese title as translated_zh", () => {
    const result = resolve({ title: "三体", author: "刘慈欣", metadataSource: "txt-head" });
    expect(result.language).toBe("translated_zh");
    expect(result.evidence).toContain("kana_ratio_below_threshold");
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it("classifies pure Japanese title as original_ja", () => {
    const result = resolve({ title: "わたしのすきなものがたり", author: "なかむら", metadataSource: "epub-opf" });
    expect(result.language).toBe("original_ja");
    expect(result.evidence).toContain("kana_ratio_high");
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it("classifies mixed CJK+kana (kana ratio ~0.30) as bilingual_ja_zh", () => {
    // "転生したら" (4 kana) + "最強の魔法" (3 kana) + "使い" (2 kana) + 中文 = moderate kana
    const result = resolve({ title: "転生したら最強の魔法使いになった件", metadataSource: "txt-head" });
    expect(result.language).toBe("bilingual_ja_zh");
    expect(result.evidence).toContain("kana_ratio_moderate");
  });

  it("does not flag low kana ratio (≤0.15) as bilingual — stays Chinese-dominant", () => {
    const result = resolve({ title: "無職転生", author: "理不尽孫手", metadataSource: "txt-head" });
    expect(result.language).not.toBe("bilingual_ja_zh");
  });

  it("detects WEB edition label in title", () => {
    const result = resolve({ title: "無職転生 WEB版", metadataSource: "txt-head" });
    expect(result.edition).toBe("web");
    expect(result.evidence).toContain("web_label_in_title");
  });

  it("detects bunko edition label in title", () => {
    const result = resolve({ title: "無職転生 文庫本", metadataSource: "txt-head" });
    expect(result.edition).toBe("bunko");
    expect(result.evidence).toContain("bunko_label_in_title");
  });

  it("prioritizes EPUB dc:language 'ja' over kana ratio for language detection", () => {
    // Title is Chinese-looking but dc:language says ja
    const result = resolve({
      title: "異世界",
      dcLanguage: "ja",
      metadataSource: "epub-opf",
    });
    expect(result.language).toBe("original_ja");
    expect(result.evidence).toContain("dc_language_ja");
  });

  it("provides complete evidence chain for every determination", () => {
    const result = resolve({ title: "蜘蛛ですが、なにか？", metadataSource: "txt-head" });
    expect(result.evidence.length).toBeGreaterThan(0);
    // Every piece of evidence should be a non-empty string
    for (const e of result.evidence) {
      expect(typeof e).toBe("string");
      expect(e.length).toBeGreaterThan(0);
    }
  });

  it("returns unknown with confidence=0 and empty evidence when nothing is clear", () => {
    const result = resolve({ title: "Test", metadataSource: "txt-head" });
    expect(result.edition).toBe("unknown");
    expect(result.language).toBe("unknown");
    expect(result.confidence).toBe(0);
    expect(result.evidence).toEqual([]);
  });
});
