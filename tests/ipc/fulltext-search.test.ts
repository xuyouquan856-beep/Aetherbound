import { describe, expect, it } from "vitest";
import { FulltextSearchRequestSchema, FulltextSearchResponseSchema } from "../../src/shared/contracts.js";
import { channels } from "../../src/shared/ipc.js";
import { readFile } from "node:fs/promises";

describe("Fulltext IPC contract", () => {
  it("rejects empty query", () => {
    expect(() => FulltextSearchRequestSchema.parse({ query: "" })).toThrow();
  });

  it("rejects whitespace-only query after trim", () => {
    expect(() => FulltextSearchRequestSchema.parse({ query: "   " })).toThrow();
  });

  it("accepts valid query with defaults", () => {
    const r = FulltextSearchRequestSchema.parse({ query: "hello" });
    expect(r.query).toBe("hello");
    expect(r.limit).toBe(20);
    expect(r.offset).toBe(0);
  });

  it("accepts explicit limit and offset", () => {
    const r = FulltextSearchRequestSchema.parse({ query: "hello", limit: 10, offset: 5 });
    expect(r.limit).toBe(10);
    expect(r.offset).toBe(5);
  });

  it("rejects negative limit", () => {
    expect(() => FulltextSearchRequestSchema.parse({ query: "x", limit: -1 })).toThrow();
  });

  it("rejects negative offset", () => {
    expect(() => FulltextSearchRequestSchema.parse({ query: "x", offset: -1 })).toThrow();
  });

  it("rejects limit > 100", () => {
    expect(() => FulltextSearchRequestSchema.parse({ query: "x", limit: 999 })).toThrow();
  });

  it("rejects query > 200 chars via schema", () => {
    expect(() => FulltextSearchRequestSchema.parse({ query: "x".repeat(201) })).toThrow();
  });

  it("accepts valid response array", () => {
    const r = FulltextSearchResponseSchema.parse([{ bookId: "b1", title: "T", matchSnippet: "...", unitIndex: 0 }]);
    expect(r).toHaveLength(1);
  });

  it("rejects response with missing fields", () => {
    expect(() => FulltextSearchResponseSchema.parse([{}])).toThrow();
  });

  it("rejects response with extra field sourcePath", () => {
    expect(() => FulltextSearchResponseSchema.parse([{ bookId: "b1", title: "T", matchSnippet: "...", unitIndex: 0, sourcePath: "/x" }])).toThrow();
  });

  it("rejects response with extra field absolutePath", () => {
    expect(() => FulltextSearchResponseSchema.parse([{ bookId: "b1", title: "T", matchSnippet: "...", unitIndex: 0, absolutePath: "/x" }])).toThrow();
  });

  it("channel name is 'search:fulltext'", () => {
    expect(channels.searchFulltext).toBe("search:fulltext");
  });

  it("ReaderApi.search.fulltext declared in contracts.ts", async () => {
    const src = await readFile("src/shared/contracts.ts", "utf-8");
    expect(src).toMatch(/search:\s*\{[^}]*fulltext/);
  });

  it("preload wires search.fulltext via channels.searchFulltext", async () => {
    const src = await readFile("src/preload/index.ts", "utf-8");
    expect(src).toMatch(/search:\s*\{/);
    expect(src).toMatch(/channels\.searchFulltext/);
  });

  it("main handler registers channels.searchFulltext with shared schemas", async () => {
    const src = await readFile("src/main/ipc/register-ipc.ts", "utf-8");
    expect(src).toMatch(/channels\.searchFulltext/);
    expect(src).toMatch(/FulltextSearchRequestSchema/);
    expect(src).toMatch(/FulltextSearchResponseSchema/);
  });

  it("runtime: request parse → mock handler → response schema validate", () => {
    // Simulate what the handler does: parse request, search, validate response
    const req = FulltextSearchRequestSchema.parse({ query: "test" });
    expect(req.query).toBe("test");

    // Mock search result (what TextIndexer.search would return)
    const mockResults = [
      { bookId: "b1", title: "T", matchSnippet: "...", unitIndex: 0 },
    ];

    // Response schema must accept valid DTO
    const validated = FulltextSearchResponseSchema.parse(mockResults);
    expect(validated).toHaveLength(1);
    expect(validated[0].bookId).toBe("b1");
  });

  it("runtime: response schema rejects missing title", () => {
    expect(() =>
      FulltextSearchResponseSchema.parse([{ bookId: "x", matchSnippet: "...", unitIndex: 0 }])
    ).toThrow();
  });
});
