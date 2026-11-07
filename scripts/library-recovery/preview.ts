import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PreviewBundleSchema,
  type ManifestEntry,
  type PreviewAction,
} from "./contracts.js";
import type { ClassificationOutput } from "./classifier.js";
import type { MetadataResult } from "./epub-metadata.js";
import { parseTitleFacts } from "./normalization.js";

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replaceAll("\"", "\"\"")}"`;
}

function csv(headers: string[], rows: unknown[][]): string {
  return `${[headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

function safeFolderName(value: string): string | null {
  const normalized = value.normalize("NFKC").trim();
  if (
    !normalized
    || /[<>:"/\\|?*\u0000-\u001f]/u.test(normalized)
    || /[. ]$/u.test(normalized)
    || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/iu.test(normalized)
  ) return null;
  return normalized;
}

export async function writePreviewBundle(input: {
  auditDirectory: string;
  baselineDigest: string;
  classification: ClassificationOutput;
  manifest: readonly ManifestEntry[];
  metadata: readonly MetadataResult[];
  createdAt?: string;
}): Promise<{
  previewPath: string;
  previewDigest: string;
  summaryPath: string;
}> {
  await mkdir(input.auditDirectory, { recursive: true });
  const manifestByPath = new Map(input.manifest.map((entry) => [entry.relativePath, entry]));
  const metadataByPath = new Map(input.metadata.map((entry) => [entry.relativePath, entry]));
  const candidateNames = new Set(input.classification.candidateSeries.map((series) => series.canonicalSeriesName));
  const folderForSeries = new Map<string, string>();
  input.classification.folderAudits.forEach((audit) => {
    if (audit.dominantCanonicalSeries) {
      folderForSeries.set(audit.dominantCanonicalSeries, audit.folderName);
    }
  });
  candidateNames.forEach((canonical) => {
    const folder = safeFolderName(canonical);
    if (folder && !folderForSeries.has(canonical)) folderForSeries.set(canonical, folder);
  });

  const actions: PreviewAction[] = [];
  const needsReview: Array<[string, string, string]> = [];
  const keep: Array<[string, string]> = [];
  for (const record of input.classification.records) {
    const manifest = manifestByPath.get(record.relativePath);
    if (!manifest) continue;
    if (record.status !== "confirmed" && record.status !== "misplaced") {
      needsReview.push([record.relativePath, record.status, record.evidenceSummary]);
      continue;
    }
    if (!record.canonicalSeriesName) {
      needsReview.push([record.relativePath, record.status, "Missing canonical series name."]);
      continue;
    }
    const folder = folderForSeries.get(record.canonicalSeriesName);
    if (!folder) {
      needsReview.push([record.relativePath, record.status, "Series has fewer than three confirmed books and no verified folder."]);
      continue;
    }
    const fileName = record.relativePath.split("/").at(-1)!;
    const proposedRelativePath = `${folder}/${fileName}`;
    if (proposedRelativePath === record.relativePath) {
      keep.push([record.relativePath, record.canonicalSeriesName]);
      continue;
    }
    const metadataResult = metadataByPath.get(record.relativePath);
    const metadata = metadataResult?.ok ? metadataResult.metadata : null;
    const facts = parseTitleFacts({ metadataTitle: metadata?.title ?? null, fileName });
    const actionId = `move:${createHash("sha256")
      .update(`${record.relativePath}\0${proposedRelativePath}`)
      .digest("hex")
      .slice(0, 24)}`;
    actions.push({
      actionId,
      kind: "move",
      status: "confirmed",
      sourceRelativePath: record.relativePath,
      proposedRelativePath,
      seriesCanonicalName: record.canonicalSeriesName,
      editionLabels: facts.editionLabels,
      volumeLabel: facts.volumeLabel,
      title: metadata?.title ?? facts.normalizedTitle,
      creator: metadata?.creator ?? null,
      evidenceCodes: record.evidenceCodes,
      evidenceSummary: record.evidenceSummary,
      fileSize: manifest.fileSize,
      modifiedAt: manifest.modifiedAt,
      sha256: manifest.sha256,
    });
  }
  actions.sort((left, right) =>
    left.proposedRelativePath.localeCompare(right.proposedRelativePath, "zh-CN")
    || left.sourceRelativePath.localeCompare(right.sourceRelativePath, "zh-CN"));
  const createdAt = input.createdAt ?? new Date().toISOString();
  const bundle = PreviewBundleSchema.parse({
    previewVersion: 1,
    baselineDigest: input.baselineDigest,
    createdAt,
    actions,
  });
  const previewJson = `${JSON.stringify(bundle, null, 2)}\n`;
  const previewDigest = createHash("sha256").update(previewJson).digest("hex");
  const previewPath = join(input.auditDirectory, "preview-actions.json");
  const summaryPath = join(input.auditDirectory, "preview-summary.md");
  const moveIn = actions.filter((action) => !action.sourceRelativePath.includes("/"));
  const moveOut = actions.filter((action) => action.sourceRelativePath.includes("/"));

  await Promise.all([
    writeFile(join(input.auditDirectory, "metadata.jsonl"), `${input.metadata.map((value) => JSON.stringify(value)).join("\n")}\n`, "utf8"),
    writeFile(join(input.auditDirectory, "classification.jsonl"), `${input.classification.records.map((value) => JSON.stringify(value)).join("\n")}\n`, "utf8"),
    writeFile(join(input.auditDirectory, "folder-audits.json"), `${JSON.stringify(input.classification.folderAudits, null, 2)}\n`, "utf8"),
    writeFile(join(input.auditDirectory, "keep.csv"), csv(["relativePath", "series"], keep), "utf8"),
    writeFile(join(input.auditDirectory, "move-in.csv"), csv(["source", "destination", "evidence"], moveIn.map((action) => [action.sourceRelativePath, action.proposedRelativePath, action.evidenceSummary])), "utf8"),
    writeFile(join(input.auditDirectory, "move-out.csv"), csv(["source", "destination", "evidence"], moveOut.map((action) => [action.sourceRelativePath, action.proposedRelativePath, action.evidenceSummary])), "utf8"),
    writeFile(join(input.auditDirectory, "needs-review.csv"), csv(["relativePath", "status", "reason"], needsReview), "utf8"),
    writeFile(previewPath, previewJson, "utf8"),
    writeFile(join(input.auditDirectory, "preview.sha256"), `${previewDigest}\n`, "utf8"),
    writeFile(summaryPath, [
      "# EPUB Recovery Preview",
      "",
      `- Move in: ${moveIn.length}`,
      `- Move out: ${moveOut.length}`,
      `- Keep: ${keep.length}`,
      `- Needs review: ${needsReview.length}`,
      "",
      "This preview deletes 0 files, overwrites 0 files, renames 0 files, and modifies 0 book contents.",
      "",
    ].join("\n"), "utf8"),
  ]);
  return { previewPath, previewDigest, summaryPath };
}
