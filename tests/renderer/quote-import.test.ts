import { describe, expect, it } from "vitest";
import { parseQuoteImport } from "../../src/renderer/src/features/quotes/quote-transfer.js";

describe("quote import", () => {
  it("accepts preview exports and skips duplicate text", () => {
    const result = parseQuoteImport(JSON.stringify({ version: 1, items: [
      { text: "  A line  ", author: "A", work: "Book", excerpt: "Short", url: "https://example.org/source", enabled: true, extra: "ignored" },
      { text: "A line" },
      { text: "A different line" },
    ] }), ["A different line"]);
    expect(result.skipped).toBe(2);
    expect(result.items).toEqual([{ text: "A line", author: "A", bookTitle: "Book", excerpt: "Short", sourceUrl: "https://example.org/source", enabled: true }]);
  });

  it("rejects oversized and unbounded imports", () => {
    expect(() => parseQuoteImport("x".repeat(2 * 1024 * 1024 + 1), [])).toThrow(/2 MB/);
    expect(() => parseQuoteImport(JSON.stringify(Array.from({ length: 501 }, () => ({ text: "line" }))), [])).toThrow(/500/);
  });

  it("accepts exported records without carrying source identity", () => {
    const result = parseQuoteImport(JSON.stringify({ version: 1, items: [
      { id: "old", kind: "quote", text: "Words", bookId: "missing", bookTitle: "Novel", author: "Writer", note: "note", color: "pink", location: { kind: "bad" }, enabled: false, pinned: true },
    ] }), []);
    expect(result.items).toEqual([{ text: "Words", author: "Writer", bookTitle: "Novel", note: "note", color: "pink", enabled: false }]);
  });

  it("keeps long preview quotes disabled until an excerpt is set and drops unsafe links", () => {
    const result = parseQuoteImport(JSON.stringify({ items: [
      { text: "x".repeat(221), url: "javascript:alert(1)" },
      { text: "y".repeat(221), excerpt: "A short display", url: "http://example.org" },
    ] }), []);
    expect(result.items[0]).toMatchObject({ enabled: false });
    expect(result.items[0]).not.toHaveProperty("sourceUrl");
    expect(result.items[1]).toMatchObject({ enabled: true, excerpt: "A short display", sourceUrl: "http://example.org/" });
  });
});
