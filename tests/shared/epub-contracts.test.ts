import { describe, expect, it } from "vitest";
import {
  BookDetailsSchema,
  BookSummarySchema,
  COVER_RESOURCE_FILE_NAMES,
  EpubReadingLocationSchema,
  PublicationViewSchema,
  ReadingLocationSchema,
} from "../../src/shared/contracts.js";

const location = {
  locatorVersion: 1,
  sourceRevision: "revision-1",
  format: "epub",
  primary: {
    kind: "epub",
    spineIndex: 1,
    spineHref: "EPUB/chapter-2.xhtml",
    engineLocator: { kind: "epub-cfi", value: "epubcfi(/6/4!/4/2/1:0)" },
  },
  progression: { resource: 0.25, total: 0.6 },
  text: { exact: "目标文本", prefix: "前文", suffix: "后文" },
} as const;

const publication = {
  bookId: "book-1",
  sourceRevision: "revision-1",
  metadata: { title: "EPUB Book", author: "Author", language: "zh-CN" },
  toc: [{ id: "toc-1", label: "第一章", href: "EPUB/chapter-1.xhtml", children: [] }],
  spine: [{ index: 0, href: "EPUB/chapter-1.xhtml", linear: true }],
} as const;

describe("EPUB renderer contracts", () => {
  it("accepts a complete EPUB locator and the cross-format union", () => {
    expect(EpubReadingLocationSchema.parse(location)).toEqual(location);
    expect(ReadingLocationSchema.parse(location)).toEqual(location);
  });

  it("rejects page numbers and incomplete text-quote fallbacks", () => {
    expect(() => EpubReadingLocationSchema.parse({ ...location, pageNumber: 8 })).toThrow();
    expect(() => EpubReadingLocationSchema.parse({ ...location, text: { exact: "目标文本" } })).toThrow();
  });

  it("keeps paths, blob URLs and upstream objects out of PublicationView", () => {
    expect(PublicationViewSchema.parse(publication)).toEqual(publication);
    for (const forbidden of [
      { absolutePath: "E:\\private\\book.epub" },
      { blobUrl: "blob:reader-rendition://epub/secret" },
      { book: { sections: [] } },
    ]) expect(() => PublicationViewSchema.parse({ ...publication, ...forbidden })).toThrow();
  });

  it("discriminates TXT and EPUB books without pretending EPUB has TXT chapters", () => {
    const book = BookSummarySchema.parse({
      id: "book-1", title: "EPUB Book", author: "Author", format: "epub",
      availabilityStatus: "available", progress: 0.6,
      addedAt: "2026-07-29T00:00:00.000Z",
      lastReadAt: "2026-07-29T01:00:00.000Z",
      updatedAt: "2026-07-29T01:00:00.000Z",
      coverUrl: "reader-resource://publication/book-1/revision-1/cover",
    });
    const details = BookDetailsSchema.parse({
      book,
      sourceRevision: "revision-1",
      publication,
      savedLocation: location,
      sessionId: "session-1",
    });
    expect(details.book.format).toBe("epub");
    expect("chapters" in details).toBe(false);
  });

  it("accepts only a controlled publication cover URL", () => {
    const base = {
      id: "book-1", title: "EPUB Book", author: "Author", format: "epub",
      availabilityStatus: "available", progress: 0,
      addedAt: "2026-07-29T00:00:00.000Z",
      lastReadAt: null,
      updatedAt: "2026-07-29T00:00:00.000Z",
    };
    expect(BookSummarySchema.parse({ ...base, coverUrl: "reader-resource://publication/book-1/revision-1/cover" }).coverUrl)
      .toBe("reader-resource://publication/book-1/revision-1/cover");
    // The UI prefers the downscaled thumbnail, so this URL must also be accepted.
    // Regression guard: presentBook emits /cover-thumb, and rejecting it failed the
    // whole library:list response, which surfaced as a blank window.
    expect(BookSummarySchema.parse({ ...base, coverUrl: `reader-resource://publication/book-1/revision-1/${COVER_RESOURCE_FILE_NAMES[1]}` }).coverUrl)
      .toBe(`reader-resource://publication/book-1/revision-1/${COVER_RESOURCE_FILE_NAMES[1]}`);
    for (const coverUrl of [
      "file:///E:/private/cover.jpg",
      "https://example.com/cover.jpg",
      "blob:secret",
      // Only the two known resource names are allowed.
      "reader-resource://publication/book-1/revision-1/publication.json",
      "reader-resource://publication/book-1/revision-1/book.epub",
      `reader-resource://publication/book-1/revision-1/${COVER_RESOURCE_FILE_NAMES[1]}.png`,
    ]) {
      expect(() => BookSummarySchema.parse({ ...base, coverUrl })).toThrow();
    }
  });
});
