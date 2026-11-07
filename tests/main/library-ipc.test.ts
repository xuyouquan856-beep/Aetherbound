import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("library IPC boundary", () => {
  it("exposes removal as a named opaque-id capability without filesystem primitives", async () => {
    const preload = await readFile("src/preload/index.ts", "utf8");
    const ipc = await readFile("src/main/ipc/register-ipc.ts", "utf8");

    expect(preload).toMatch(/remove:\s*\(bookIds, deleteOriginal\)\s*=>\s*\S+\.invoke\(\s*\S+\.libraryRemove/);
    expect(preload).toContain("channels.libraryRemove");
    expect(preload).not.toMatch(/unlink|trashItem|sourcePath/);
    expect(ipc).toContain("LibraryRemoveRequestSchema");
    expect(ipc).toContain("LibraryRemoveResultSchema");
    expect(ipc).toContain("services.library.removeBooks(bookIds, {");
  });

  it("offers separate legacy pickers and one mixed TXT/EPUB picker", async () => {
    const ipc = await readFile("src/main/ipc/register-ipc.ts", "utf8");

    expect(ipc.match(/multiSelections/g)).toHaveLength(3);
    expect(ipc).toContain('services.importer.importFiles(selection.filePaths, "txt")');
    expect(ipc).toContain('services.importer.importFiles(selection.filePaths, "epub")');
    expect(ipc).toContain("chooseAndImportMixed");
  });
});
