import { mkdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  AliasRecordSchema,
  ManifestEntrySchema,
  type ManifestEntry,
} from "./contracts.js";
import { classifyLibrary } from "./classifier.js";
import { extractMetadataBatch, type MetadataResult } from "./epub-metadata.js";
import {
  captureManifest,
  compareContentMultisets,
  diffManifestPaths,
  writeBaselineBundle,
} from "./inventory.js";
import { writePreviewBundle } from "./preview.js";

const COMMANDS = new Set(["baseline", "analyze", "preview", "verify", "apply", "rollback"]);

function required(values: Record<string, string | boolean | undefined>, name: string): string {
  const value = values[name];
  if (typeof value !== "string" || !value) throw new Error(`Missing required --${name} option.`);
  return value;
}

function assertOutside(root: string, audit: string): void {
  const difference = relative(resolve(root), resolve(audit));
  if (difference === "" || (difference !== ".." && !difference.startsWith(`..${sep}`))) {
    throw new Error("Audit directory must be outside the library root.");
  }
}

async function readManifest(path: string): Promise<ManifestEntry[]> {
  return (await readFile(path, "utf8")).split(/\r?\n/).filter(Boolean)
    .map((line) => ManifestEntrySchema.parse(JSON.parse(line)));
}

export async function runLibraryRecoveryCli(args: string[]): Promise<Record<string, unknown>> {
  const command = args[0];
  if (!command) throw new Error("A recovery command is required.");
  if (!COMMANDS.has(command)) throw new Error(`Unknown command: ${command}`);
  const parsed = parseArgs({
    args: args.slice(1),
    strict: true,
    allowPositionals: false,
    options: {
      root: { type: "string" },
      "audit-root": { type: "string" },
      audit: { type: "string" },
      baseline: { type: "string" },
      aliases: { type: "string" },
      preview: { type: "string" },
      "confirm-digest": { type: "string" },
      journal: { type: "string" },
      limit: { type: "string" },
      "first-batch": { type: "boolean" },
      "batch-id": { type: "string" },
    },
  });
  const root = required(parsed.values, "root");

  if (command === "baseline") {
    const auditRoot = required(parsed.values, "audit-root");
    assertOutside(root, auditRoot);
    await mkdir(auditRoot, { recursive: true });
    const runDirectory = resolve(auditRoot, new Date().toISOString().replace(/[:.]/g, "-"));
    await mkdir(runDirectory);
    const bundle = await writeBaselineBundle({ root, auditDirectory: runDirectory });
    return { runDirectory, manifestPath: bundle.manifestPath, baselineDigest: bundle.digest };
  }
  if (command === "analyze") {
    const audit = required(parsed.values, "audit");
    assertOutside(root, audit);
    const manifest = await readManifest(resolve(audit, "baseline.jsonl"));
    const metadata = await extractMetadataBatch({ root, manifest });
    const metadataPath = resolve(audit, "metadata.jsonl");
    await writeFile(metadataPath, `${metadata.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
    return { metadataPath, total: metadata.length, errors: metadata.filter((entry) => !entry.ok).length };
  }
  if (command === "preview") {
    const audit = required(parsed.values, "audit");
    assertOutside(root, audit);
    const manifest = await readManifest(resolve(audit, "baseline.jsonl"));
    const metadata = (await readFile(resolve(audit, "metadata.jsonl"), "utf8"))
      .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as MetadataResult);
    const aliasesPath = parsed.values.aliases;
    const aliases = typeof aliasesPath === "string"
      ? AliasRecordSchema.array().parse(JSON.parse(await readFile(aliasesPath, "utf8")))
      : [];
    const classification = classifyLibrary({ manifest, metadata, aliases });
    const baselineDigest = (await readFile(resolve(audit, "baseline.sha256"), "utf8")).trim();
    return writePreviewBundle({ auditDirectory: audit, baselineDigest, classification, manifest, metadata });
  }
  if (command === "verify") {
    const baselinePath = required(parsed.values, "baseline");
    const before = await readManifest(baselinePath);
    const after = await captureManifest(root);
    const pathDifferences = diffManifestPaths(before, after);
    const contentDifferences = compareContentMultisets(before, after);
    if (pathDifferences.length || contentDifferences.length) {
      throw new Error(`Library verification failed: ${pathDifferences.length} path and ${contentDifferences.length} content differences.`);
    }
    return { verified: true, total: after.length };
  }
  if (command === "apply") {
    const previewPath = required(parsed.values, "preview");
    const expectedPreviewDigest = required(parsed.values, "confirm-digest");
    const journalPath = required(parsed.values, "journal");
    const limit = Number(required(parsed.values, "limit"));
    const { applyMoveBatch } = await import("./executor.js");
    return applyMoveBatch({
      root,
      previewPath,
      expectedPreviewDigest,
      journalPath,
      limit,
      firstBatch: parsed.values["first-batch"] === true,
    });
  }
  const journalPath = required(parsed.values, "journal");
  const batchId = required(parsed.values, "batch-id");
  const { rollbackBatch } = await import("./executor.js");
  return rollbackBatch({ root, journalPath, batchId });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runLibraryRecoveryCli(process.argv.slice(2))
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
