import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import { DOMParser } from "linkedom";
import type { ManifestEntry, EpubMetadata } from "./contracts.js";
import { EpubMetadataSchema } from "./contracts.js";
import { resolveInsideRoot } from "./safe-paths.js";

class MetadataError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export type MetadataResult =
  | { relativePath: string; ok: true; metadata: EpubMetadata }
  | { relativePath: string; ok: false; errorCode: string };

function validPublicationPath(value: string): boolean {
  if (!value || value.includes("\\") || /^(?:[a-z]:|\/)/i.test(value)) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

type ParsedXml = ReturnType<DOMParser["parseFromString"]>;

function firstText(document: ParsedXml, localName: string): string | null {
  for (const tagName of [`dc:${localName}`, localName]) {
    for (const element of Array.from(document.getElementsByTagName(tagName))) {
      const text = element.textContent?.trim();
      if (text) return text;
    }
  }
  return null;
}

function metaElements(document: ParsedXml) {
  return Array.from(document.getElementsByTagName("meta"));
}

function parsePosition(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export async function extractRecoveryMetadata(input: {
  absolutePath: string;
  relativePath: string;
}): Promise<EpubMetadata> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(await readFile(input.absolutePath), {
      checkCRC32: true,
      createFolders: false,
    });
  } catch {
    throw new MetadataError("INVALID_PACKAGE", "Not a valid ZIP/EPUB package.");
  }
  const entries = Object.values(zip.files);
  if (entries.length > 20_000) {
    throw new MetadataError("ARCHIVE_LIMIT", "EPUB entry count exceeds 20,000.");
  }
  for (const entry of entries) {
    const original = (entry as JSZip.JSZipObject & { unsafeOriginalName?: string }).unsafeOriginalName
      ?? entry.name;
    if (!entry.dir && !validPublicationPath(original)) {
      throw new MetadataError("INVALID_PACKAGE", `Unsafe EPUB path: ${original}`);
    }
  }

  const container = zip.file("META-INF/container.xml");
  if (!container) throw new MetadataError("INVALID_PACKAGE", "Missing container.xml.");
  const containerXml = await container.async("text");
  if (Buffer.byteLength(containerXml) > 1024 * 1024) {
    throw new MetadataError("FILE_TOO_LARGE", "container.xml exceeds 1 MiB.");
  }
  const rootfileMatch = containerXml.match(
    /<rootfile\b[^>]*\bfull-path\s*=\s*["']([^"']+)["'][^>]*\/?>/i,
  );
  const opfPath = rootfileMatch?.[1] ?? "";
  if (!validPublicationPath(opfPath)) {
    throw new MetadataError("INVALID_PACKAGE", `Invalid OPF path: ${opfPath}`);
  }
  const opfEntry = zip.file(opfPath);
  if (!opfEntry) throw new MetadataError("INVALID_PACKAGE", "Referenced OPF is missing.");
  const opfXml = await opfEntry.async("text");
  if (Buffer.byteLength(opfXml) > 5 * 1024 * 1024) {
    throw new MetadataError("FILE_TOO_LARGE", "OPF exceeds 5 MiB.");
  }

  const document = new DOMParser().parseFromString(opfXml, "text/xml");
  const metas = metaElements(document);
  const collection = metas.find((element) =>
    element.getAttribute("property") === "belongs-to-collection"
    && element.textContent?.trim());
  const collectionId = collection?.getAttribute("id");
  const collectionType = collectionId
    ? metas.find((element) =>
      element.getAttribute("property") === "collection-type"
      && element.getAttribute("refines") === `#${collectionId}`)
    : undefined;
  const epub3Position = collectionId
    ? metas.find((element) =>
      element.getAttribute("property") === "group-position"
      && element.getAttribute("refines") === `#${collectionId}`)
    : undefined;
  const calibreSeries = metas.find((element) =>
    element.getAttribute("name")?.toLowerCase() === "calibre:series");
  const calibreIndex = metas.find((element) =>
    element.getAttribute("name")?.toLowerCase() === "calibre:series_index");
  const epub3Series = collectionType?.textContent?.trim() === "series"
    ? collection?.textContent?.trim() ?? null
    : null;

  return EpubMetadataSchema.parse({
    metadataVersion: 1,
    relativePath: input.relativePath,
    title: firstText(document, "title") ?? input.relativePath.split("/").at(-1) ?? "Unknown",
    creator: firstText(document, "creator"),
    language: firstText(document, "language"),
    identifier: firstText(document, "identifier"),
    publisher: firstText(document, "publisher"),
    publishedAt: firstText(document, "date"),
    series: epub3Series ?? calibreSeries?.getAttribute("content")?.trim() ?? null,
    groupPosition: parsePosition(
      epub3Position?.textContent?.trim()
      ?? calibreIndex?.getAttribute("content")
      ?? null,
    ),
    source: "epub-opf",
  });
}

export async function extractMetadataBatch(input: {
  root: string;
  manifest: readonly ManifestEntry[];
  concurrency?: 1 | 2;
}): Promise<MetadataResult[]> {
  const concurrency = input.concurrency ?? 2;
  const results = new Array<MetadataResult>(input.manifest.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, input.manifest.length) }, async () => {
    while (next < input.manifest.length) {
      const index = next++;
      const entry = input.manifest[index];
      if (entry.extension !== ".epub") {
        results[index] = { relativePath: entry.relativePath, ok: false, errorCode: "UNSUPPORTED_FORMAT" };
        continue;
      }
      try {
        results[index] = {
          relativePath: entry.relativePath,
          ok: true,
          metadata: await extractRecoveryMetadata({
            absolutePath: await resolveInsideRoot(input.root, entry.relativePath),
            relativePath: entry.relativePath,
          }),
        };
      } catch (error) {
        results[index] = {
          relativePath: entry.relativePath,
          ok: false,
          errorCode: error instanceof MetadataError ? error.code : "METADATA_FAILED",
        };
      }
    }
  });
  await Promise.all(workers);
  return results;
}
