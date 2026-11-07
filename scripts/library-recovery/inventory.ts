import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  opendir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  ManifestEntrySchema,
  type ManifestEntry,
} from "./contracts.js";

const SUPPORTED_EXTENSIONS = new Set([".epub", ".txt"]);

export type ManifestDifference = {
  kind: "added" | "removed" | "changed";
  relativePath: string;
};

export type ContentDifference = {
  contentKey: string;
  beforeCount: number;
  afterCount: number;
};

export type BaselineBundle = {
  manifest: ManifestEntry[];
  manifestPath: string;
  summaryPath: string;
  digestPath: string;
  digest: string;
};

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolveStream, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolveStream);
  });
  return hash.digest("hex");
}

async function walk(root: string, directory: string, paths: string[]): Promise<void> {
  const handle = await opendir(directory);
  for await (const entry of handle) {
    const absolutePath = join(directory, entry.name);
    const facts = await lstat(absolutePath);
    if (facts.isSymbolicLink()) continue;
    if (facts.isDirectory()) {
      await walk(root, absolutePath, paths);
      continue;
    }
    const extension = extname(entry.name).toLowerCase();
    if (facts.isFile() && SUPPORTED_EXTENSIONS.has(extension)) {
      const canonical = await realpath(absolutePath);
      const difference = relative(root, canonical);
      if (
        difference === ""
        || difference === ".."
        || difference.startsWith(`..${sep}`)
        || isAbsolute(difference)
      ) {
        throw new Error("Inventory entry escaped the canonical root.");
      }
      paths.push(canonical);
    }
  }
}

async function mapTwo<T, R>(values: readonly T[], operation: (value: T) => Promise<R>) {
  const results = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(2, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await operation(values[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function comparePath(left: string, right: string): number {
  return left.localeCompare(right, "en", { numeric: true, sensitivity: "variant" });
}

export async function captureManifest(root: string): Promise<ManifestEntry[]> {
  const canonicalRoot = await realpath(resolve(root));
  const paths: string[] = [];
  await walk(canonicalRoot, canonicalRoot, paths);
  paths.sort((left, right) => comparePath(
    relative(canonicalRoot, left),
    relative(canonicalRoot, right),
  ));

  return mapTwo(paths, async (path) => {
    const facts = await stat(path);
    const relativePath = relative(canonicalRoot, path).split(sep).join("/");
    const parent = dirname(relativePath).replaceAll("\\", "/");
    return ManifestEntrySchema.parse({
      inventoryVersion: 1,
      relativePath,
      extension: extname(path).toLowerCase(),
      fileSize: facts.size,
      modifiedAt: facts.mtime.toISOString(),
      sha256: await sha256File(path),
      parentFolder: parent === "." ? "" : parent,
    });
  });
}

export function diffManifestPaths(
  before: readonly ManifestEntry[],
  after: readonly ManifestEntry[],
): ManifestDifference[] {
  const beforeByPath = new Map(before.map((entry) => [entry.relativePath, entry]));
  const afterByPath = new Map(after.map((entry) => [entry.relativePath, entry]));
  const removed = [...beforeByPath.keys()]
    .filter((path) => !afterByPath.has(path))
    .sort(comparePath)
    .map((relativePath) => ({ kind: "removed" as const, relativePath }));
  const added = [...afterByPath.keys()]
    .filter((path) => !beforeByPath.has(path))
    .sort(comparePath)
    .map((relativePath) => ({ kind: "added" as const, relativePath }));
  const changed = [...beforeByPath.keys()]
    .filter((path) => {
      const left = beforeByPath.get(path);
      const right = afterByPath.get(path);
      return right && (
        left?.fileSize !== right.fileSize
        || left.modifiedAt !== right.modifiedAt
        || left.sha256 !== right.sha256
        || left.extension !== right.extension
      );
    })
    .sort(comparePath)
    .map((relativePath) => ({ kind: "changed" as const, relativePath }));
  return [...removed, ...added, ...changed];
}

export function compareContentMultisets(
  before: readonly ManifestEntry[],
  after: readonly ManifestEntry[],
): ContentDifference[] {
  const counts = (entries: readonly ManifestEntry[]) => {
    const result = new Map<string, number>();
    for (const entry of entries) {
      const key = `${entry.fileSize}:${entry.sha256}`;
      result.set(key, (result.get(key) ?? 0) + 1);
    }
    return result;
  };
  const left = counts(before);
  const right = counts(after);
  return [...new Set([...left.keys(), ...right.keys()])]
    .sort()
    .filter((key) => (left.get(key) ?? 0) !== (right.get(key) ?? 0))
    .map((contentKey) => ({
      contentKey,
      beforeCount: left.get(contentKey) ?? 0,
      afterCount: right.get(contentKey) ?? 0,
    }));
}

function assertAuditOutsideRoot(canonicalRoot: string, canonicalAudit: string): void {
  const auditFromRoot = relative(canonicalRoot, canonicalAudit);
  if (
    auditFromRoot === ""
    || (!auditFromRoot.startsWith(`..${sep}`) && auditFromRoot !== ".." && !isAbsolute(auditFromRoot))
  ) {
    throw new Error("Audit directory must be outside the library root.");
  }
}

export async function writeBaselineBundle(input: {
  root: string;
  auditDirectory: string;
}): Promise<BaselineBundle> {
  const canonicalRoot = await realpath(resolve(input.root));
  await mkdir(input.auditDirectory, { recursive: true });
  const canonicalAudit = await realpath(resolve(input.auditDirectory));
  assertAuditOutsideRoot(canonicalRoot, canonicalAudit);

  const manifest = await captureManifest(canonicalRoot);
  const jsonl = `${manifest.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  const digest = createHash("sha256").update(jsonl).digest("hex");
  const folders = new Set(manifest.map((entry) => entry.parentFolder).filter(Boolean));
  const hashes = new Map<string, number>();
  manifest.forEach((entry) => hashes.set(entry.sha256, (hashes.get(entry.sha256) ?? 0) + 1));
  const summary = {
    inventoryVersion: 1,
    capturedAt: new Date().toISOString(),
    rootPath: canonicalRoot,
    totalFiles: manifest.length,
    epubFiles: manifest.filter((entry) => entry.extension === ".epub").length,
    txtFiles: manifest.filter((entry) => entry.extension === ".txt").length,
    totalBytes: manifest.reduce((sum, entry) => sum + entry.fileSize, 0),
    rootFileCount: manifest.filter((entry) => entry.parentFolder === "").length,
    folderCount: folders.size,
    hashDuplicateGroups: [...hashes.values()].filter((count) => count > 1).length,
  };
  const manifestPath = join(canonicalAudit, "baseline.jsonl");
  const summaryPath = join(canonicalAudit, "baseline-summary.json");
  const digestPath = join(canonicalAudit, "baseline.sha256");
  await writeFile(manifestPath, jsonl, { encoding: "utf8", flag: "wx" });
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await writeFile(digestPath, `${digest}\n`, { encoding: "utf8", flag: "wx" });
  return { manifest, manifestPath, summaryPath, digestPath, digest };
}
