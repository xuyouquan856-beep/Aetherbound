import { describe, expect, it, vi } from "vitest";
import { createReaderApi } from "../../src/preload/index.js";
import { channels } from "../../src/shared/ipc.js";
import { validatedHandler } from "../../src/main/ipc/validated-handler.js";
import { FulltextSearchRequestSchema, FulltextSearchResponseSchema } from "../../src/shared/contracts.js";

// Mock electron before importing preload — electron is unavailable in Node
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
}));

// --- Preload runtime: createReaderApi with mock ipcRenderer ---
describe("Preload runtime bridge", () => {
  it("search.fulltext invokes ipcRenderer.invoke with correct channel and request", async () => {
    const invoke = vi.fn().mockResolvedValue([{ bookId: "b1", title: "T", matchSnippet: "...", unitIndex: 0 }]);
    const on = vi.fn();
    const removeListener = vi.fn();
    const api = createReaderApi({ invoke, on, removeListener });

    await api.search.fulltext({ query: "test", limit: 10, offset: 0 });

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(channels.searchFulltext, { query: "test", limit: 10, offset: 0 });
  });
});

// --- Main handler runtime: validatedHandler with mock service ---
describe("Main handler runtime", () => {
  it("handler validates request with schema, calls service, validates response", async () => {
    const searchMock = vi.fn().mockReturnValue([
      { bookId: "b1", title: "Test Book", matchSnippet: "snip", unitIndex: 0 },
    ]);
    const handler = validatedHandler(
      FulltextSearchRequestSchema,
      FulltextSearchResponseSchema,
      async (input) => searchMock(input.query, input.limit, input.offset),
    );

    const result = await handler({ query: "hello", limit: 5, offset: 0 });
    expect(result).toEqual([{ bookId: "b1", title: "Test Book", matchSnippet: "snip", unitIndex: 0 }]);
    expect(searchMock).toHaveBeenCalledWith("hello", 5, 0);
  });

  it("handler rejects blank query via schema validation", async () => {
    const handler = validatedHandler(
      FulltextSearchRequestSchema,
      FulltextSearchResponseSchema,
      async () => [],
    );
    await expect(handler({ query: "", limit: 5, offset: 0 })).rejects.toThrow();
  });

  it("handler trims whitespace query via schema .trim()", async () => {
    const searchMock = vi.fn().mockReturnValue([]);
    const handler = validatedHandler(
      FulltextSearchRequestSchema,
      FulltextSearchResponseSchema,
      async (input) => searchMock(input.query),
    );
    await handler({ query: "  hello  ", limit: 5, offset: 0 });
    expect(searchMock).toHaveBeenCalledWith("hello");
  });

  it("handler rejects negative limit via schema", async () => {
    const handler = validatedHandler(
      FulltextSearchRequestSchema,
      FulltextSearchResponseSchema,
      async () => [],
    );
    await expect(handler({ query: "x", limit: -1, offset: 0 })).rejects.toThrow();
  });

  it("handler rejects service response with extra sourcePath field", async () => {
    const handler = validatedHandler(
      FulltextSearchRequestSchema,
      FulltextSearchResponseSchema,
      async () => [{ bookId: "b1", title: "T", matchSnippet: "...", unitIndex: 0, sourcePath: "/x" }],
    );
    await expect(handler({ query: "x", limit: 1, offset: 0 })).rejects.toThrow();
  });

  it("handler rejects service response with missing title field", async () => {
    const handler = validatedHandler(
      FulltextSearchRequestSchema,
      FulltextSearchResponseSchema,
      async () => [{ bookId: "b1", matchSnippet: "...", unitIndex: 0 }] as any,
    );
    await expect(handler({ query: "x", limit: 1, offset: 0 })).rejects.toThrow();
  });
});
