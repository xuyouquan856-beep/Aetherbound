import { mkdtemp, opendir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { FileInventoryRepository } from "../src/backend/library-scan/file-inventory-repository.js";
import { LibraryRootRepository } from "../src/backend/library-scan/library-root-repository.js";
import { LightweightMetadataExtractor } from "../src/backend/library-scan/lightweight-metadata-extractor.js";
import { LocalResolutionService } from "../src/backend/library-scan/local-resolution-service.js";
import { ScanFindingRepository } from "../src/backend/library-scan/scan-finding-repository.js";
import { ScanJobRepository } from "../src/backend/library-scan/scan-job-repository.js";
import { ScanJobService } from "../src/backend/library-scan/scan-job-service.js";
import { loadLibraryLinks } from "../src/backend/library-scan/library-link.js";
import { walkInventory } from "../src/backend/library-scan/inventory-walker.js";
import { openDatabase } from "../src/backend/storage/database.js";
import type { LibraryScanSnapshot } from "../src/shared/contracts.js";

const SUPPORTED_EXTENSIONS = new Set([".txt", ".epub"]);

type ListingEntry = { relativePath: string; fileSize: number; modifiedAt: string };

/**
 * A listing-only snapshot of the folder.
 *
 * Deliberately does not hash: this runs before and after on a real library that can be
 * many gigabytes, and reading it twice would dominate the run. Path, size and mtime are
 * exactly what a move, rename, delete or rewrite would change, which is the property
 * the scan must not disturb.
 */
async function captureListing(root: string, directory = root, out: ListingEntry[] = []): Promise<ListingEntry[]> {
  const handle = await opendir(directory);
  for await (const entry of handle) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await captureListing(root, path, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
    const facts = await stat(path);
    out.push({
      relativePath: relative(root, path).replaceAll("\\", "/"),
      fileSize: facts.size,
      modifiedAt: facts.mtime.toISOString(),
    });
  }
  return out;
}

function diffListings(before: readonly ListingEntry[], after: readonly ListingEntry[]): string[] {
  const beforeByPath = new Map(before.map((entry) => [entry.relativePath, entry]));
  const afterByPath = new Map(after.map((entry) => [entry.relativePath, entry]));
  const changed: string[] = [];
  for (const path of new Set([...beforeByPath.keys(), ...afterByPath.keys()])) {
    const left = beforeByPath.get(path);
    const right = afterByPath.get(path);
    if (!left) changed.push(`added: ${path}`);
    else if (!right) changed.push(`removed: ${path}`);
    else if (left.fileSize !== right.fileSize || left.modifiedAt !== right.modifiedAt) {
      changed.push(`modified: ${path}`);
    }
  }
  return changed.sort();
}

export type ScanSmokeResult = {
  root: string;
  supported: number;
  totalBytes: number;
  elapsedMs: number;
  phaseTimings: Array<{ phase: string; atMs: number }>;
  counters: LibraryScanSnapshot["counters"];
  state: LibraryScanSnapshot["state"];
  errorCode: string | null;
  findingsByKind: Record<string, number>;
  findingsByStatus: Record<string, number>;
  mutated: string[];
};

/**
 * Runs the real scan pipeline over a folder and reports what it did.
 *
 * The database is a throwaway directory by default, so this never touches the user's
 * library — which is what makes it safe to point at the books they actually read.
 * Nothing in the pipeline moves a file; the listing diff at the end proves it.
 *
 * Pass `dataRoot` to keep the database between runs. A second run against the same
 * folder is then the incremental case: unchanged files are served from the cache and
 * only the walk and the resolution pass should cost anything.
 */
export async function runScanSmoke(rootPath: string, dataRoot?: string): Promise<ScanSmokeResult> {
  const root = resolve(rootPath);
  const tempDir = dataRoot ? resolve(dataRoot) : await mkdtemp(join(tmpdir(), "aetherbound-scan-smoke-"));
  const opened = openDatabase(tempDir);
  const before = await captureListing(root);

  try {
    const roots = new LibraryRootRepository(opened.db);
    const inventory = new FileInventoryRepository(opened.db);
    const findings = new ScanFindingRepository(opened.db);

    const service = new ScanJobService({
      roots,
      inventory,
      jobs: new ScanJobRepository(opened.db),
      metadataExtractor: new LightweightMetadataExtractor(),
      resolutionService: new LocalResolutionService(opened.db),
      loadLibraryLinks: () => loadLibraryLinks(opened.db),
      getManagedRoot: async () => root,
      canonicalizeRoot: async (path) => path,
      walk: walkInventory,
      now: () => new Date().toISOString(),
    });

    const startedAt = performance.now();
    const phaseTimings: Array<{ phase: string; atMs: number }> = [];
    let lastPhase: string | null = null;

    const terminal = await new Promise<LibraryScanSnapshot>((resolveTerminal, reject) => {
      const timeout = setTimeout(() => reject(new Error("scan smoke timed out")), 30 * 60 * 1000);
      const unsubscribe = service.subscribe((snapshot) => {
        if (snapshot.phase !== lastPhase) {
          lastPhase = snapshot.phase;
          phaseTimings.push({ phase: snapshot.phase, atMs: Math.round(performance.now() - startedAt) });
        }
        if (["completed", "failed", "cancelled"].includes(snapshot.state)) {
          clearTimeout(timeout);
          unsubscribe();
          resolveTerminal(snapshot);
        }
      });
      void service.start().catch(reject);
    });

    const rootRecord = roots.getMostRecent()!;
    const records = findings.listByRoot(rootRecord.id, { limit: 500, includeResolved: true });
    const findingsByKind: Record<string, number> = {};
    const findingsByStatus: Record<string, number> = {};
    for (const record of records) {
      findingsByKind[record.kind] = (findingsByKind[record.kind] ?? 0) + 1;
      findingsByStatus[record.status] = (findingsByStatus[record.status] ?? 0) + 1;
    }

    const after = await captureListing(root);
    const mutated = diffListings(before, after);

    return {
      root,
      supported: before.length,
      totalBytes: before.reduce((sum, entry) => sum + entry.fileSize, 0),
      elapsedMs: Math.round(performance.now() - startedAt),
      phaseTimings,
      counters: terminal.counters,
      state: terminal.state,
      errorCode: terminal.errorCode,
      findingsByKind,
      findingsByStatus,
      mutated,
    };
  } finally {
    opened.close();
    // Only a throwaway database is removed; a caller-supplied one is theirs to keep.
    if (!dataRoot) await rm(tempDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf("--root");
  const target = rootIndex >= 0 ? args[rootIndex + 1] : process.env.READER_TEST_CORPUS;
  if (!target) throw new Error("Pass --root <folder> or set READER_TEST_CORPUS.");
  const dataIndex = args.indexOf("--data-root");
  const dataRoot = dataIndex >= 0 ? args[dataIndex + 1] : undefined;

  const result = await runScanSmoke(target, dataRoot);
  console.log(JSON.stringify({
    mode: "scan-pipeline-read-only",
    root: result.root,
    supported: result.supported,
    totalBytes: result.totalBytes,
    state: result.state,
    errorCode: result.errorCode,
    elapsedMs: result.elapsedMs,
    phaseTimings: result.phaseTimings,
    counters: result.counters,
    findingsByKind: result.findingsByKind,
    findingsByStatus: result.findingsByStatus,
    mutated: result.mutated,
  }, null, 2));

  if (result.mutated.length > 0) {
    console.error("The scan changed the folder it was pointed at. That must never happen.");
    process.exitCode = 1;
  }
  if (result.state !== "completed") process.exitCode = 1;
}
