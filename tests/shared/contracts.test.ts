import { describe, expect, it } from "vitest";
import {
  BookSummarySchema,
  CollectionBookIdsRequestSchema,
  CollectionCreateRequestSchema,
  CollectionMembershipSchema,
  CollectionSummarySchema,
  DefaultReaderShortcutProfile,
  FolderCollectionImportProgressSchema,
  FolderCollectionImportResultSchema,
  LibraryImportBatchResultSchema,
  ReaderShortcutProfileSchema,
  ReadingAppearanceSchema,
  TxtReadingLocationSchema,
} from "../../src/shared/contracts.js";

describe("renderer contracts", () => {
  const book = {
    id: "b1",
    title: "Book",
    author: null,
    format: "txt" as const,
    availabilityStatus: "available" as const,
    progress: 0,
    addedAt: "2026-07-29T00:00:00.000Z",
    lastReadAt: null,
    updatedAt: "2026-07-29T00:00:00.000Z",
    coverUrl: null,
  };

  it("accepts path-free collection DTOs and rejects path-like inputs", () => {
    expect(CollectionSummarySchema.parse({
      id: "collection-1",
      name: "待读",
      bookCount: 1,
      previewBooks: [book],
      updatedAt: "2026-07-29T00:00:00.000Z",
    }).bookCount).toBe(1);
    expect(() => CollectionCreateRequestSchema.parse({
      name: "待读",
      path: "E:\\private",
    })).toThrow();
    expect(() => CollectionBookIdsRequestSchema.parse({
      id: "collection-1",
      bookIds: ["b1", "b1"],
    })).toThrow();
    expect(() => FolderCollectionImportResultSchema.parse({
      status: "empty",
      folderName: "E:\\private\\books",
    })).toThrow();
  });

  it("bounds folder progress and collection membership intersections", () => {
    expect(FolderCollectionImportProgressSchema.parse({
      processed: 2,
      total: 10,
      fileName: "第2卷.epub",
    })).toEqual({ processed: 2, total: 10, fileName: "第2卷.epub" });
    expect(() => FolderCollectionImportProgressSchema.parse({
      processed: 11,
      total: 10,
      fileName: null,
    })).toThrow();
    expect(CollectionMembershipSchema.parse({
      collectionId: "collection-1",
      bookIds: ["b1"],
    }).bookIds).toEqual(["b1"]);
  });

  it("accepts an all-failed folder import without fabricating a collection", () => {
    expect(FolderCollectionImportResultSchema.parse({
      status: "failed",
      folderName: "损坏书籍",
      ignoredEntries: 0,
      items: [{
        status: "failed",
        fileName: "broken.epub",
        errorCode: "INVALID_PACKAGE",
        message: "文件损坏",
      }],
    }).status).toBe("failed");
  });

  it("rejects source paths and unknown fields in book summaries", () => {
    expect(() => BookSummarySchema.parse({
      id: "b1",
      title: "Book",
      author: null,
      format: "txt",
      availabilityStatus: "available",
      progress: 0,
      absolutePath: "E:\\secret.txt",
    })).toThrow();
  });

  it("requires exact and fallback fields for TXT locations", () => {
    const location = TxtReadingLocationSchema.parse({
      locatorVersion: 1,
      sourceRevision: "rev-1",
      format: "txt",
      primary: { kind: "txt", chapterId: "chapter-1", characterOffset: 12 },
      progression: { resource: 0.2, total: 0.1 },
      text: { exact: "锚点", prefix: "前文", suffix: "后文" },
    });
    expect(location.text.exact).toBe("锚点");
    expect(() => TxtReadingLocationSchema.parse({ ...location, text: { exact: "锚点" } })).toThrow();
  });

  it("never exposes an absolute source path in batch import results", () => {
    expect(() => LibraryImportBatchResultSchema.parse({
      status: "completed",
      items: [{
        status: "unsupported",
        fileName: "E:\\private\\book.epub",
        errorCode: "FORMAT_NOT_SUPPORTED",
      }],
    })).toThrow();
  });

  it("defaults legacy appearance payloads to full reading brightness", () => {
    expect(ReadingAppearanceSchema.parse({
      theme: "paper",
      fontFamily: "serif",
      fontSize: 20,
      lineHeight: 1.85,
      measure: 720,
    })).toMatchObject({
      brightness: 100,
      epubFlow: "paginated",
      epubColumns: "double",
      paragraphSpacing: 0,
      firstLineIndent: "two-em",
      letterSpacing: 0,
    });
  });

  it("rejects invalid light-novel layout preferences", () => {
    const valid = {
      theme: "paper",
      fontFamily: "serif",
      fontSize: 20,
      lineHeight: 1.85,
      measure: 720,
      brightness: 100,
      epubFlow: "paginated",
      epubColumns: "double",
      paragraphSpacing: 0.5,
      firstLineIndent: "two-em",
      letterSpacing: 0.05,
    };

    expect(() => ReadingAppearanceSchema.parse({ ...valid, epubFlow: "continuous" })).toThrow();
    expect(() => ReadingAppearanceSchema.parse({ ...valid, epubColumns: "triple" })).toThrow();
    expect(() => ReadingAppearanceSchema.parse({ ...valid, paragraphSpacing: 1.6 })).toThrow();
    expect(() => ReadingAppearanceSchema.parse({ ...valid, letterSpacing: -0.01 })).toThrow();
  });

  it("requires a unique versioned reader shortcut profile", () => {
    expect(ReaderShortcutProfileSchema.parse(DefaultReaderShortcutProfile))
      .toEqual(DefaultReaderShortcutProfile);
    expect(() => ReaderShortcutProfileSchema.parse({
      ...DefaultReaderShortcutProfile,
      bindings: {
        ...DefaultReaderShortcutProfile.bindings,
        "reader.page.previous": [{
          code: "KeyD",
          ctrl: false,
          alt: false,
          shift: false,
          meta: false,
        }],
      },
    })).toThrow();
  });

  it("rejects reserved reader keys", () => {
    expect(() => ReaderShortcutProfileSchema.parse({
      ...DefaultReaderShortcutProfile,
      bindings: {
        ...DefaultReaderShortcutProfile.bindings,
        "reader.panel.toc.toggle": [{
          code: "F11",
          ctrl: false,
          alt: false,
          shift: false,
          meta: false,
        }],
      },
    })).toThrow();
  });
});
