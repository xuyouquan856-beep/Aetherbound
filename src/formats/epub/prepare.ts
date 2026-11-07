import { createHash } from "node:crypto";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import JSZip from "jszip";
import { enforceArchiveBudget, DEFAULT_EPUB_BUDGET, type ArchiveBudget } from "./archive-policy.js";
import { EpubPolicyError } from "./errors.js";
import { normalizePublicationPath } from "./resource-path.js";
import { sanitizePublicationDocument, sanitizePublicationStylesheet } from "./sanitize.js";

const ZIP_DATE = new Date("2000-01-01T00:00:00.000Z");

export async function prepareEpubBytes(source: Uint8Array, budget: ArchiveBudget = DEFAULT_EPUB_BUDGET, signal?: AbortSignal) {
  if (source.byteLength > budget.maxSourceBytes) throw new EpubPolicyError("ARCHIVE_LIMIT", "EPUB source exceeds its budget");
  if (signal?.aborted) throw new EpubPolicyError("CANCELLED", "EPUB preparation cancelled");
  const input = await JSZip.loadAsync(source, { checkCRC32: false, createFolders: false });
  const archive = enforceArchiveBudget(input, budget);
  const output = new JSZip();
  const removed = { scripts: 0, activeElements: 0, eventAttributes: 0, remoteUrls: 0 };

  for (const raw of Object.values(input.files)) {
    if (signal?.aborted) throw new EpubPolicyError("CANCELLED", "EPUB preparation cancelled");
    if (raw.dir) continue;
    const unsafeOriginalName = (raw as JSZip.JSZipObject & { unsafeOriginalName?: string }).unsafeOriginalName;
    const path = normalizePublicationPath(unsafeOriginalName ?? raw.name);
    let data: string | Uint8Array;
    if (/\.(?:xhtml|html|htm|svg)$/i.test(path)) {
      const result = sanitizePublicationDocument(await raw.async("text"));
      data = result.html;
      for (const key of Object.keys(removed) as (keyof typeof removed)[]) removed[key] += result.removed[key];
    } else if (/\.css$/i.test(path)) {
      const result = sanitizePublicationStylesheet(await raw.async("text"));
      data = result.css;
      removed.remoteUrls += result.removedRemoteUrls;
    } else data = await raw.async("uint8array");
    output.file(path, data, { date: ZIP_DATE, createFolders: false, compression: path === "mimetype" ? "STORE" : "DEFLATE" });
  }
  const bytes = await output.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 }, platform: "UNIX" });
  return { bytes, report: { archive, removed } };
}

export async function prepareEpub(sourcePath: string, destinationPath: string, signal?: AbortSignal) {
  const facts = await stat(sourcePath);
  if (!facts.isFile()) throw new EpubPolicyError("INVALID_PACKAGE", "EPUB source is not a regular file");
  if (facts.size > DEFAULT_EPUB_BUDGET.maxSourceBytes) throw new EpubPolicyError("ARCHIVE_LIMIT", "EPUB source exceeds its budget");
  const source = await readFile(sourcePath);
  const fullContentHash = createHash("sha256").update(source).digest("hex");
  const result = await prepareEpubBytes(source, DEFAULT_EPUB_BUDGET, signal);
  const stagingPath = `${destinationPath}.partial`;
  await writeFile(stagingPath, result.bytes);
  await rename(stagingPath, destinationPath);
  return { ...result.report, fullContentHash };
}
