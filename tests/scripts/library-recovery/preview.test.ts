import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ManifestEntry } from "../../../scripts/library-recovery/contracts.js";
import type { MetadataResult } from "../../../scripts/library-recovery/epub-metadata.js";
import type { ClassificationOutput } from "../../../scripts/library-recovery/classifier.js";
import { writePreviewBundle } from "../../../scripts/library-recovery/preview.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const manifest: ManifestEntry[] = [
  { inventoryVersion: 1, relativePath: "作品 01.epub", extension: ".epub", fileSize: 1, modifiedAt: "2026-07-30T00:00:00.000Z", sha256: "a".repeat(64), parentFolder: "" },
  { inventoryVersion: 1, relativePath: "旧夹/错放.epub", extension: ".epub", fileSize: 2, modifiedAt: "2026-07-30T00:00:00.000Z", sha256: "b".repeat(64), parentFolder: "旧夹" },
  { inventoryVersion: 1, relativePath: "不确定.epub", extension: ".epub", fileSize: 3, modifiedAt: "2026-07-30T00:00:00.000Z", sha256: "c".repeat(64), parentFolder: "" },
];
const metadata: MetadataResult[] = manifest.map((entry) => ({
  relativePath: entry.relativePath,
  ok: true,
  metadata: {
    metadataVersion: 1,
    relativePath: entry.relativePath,
    title: entry.relativePath.split("/").at(-1)!.replace(".epub", ""),
    creator: "作者",
    language: "zh",
    identifier: null,
    publisher: null,
    publishedAt: null,
    series: null,
    groupPosition: null,
    source: "epub-opf",
  },
}));
const classification: ClassificationOutput = {
  records: [
    { relativePath: "作品 01.epub", status: "confirmed", canonicalSeriesName: "作品", evidenceCodes: ["OPF_SERIES_EXACT"], evidenceSummary: "exact", conflictingSeries: [] },
    { relativePath: "旧夹/错放.epub", status: "misplaced", canonicalSeriesName: "作品", evidenceCodes: ["OPF_SERIES_EXACT"], evidenceSummary: "exact", conflictingSeries: [] },
    { relativePath: "不确定.epub", status: "ambiguous", canonicalSeriesName: null, evidenceCodes: ["AUTHOR_MATCH"], evidenceSummary: "ambiguous", conflictingSeries: ["甲", "乙"] },
  ],
  folderAudits: [{ folderName: "旧夹", bookCount: 1, dominantCanonicalSeries: null, confirmedInPlace: [], confirmedMissingMembers: [], misplaced: ["旧夹/错放.epub"], probable: [], ambiguous: [], extractionErrors: [] }],
  candidateSeries: [{ canonicalSeriesName: "作品", memberCount: 3, memberPaths: ["作品 01.epub", "旧夹/错放.epub", "作品 02.epub"] }],
};

describe("read-only recovery preview", () => {
  it("emits only confirmed moves and a separate needs-review report", async () => {
    const audit = await mkdtemp(join(tmpdir(), "recovery-preview-"));
    roots.push(audit);
    const result = await writePreviewBundle({
      auditDirectory: audit,
      baselineDigest: "d".repeat(64),
      classification,
      manifest,
      metadata,
    });
    const preview = JSON.parse(await readFile(result.previewPath, "utf8"));
    expect(preview.actions).toHaveLength(2);
    expect(preview.actions.map((action: { proposedRelativePath: string }) => action.proposedRelativePath))
      .toEqual(["作品/错放.epub", "作品/作品 01.epub"]);
    expect(await readFile(join(audit, "needs-review.csv"), "utf8")).toContain("不确定.epub");
    expect(await readFile(result.summaryPath, "utf8"))
      .toContain("deletes 0 files, overwrites 0 files, renames 0 files");
  });

  it("is deterministic for identical input", async () => {
    const first = await mkdtemp(join(tmpdir(), "recovery-preview-a-"));
    const second = await mkdtemp(join(tmpdir(), "recovery-preview-b-"));
    roots.push(first, second);
    const left = await writePreviewBundle({ auditDirectory: first, baselineDigest: "d".repeat(64), classification, manifest, metadata, createdAt: "2026-07-30T00:00:00.000Z" });
    const right = await writePreviewBundle({ auditDirectory: second, baselineDigest: "d".repeat(64), classification, manifest, metadata, createdAt: "2026-07-30T00:00:00.000Z" });
    expect(left.previewDigest).toBe(right.previewDigest);
  });
});
