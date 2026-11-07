import { beforeAll, describe, expect, it } from "vitest";

describe("AgentResolutionService", () => {
  let AgentResolutionService: typeof import("../../src/backend/library-scan/agent-resolution-service.js").AgentResolutionService;

  beforeAll(async () => {
    const mod = await import("../../src/backend/library-scan/agent-resolution-service.js");
    AgentResolutionService = mod.AgentResolutionService;
  });

  const makeService = (overrides?: Record<string, unknown>) => {
    return new AgentResolutionService({
      chatModel: (overrides?.chatModel as never) ?? null,
      getApiKey: (overrides?.getApiKey as () => Promise<string | null>) ?? (async () => null),
    });
  };

  const sampleFindings = [
    { id: "f1", kind: "exact_duplicate", status: "needs_review", summary: "dup A" },
    { id: "f2", kind: "series_volume", status: "needs_review", summary: "vol 1" },
  ] as Array<{ id: string; kind: string; status: string; summary: string }>;

  const sampleContexts = new Map<string, { relativePath: string; format: string }>();

  it("returns all findings unchanged when no chatModel is provided", async () => {
    const svc = makeService({ chatModel: null });
    const result = await svc.resolve({ findings: sampleFindings, fileContexts: sampleContexts });
    expect(result.resolved).toEqual([]);
    expect(result.remaining).toEqual(sampleFindings);
  });

  it("skips when no API key is available", async () => {
    const svc = makeService({
      chatModel: { complete: async () => ({ content: "ok", toolCalls: [] }) },
      getApiKey: async () => null,
    });
    const result = await svc.resolve({ findings: sampleFindings, fileContexts: sampleContexts });
    expect(result.remaining).toEqual(sampleFindings);
    expect(result.resolved).toEqual([]);
  });

  it("caps findings at 20 per batch", async () => {
    const svc = makeService({ chatModel: null });
    const many = Array.from({ length: 25 }, (_, i) => ({
      id: `f${i}`, kind: "exact_duplicate", status: "needs_review", summary: `item ${i}`,
    }));
    const result = await svc.resolve({ findings: many, fileContexts: sampleContexts });
    expect(result.remaining.length).toBe(25);
    expect(result.resolved.length).toBe(0);
  });

  it("returns empty result for empty findings array", async () => {
    const svc = makeService({ chatModel: null });
    const result = await svc.resolve({ findings: [], fileContexts: sampleContexts });
    expect(result.resolved).toEqual([]);
    expect(result.remaining).toEqual([]);
  });

  it("prompt does not contain absolute paths", async () => {
    let capturedMessages: unknown[] = [];
    const svc = makeService({
      chatModel: {
        complete: async (messages: unknown[]) => {
          capturedMessages = messages;
          return { content: null, toolCalls: [] };
        },
      },
      getApiKey: async () => "test-key",
    });
    const ctx = new Map(Object.entries({
      inv1: { relativePath: "books/test.epub", format: "epub" },
    }));
    await svc.resolve({ findings: sampleFindings, fileContexts: ctx as never });

    const fullText = JSON.stringify(capturedMessages);
    expect(fullText).not.toContain("E:\\\\");
    expect(fullText).not.toContain("C:\\\\");
    expect(fullText).not.toContain("absolutePath");
  });

  it("handles chatModel error gracefully", async () => {
    const svc = makeService({
      chatModel: { complete: async () => { throw new Error("API error"); } },
      getApiKey: async () => "test-key",
    });
    const result = await svc.resolve({ findings: sampleFindings, fileContexts: sampleContexts });
    expect(result.resolved).toEqual([]);
    expect(result.remaining).toEqual(sampleFindings);
  });
});
