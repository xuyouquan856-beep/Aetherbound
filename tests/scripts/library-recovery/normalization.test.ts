import { describe, expect, it } from "vitest";
import {
  normalizePublicationTitle,
  parseTitleFacts,
} from "../../../scripts/library-recovery/normalization.js";

describe("library recovery title normalization", () => {
  it.each([
    ["作品名 第3卷", "作品名", 3, null],
    ["作品名 第三卷", "作品名", 3, null],
    ["作品名 Vol.03", "作品名", 3, null],
    ["作品名称 03", "作品名称", 3, null],
    ["作品名 上卷", "作品名", null, "upper"],
    ["作品名 外传", "作品名", null, "side-story"],
    ["作品名 WEB版", "作品名", null, "web"],
    ["86—不存在的战区—", "86—不存在的战区—", null, null],
    ["Re:从零开始的异世界生活 01", "Re:从零开始的异世界生活", 1, null],
  ])("parses %s deterministically", (title, base, volume, edition) => {
    const result = parseTitleFacts({ metadataTitle: title, fileName: `${title}.epub` });
    expect(result.normalizedBaseTitle).toBe(base);
    expect(result.volumeIndex).toBe(volume);
    if (edition) expect(result.editionLabels).toContain(edition);
  });

  it("normalizes NFKC digits and explicit download prefixes", () => {
    expect(normalizePublicationTitle("zh.Ysgyb. 作品名 Ｖｏｌ．０３")).toBe("作品名 Vol.03");
    expect(normalizePublicationTitle("[作者] 作品名 01")).toBe("作品名 01");
  });

  it("does not remove bracketed text from the middle", () => {
    expect(normalizePublicationTitle("作品[特装版]名称")).toBe("作品[特装版]名称");
  });

  it.each(["勇者", "转生", "魔女"])("does not treat common word %s as a usable series base", (title) => {
    const result = parseTitleFacts({ metadataTitle: title, fileName: `${title}.epub` });
    expect(result.normalizedBaseTitle).toBe(title);
    expect(result.volumeIndex).toBeNull();
    expect(result.tentativeTrailingNumber).toBe(false);
  });

  it("marks bare trailing numbers as tentative for group-level confirmation", () => {
    expect(parseTitleFacts({
      metadataTitle: "长篇作品名称 12",
      fileName: "长篇作品名称 12.epub",
    })).toMatchObject({
      normalizedBaseTitle: "长篇作品名称",
      volumeIndex: 12,
      tentativeTrailingNumber: true,
    });
  });
});
