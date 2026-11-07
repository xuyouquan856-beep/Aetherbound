import { describe, expect, it } from "vitest";
import type { AliasRecord, EpubMetadata, ManifestEntry } from "../../../scripts/library-recovery/contracts.js";
import type { MetadataResult } from "../../../scripts/library-recovery/epub-metadata.js";
import { classifyLibrary } from "../../../scripts/library-recovery/classifier.js";

function book(relativePath: string, title: string, series: string | null, creator = "作者", position: number | null = null) {
  const manifest: ManifestEntry = {
    inventoryVersion: 1,
    relativePath,
    extension: ".epub",
    fileSize: 10,
    modifiedAt: "2026-07-30T00:00:00.000Z",
    sha256: relativePath.padEnd(64, "a").slice(0, 64).replace(/[^a-f0-9]/g, "a"),
    parentFolder: relativePath.includes("/") ? relativePath.split("/")[0] : "",
  };
  const metadata: EpubMetadata = {
    metadataVersion: 1,
    relativePath,
    title,
    creator,
    language: "zh",
    identifier: null,
    publisher: null,
    publishedAt: null,
    series,
    groupPosition: position,
    source: "epub-opf",
  };
  return { manifest, metadata: { relativePath, ok: true, metadata } as MetadataResult };
}

function classify(items: ReturnType<typeof book>[], aliases: AliasRecord[] = []) {
  return classifyLibrary({
    manifest: items.map((item) => item.manifest),
    metadata: items.map((item) => item.metadata),
    aliases,
  });
}

describe("evidence-based series classifier", () => {
  it("confirms three OPF series members and discovers a new series", () => {
    const result = classify([1, 2, 3].map((volume) =>
      book(`作品 ${volume}.epub`, `作品 ${volume}`, "作品", "作者", volume)));
    expect(result.records.every((record) => record.status === "confirmed")).toBe(true);
    expect(result.candidateSeries).toEqual([
      expect.objectContaining({ canonicalSeriesName: "作品", memberCount: 3 }),
    ]);
  });

  it("keeps WEB, print and side-story labels in one canonical series", () => {
    const result = classify([
      book("作品 WEB版.epub", "作品 WEB版", "作品"),
      book("作品 文库版.epub", "作品 文库版", "作品"),
      book("作品 外传.epub", "作品 外传", "作品"),
    ]);
    expect(new Set(result.records.map((record) => record.canonicalSeriesName))).toEqual(new Set(["作品"]));
  });

  it("merges Japanese and Chinese names only through a reviewed alias", () => {
    const items = [
      book("日文 01.epub", "日文作品 01", "日文作品", "作者", 1),
      book("中文 02.epub", "中文作品 02", "中文作品", "作者", 2),
      book("中文 03.epub", "中文作品 03", "中文作品", "作者", 3),
    ];
    expect(classify(items).candidateSeries).toHaveLength(0);
    const alias: AliasRecord = {
      aliasVersion: 1,
      canonicalSeriesName: "中文作品",
      aliases: ["中文作品", "日文作品"],
      evidence: [{ kind: "publisher-page", source: "https://example.test/series", verifiedAt: "2026-07-30T00:00:00.000Z" }],
      reviewed: true,
    };
    expect(classify(items, [alias]).candidateSeries).toEqual([
      expect.objectContaining({ canonicalSeriesName: "中文作品", memberCount: 3 }),
    ]);
  });

  it("does not promote author-only or common-word similarity", () => {
    const authorOnly = classify([
      book("甲.epub", "完全不同甲", null, "同一作者"),
      book("乙.epub", "完全不同乙", null, "同一作者"),
    ]);
    expect(authorOnly.records.every((record) => record.status === "probable")).toBe(true);
    const common = classify([
      book("勇者甲.epub", "勇者甲", null, "甲"),
      book("勇者乙.epub", "勇者乙", null, "乙"),
    ]);
    expect(common.records.every((record) => record.status === "unclassified")).toBe(true);
  });

  it("marks a strong series conflict with its current folder as misplaced", () => {
    const result = classify([
      book("错误系列/正确作品 01.epub", "正确作品 01", "正确作品", "作者", 1),
      book("正确作品 02.epub", "正确作品 02", "正确作品", "作者", 2),
      book("正确作品 03.epub", "正确作品 03", "正确作品", "作者", 3),
    ]);
    expect(result.records[0]).toMatchObject({ status: "misplaced", canonicalSeriesName: "正确作品" });
    expect(result.folderAudits[0].misplaced).toContain("错误系列/正确作品 01.epub");
  });

  it("requires three confirmed books for a new folder", () => {
    expect(classify([
      book("作品 01.epub", "作品 01", "作品", "作者", 1),
      book("作品 02.epub", "作品 02", "作品", "作者", 2),
    ]).candidateSeries).toHaveLength(0);
  });

  it("marks competing strong metadata and title-family signals ambiguous", () => {
    const result = classify([
      book("冲突作品 01.epub", "冲突作品 01", "另一个系列", "作者", 1),
      book("冲突作品 02.epub", "冲突作品 02", null, "作者", 2),
      book("冲突作品 03.epub", "冲突作品 03", null, "作者", 3),
    ]);
    expect(result.records[0].status).toBe("ambiguous");
    expect(result.records[0].conflictingSeries).toEqual(expect.arrayContaining(["冲突作品", "另一个系列"]));
  });

  it("does not treat existing folder membership as confirmation", () => {
    const result = classify([
      book("旧文件夹/无系列信息.epub", "无系列信息", null),
    ]);
    expect(result.records[0].status).not.toBe("confirmed");
    expect(result.records[0].evidenceCodes).toContain("EXISTING_FOLDER_ONLY");
  });
});
