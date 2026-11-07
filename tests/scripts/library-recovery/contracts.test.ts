import { describe, expect, it } from "vitest";
import {
  ManifestEntrySchema,
  PreviewActionSchema,
  PreviewBundleSchema,
} from "../../../scripts/library-recovery/contracts.js";

const manifestEntry = {
  inventoryVersion: 1 as const,
  relativePath: "Series/book.epub",
  extension: ".epub" as const,
  fileSize: 10,
  modifiedAt: "2026-07-30T00:00:00.000Z",
  sha256: "a".repeat(64),
  parentFolder: "Series",
};

const previewAction = {
  actionId: "move:book",
  kind: "move" as const,
  status: "confirmed" as const,
  sourceRelativePath: "book.epub",
  proposedRelativePath: "Series/book.epub",
  seriesCanonicalName: "Series",
  editionLabels: [],
  volumeLabel: null,
  title: "Series 01",
  creator: null,
  evidenceCodes: ["OPF_SERIES_EXACT"] as const,
  evidenceSummary: "OPF series metadata exactly matches.",
  fileSize: 10,
  modifiedAt: "2026-07-30T00:00:00.000Z",
  sha256: "a".repeat(64),
};

describe("library recovery contracts", () => {
  it("accepts a strict manifest entry", () => {
    expect(ManifestEntrySchema.parse(manifestEntry)).toEqual(manifestEntry);
  });

  it.each([
    "../escape.epub",
    "/absolute.epub",
    "E:/absolute.epub",
    "Series\\book.epub",
    "Series/../book.epub",
    "Series//book.epub",
  ])("rejects unsafe relative path %s", (relativePath) => {
    expect(() => ManifestEntrySchema.parse({ ...manifestEntry, relativePath }))
      .toThrow();
  });

  it("rejects malformed hashes and unknown keys", () => {
    expect(() => ManifestEntrySchema.parse({ ...manifestEntry, sha256: "abc" }))
      .toThrow();
    expect(() => ManifestEntrySchema.parse({ ...manifestEntry, absolutePath: "E:/epub/book.epub" }))
      .toThrow();
  });

  it("rejects executable actions below confirmed confidence", () => {
    expect(() => PreviewActionSchema.parse({
      ...previewAction,
      status: "probable",
      evidenceCodes: ["AUTHOR_MATCH"],
    })).toThrow();
  });

  it("rejects duplicate sources and destinations in a preview", () => {
    const duplicateDestination = {
      ...previewAction,
      actionId: "move:other",
      sourceRelativePath: "other.epub",
    };
    expect(() => PreviewBundleSchema.parse({
      previewVersion: 1,
      baselineDigest: "b".repeat(64),
      createdAt: "2026-07-30T00:00:00.000Z",
      actions: [previewAction, duplicateDestination],
    })).toThrow(/destination/i);

    expect(() => PreviewBundleSchema.parse({
      previewVersion: 1,
      baselineDigest: "b".repeat(64),
      createdAt: "2026-07-30T00:00:00.000Z",
      actions: [previewAction, { ...previewAction, actionId: "move:duplicate" }],
    })).toThrow(/source/i);
  });

  it("rejects no-op and deeper-than-series moves", () => {
    expect(() => PreviewActionSchema.parse({
      ...previewAction,
      proposedRelativePath: previewAction.sourceRelativePath,
    })).toThrow();
    expect(() => PreviewActionSchema.parse({
      ...previewAction,
      proposedRelativePath: "Series/Sub/book.epub",
    })).toThrow();
  });
});
