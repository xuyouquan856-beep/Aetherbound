import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Library Layer 2 Architecture Boundaries & Contract Locks", () => {
  it("asserts scan-finding-repository.js module exists", async () => {
    const mod = await import("../../src/backend/library-scan/scan-finding-repository.js").catch(() => null);
    expect(mod, "scan-finding-repository.js missing").not.toBeNull();
  });

  it("asserts lightweight-metadata-extractor.js module exists", async () => {
    const mod = await import("../../src/backend/library-scan/lightweight-metadata-extractor.js").catch(() => null);
    expect(mod, "lightweight-metadata-extractor.js missing").not.toBeNull();
  });

  it("asserts duplicate-resolver.js module exists", async () => {
    const mod = await import("../../src/backend/library-scan/duplicate-resolver.js").catch(() => null);
    expect(mod, "duplicate-resolver.js missing").not.toBeNull();
  });

  it("asserts series-resolver.js module exists", async () => {
    const mod = await import("../../src/backend/library-scan/series-resolver.js").catch(() => null);
    expect(mod, "series-resolver.js missing").not.toBeNull();
  });

  it("asserts duplicate-recycle-service.js module exists", async () => {
    const mod = await import("../../src/backend/library-scan/duplicate-recycle-service.js").catch(() => null);
    expect(mod, "duplicate-recycle-service.js missing").not.toBeNull();
  });

  it("asserts InventoryMetadataSchema export in shared contracts", async () => {
    const contractsModule = await import("../../src/shared/contracts.js");
    expect(contractsModule).toHaveProperty("InventoryMetadataSchema");
  });

  // --- Slice C: Agent Resolution Architecture ---

  it("asserts agent-resolution-service.js module exists (Slice C green)", async () => {
    const mod = await import("../../src/backend/library-scan/agent-resolution-service.js").catch(() => null);
    expect(mod, "agent-resolution-service.js missing").not.toBeNull();
  });

  it("asserts the agent phase is not wired into production", async () => {
    // The agent phase needs a chat model, an API key and a credential store, none of
    // which exist. It is kept in the tree because the pipeline is written to accept it,
    // and it is switched off by not injecting the pair it requires. That makes the
    // switch invisible in review, so it is asserted here: turning the AI phase on has
    // to be a deliberate edit to the composition root, not a side effect of adding a
    // dependency for something else.
    const source = await readFile("src/main/bootstrap/services.ts", "utf-8");
    expect(source, "the unscoped agent phase is wired into services.ts")
      .not.toMatch(/agentService|AgentResolutionService|findingsRepo/);
  });

  it("asserts edition-language-resolver.js module exists (Slice C green)", async () => {
    const mod = await import("../../src/backend/library-scan/edition-language-resolver.js").catch(() => null);
    expect(mod, "edition-language-resolver.js missing").not.toBeNull();
  });

  // The two assertions that used to sit here read
  // src/backend/librarian/conversation-service.ts to prove the librarian's
  // `Dependencies` type no longer exposed `inspect`. That subsystem is deleted, so the
  // files and the risk they guarded are both gone. The equivalent guard for the scan
  // system is the absent `agentService` dependency: the pipeline only runs the agent
  // phase when one is injected, which is asserted in scan-job-service.test.ts.

  it("asserts services.ts no longer wires inspect into LibrarianConversationService", async () => {
    const source = await readFile("src/main/bootstrap/services.ts", "utf-8");
    expect(source, "services.ts still wires inspect into conversation service")
      .not.toMatch(/inspect:\s*\(\s*\)\s*=>\s*librarian\.inspect\(\)/);
  });

  // --- Slice D: Collection & Search Architecture ---

  // Red: modules not yet created — expect FAILURE until implemented
  it("asserts collection-service.js module exists (Slice D red)", async () => {
    const mod = await import("../../src/backend/library/collection-service.js").catch(() => null);
    expect(mod, "collection-service.js missing — create it in Task 1").not.toBeNull();
  });

  it("asserts search-service.js module exists (Slice D red)", async () => {
    const mod = await import("../../src/backend/library/search-service.js").catch(() => null);
    expect(mod, "search-service.js missing — create it in Task 2").not.toBeNull();
  });

  it("asserts the review service module exists (Slice D red)", async () => {
    const mod = await import("../../src/backend/library-scan/scan-review-service.js").catch(() => null);
    expect(mod, "scan-review-service.js missing — create it in Task 3").not.toBeNull();
  });

  it("asserts trash-service.js module exists (Slice D red)", async () => {
    const mod = await import("../../src/backend/library/trash-service.js").catch(() => null);
    expect(mod, "trash-service.js missing — create it in Task 4").not.toBeNull();
  });

  // Green: tables already exist from migration 008
  it("asserts series table exists in migration 008 (Slice D green)", async () => {
    const source = await readFile("src/backend/storage/migrations/008-agent-resolution.ts", "utf-8");
    expect(source, "series table missing from migration 008").toMatch(/CREATE TABLE.*series/);
  });

  it("asserts book_aliases table exists in migration 008 (Slice D green)", async () => {
    const source = await readFile("src/backend/storage/migrations/008-agent-resolution.ts", "utf-8");
    expect(source, "book_aliases table missing from migration 008").toMatch(/CREATE TABLE.*book_aliases/);
  });

  // --- Slice E: Full-Text Search & UI Polish ---

  // Red: modules not yet created
  it("asserts text-indexer.js module exists (Slice E red)", async () => {
    const mod = await import("../../src/backend/indexing/text-indexer.js").catch(() => null);
    expect(mod, "text-indexer.js missing — create it in Task 1").not.toBeNull();
  });

  it("asserts book_content_fts virtual table in migration 010 (Slice E red)", async () => {
    try {
      const source = await readFile("src/backend/storage/migrations/010-fulltext-index.ts", "utf-8");
      expect(source, "book_content_fts missing from migration 010").toMatch(/book_content_fts/);
    } catch { throw new Error("migration 010 not found"); }
  });

  it("asserts book_index_state table in migration 010 (Slice E red)", async () => {
    const source = await readFile("src/backend/storage/migrations/010-fulltext-index.ts", "utf-8");
    expect(source, "book_index_state missing from migration 010").toMatch(/book_index_state/);
  });

  it("keeps the retired app trash service out of the composition root", async () => {
    const source = await readFile("src/main/bootstrap/services.ts", "utf-8");
    expect(source).not.toMatch(/TrashBinService/);
  });

  // Green: tables already exist from v9
  it("asserts trash_records table exists in migration 009 (Slice E green)", async () => {
    const source = await readFile("src/backend/storage/migrations/009-fts5-search.ts", "utf-8");
    expect(source, "trash_records table missing from migration 009").toMatch(/trash_records/);
  });

  it("asserts the scan pipeline takes no indexing dependency (Slice E green)", async () => {
    const source = await readFile("src/backend/library-scan/scan-job-service.ts", "utf-8");
    // The old assertion here required `reindexAll` to be *present* in this file, which
    // is how a whole-library reindex on every scan survived so long: the test asked for
    // the cost rather than for the guarantee. The guarantee is now the opposite, and it
    // is asserted against the dependency type rather than the whole file, because the
    // file explains in prose what it no longer does.
    const start = source.indexOf("export type ScanJobServiceDependencies");
    expect(start, "ScanJobServiceDependencies not found").toBeGreaterThan(-1);
    const deps = source.slice(start, source.indexOf("};", start));
    expect(deps, "the scan pipeline can still reach the text indexer")
      .not.toMatch(/reindexAll|searchService|textIndexer/);
  });

  // --- Slice E: Strengthened contract checks ---

  it("FulltextSearchRequestSchema and FulltextSearchResponseSchema exist in contracts", async () => {
    const m = await import("../../src/shared/contracts.js");
    expect(m).toHaveProperty("FulltextSearchRequestSchema");
    expect(m).toHaveProperty("FulltextSearchResponseSchema");
  });

  it("ReaderApi.search.fulltext exists in contracts type", async () => {
    const source = await readFile("src/shared/contracts.ts", "utf-8");
    expect(source).toMatch(/search:\s*\{[^}]*fulltext/);
  });

  it("preload exposes search.fulltext via channels.searchFulltext", async () => {
    const source = await readFile("src/preload/index.ts", "utf-8");
    expect(source).toMatch(/search:\s*\{/);
    expect(source).toMatch(/channels\.searchFulltext/);
  });

  it("main registers channels.searchFulltext with shared response schema", async () => {
    const source = await readFile("src/main/ipc/register-ipc.ts", "utf-8");
    expect(source).toMatch(/channels\.searchFulltext/);
    expect(source).toMatch(/FulltextSearchResponseSchema/);
  });

  it("production TextIndexer injected into services.ts", async () => {
    const source = await readFile("src/main/bootstrap/services.ts", "utf-8");
    expect(source).toMatch(/textIndexer.*new TextIndexer|new TextIndexer.*textIndexer/);
  });

  it("BookTextExtractor reads source_revision from book_sources", async () => {
    const source = await readFile("src/backend/indexing/book-text-extractor.ts", "utf-8");
    expect(source).toMatch(/source_revision/);
  });

  it("EPUB opened.ok === false throws error instead of silent return", async () => {
    const source = await readFile("src/backend/indexing/book-text-extractor.ts", "utf-8");
    expect(source).not.toMatch(/!opened\.ok\)\s*return/);
    expect(source).toMatch(/!opened\.ok/);
  });

  it("migration 010 contains FTS cleanup trigger", async () => {
    const source = await readFile("src/backend/storage/migrations/010-fulltext-index.ts", "utf-8");
    expect(source).toMatch(/book_content_fts_cleanup/);
  });

  it("services.ts no longer contains shell.trashItem", async () => {
    const source = await readFile("src/main/bootstrap/services.ts", "utf-8");
    expect(source).not.toMatch(/shell\.trashItem/);
  });

  it("TrashBinService does not expose permanentDelete", async () => {
    const source = await readFile("src/backend/library/trash-service.ts", "utf-8");
    expect(source).not.toMatch(/permanentDelete/);
  });

  it("LibrarianService trash callback does not catch-and-return-success", async () => {
    const source = await readFile("src/main/bootstrap/services.ts", "utf-8");
    // trash callback must not have .catch(() => "recycle-bin") which swallows failures
    expect(source).not.toMatch(/\.catch\(\s*\(\)\s*=>\s*["']recycle-bin["']/);
  });
});
