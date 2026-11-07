import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { importsOf } from "./find-imports.js";

/**
 * The isolation this file protects, and why it changed shape.
 *
 * It used to assert that six entrypoints did not contain the strings `library-scan`,
 * `DeepSeek` or `librarian` at all. That was a proxy for "the reader core can be built,
 * run and tested without the library-organizing subsystem" — and as a proxy it had
 * stopped describing anything real. It forbade `src/main/bootstrap/services.ts` from
 * mentioning `library-scan` while the scan subsystem's only production wiring lives
 * there, so the choice was between a feature that does not work and a test that means
 * nothing.
 *
 * The property is now stated directly, as a dependency direction:
 *
 *   1. Reader Core — the formats, the reader UI, the rendition runner, the publication
 *      protocol, sessions and progress — must not import the scan subsystem. Reading a
 *      book cannot depend on having scanned a folder.
 *   2. The scan subsystem must not import Reader Core's UI or rendition code. It
 *      observes files and records findings; it does not render anything.
 *   3. The legacy librarian is gone, not merely unwired, and it stays gone.
 *
 * The legacy check is kept verbatim for the files that still must not name it, because
 * that part *was* true and is still worth holding.
 */

/** Entrypoints that must not resurrect the deleted librarian/DeepSeek subsystem. */
const entrypoints = [
  "src/main/bootstrap/services.ts",
  "src/main/ipc/register-ipc.ts",
  "src/preload/index.ts",
  "src/renderer/src/app/App.tsx",
  "src/renderer/src/features/shell/AppShell.tsx",
  "src/renderer/src/features/shell/Sidebar.tsx",
  "src/shared/ipc.ts",
];

/**
 * Reader Core: the modules that make a book readable.
 *
 * Reaching any of these from the scan subsystem, or reaching the scan subsystem from
 * any of these, breaks the promise that reading works on its own.
 */
const readerCore = [
  "src/backend/indexing/book-text-extractor.ts",
  "src/backend/indexing/text-indexer.ts",
  "src/backend/library/library-service.ts",
  "src/backend/library/epub-preparation-service.ts",
  "src/backend/library/prepared-epub-binary-service.ts",
  "src/backend/sessions/reading-session-service.ts",
  "src/backend/storage/progress-repository.ts",
  "src/backend/storage/book-repository.ts",
  "src/formats/txt/adapter.ts",
  "src/formats/txt/locator.ts",
  "src/main/protocols/publication-protocol.ts",
  "src/main/protocols/bundle-protocol.ts",
  "src/renderer/src/features/reader/ReaderView.tsx",
  "src/renderer/src/features/reader/ReaderStage.tsx",
  "src/renderer/src/renditions/EpubRendition.tsx",
  "src/renderer/src/renditions/TxtRendition.tsx",
  "src/renderer/src/epub-runner/main.ts",
];

describe("Reader Core isolation", () => {
  it("does not reference the legacy librarian or DeepSeek subsystem", async () => {
    for (const path of entrypoints) {
      const source = await readFile(path, "utf8");
      expect(source, path).not.toMatch(
        /backend\/librarian|DeepSeek|LibrarianService|librarianConversation|channels\.librarian/,
      );
    }
  });

  it("keeps ReaderApi independent from a librarian property", async () => {
    const source = await readFile("src/shared/contracts.ts", "utf8");
    const api = source.slice(source.indexOf("export type ReaderApi"));
    expect(api).not.toMatch(/\blibrarian\s*:/);
  });

  it("keeps Reader Core free of any scan dependency", async () => {
    for (const path of readerCore) {
      const imports = await importsOf(path);
      const leaked = imports.filter((specifier) => /library-scan|library\/scan/u.test(specifier));
      expect(leaked, `${path} imports the scan subsystem`).toEqual([]);
    }
  });

  it("keeps the scan subsystem free of Reader Core UI and rendition code", async () => {
    const scanModules = [
      "src/backend/library-scan/scan-job-service.ts",
      "src/backend/library-scan/scan-review-service.ts",
      "src/backend/library-scan/local-resolution-service.ts",
      "src/backend/library-scan/duplicate-recycle-service.ts",
      "src/backend/library-scan/inventory-walker.ts",
      "src/backend/library-scan/lightweight-metadata-extractor.ts",
    ];
    for (const path of scanModules) {
      const imports = await importsOf(path);
      const leaked = imports.filter((specifier) => /renderer|renditions|epub-runner|features\/reader/u.test(specifier));
      expect(leaked, `${path} imports reader UI code`).toEqual([]);
    }
  });

  it("keeps the scan subsystem out of the Electron shell", async () => {
    // The scan runs in the backend and is driven over IPC. If it ever imports
    // `electron`, the backend can no longer be tested or reused without a browser
    // runtime, which is the boundary tests/architecture/boundaries.test.ts also holds.
    const scanModules = [
      "src/backend/library-scan/scan-job-service.ts",
      "src/backend/library-scan/scan-review-service.ts",
      "src/backend/library-scan/duplicate-recycle-service.ts",
      "src/backend/library-scan/recycle-file.ts",
      "src/backend/library-scan/path-key.ts",
      "src/backend/library-scan/library-link.ts",
    ];
    for (const path of scanModules) {
      const imports = await importsOf(path);
      expect(imports.filter((specifier) => specifier === "electron"), `${path} imports electron`).toEqual([]);
    }
  });
});
