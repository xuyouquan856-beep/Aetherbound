import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("custom collection architecture boundaries", () => {
  it("keeps authorized folder enumeration in backend and paths out of renderer APIs", async () => {
    const [folderSource, contractsSource, preloadSource] = await Promise.all([
      readFile("src/backend/library/folder-collection-import-service.ts", "utf8"),
      readFile("src/shared/contracts.ts", "utf8"),
      readFile("src/preload/index.ts", "utf8"),
    ]);

    expect(folderSource).toContain("class FolderCollectionImportService");
    expect(contractsSource).not.toMatch(/collections[^]*sourcePath/i);
    expect(preloadSource).toContain("importFolder: (targetCollectionId) =>");
    expect(preloadSource).not.toMatch(/importFolder:\s*\([^)]*(path|folder)/i);
  });

  it("keeps 我的珍藏 on custom collections rather than the legacy series UI", async () => {
    const [appSource, sidebarSource] = await Promise.all([
      readFile("src/renderer/src/app/App.tsx", "utf8"),
      readFile("src/renderer/src/features/shell/Sidebar.tsx", "utf8"),
    ]);

    expect(appSource).toContain("CollectionsPage");
    expect(appSource).not.toMatch(/SeriesBrowser|SeriesDetail|selectedSeriesId/);
    expect(sidebarSource).toContain('onNavigate("collections")');
    expect(sidebarSource).not.toContain('onNavigate("series")');
  });
});
