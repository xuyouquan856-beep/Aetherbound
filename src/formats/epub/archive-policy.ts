import type JSZip from "jszip";
import { EpubPolicyError } from "./errors.js";
import { normalizePublicationPath } from "./resource-path.js";

export type ArchiveBudget = {
  maxSourceBytes: number;
  maxEntries: number;
  maxEntryUncompressedBytes: number;
  maxTotalUncompressedBytes: number;
  maxCompressionRatio: number;
  minEntryRatioCheckBytes: number;
  maxPathLength: number;
};

export const DEFAULT_EPUB_BUDGET: ArchiveBudget = {
  maxSourceBytes: 512 * 1024 * 1024,
  maxEntries: 20_000,
  maxEntryUncompressedBytes: 128 * 1024 * 1024,
  maxTotalUncompressedBytes: 1024 * 1024 * 1024,
  maxCompressionRatio: 100,
  minEntryRatioCheckBytes: 128 * 1024,
  maxPathLength: 1024,
};

type InternalEntry = JSZip.JSZipObject & {
  unsafeOriginalName?: string;
  _data?: { compressedSize?: number; uncompressedSize?: number } | Promise<unknown>;
  options?: { compression?: string | null };
  unixPermissions?: number | string | null;
};

function isSymlink(entry: InternalEntry) {
  const value = typeof entry.unixPermissions === "string"
    ? Number.parseInt(entry.unixPermissions, 8)
    : entry.unixPermissions;
  return typeof value === "number" && (value & 0o170000) === 0o120000;
}

export function enforceArchiveBudget(zip: JSZip, budget: ArchiveBudget = DEFAULT_EPUB_BUDGET) {
  const entries = Object.values(zip.files) as InternalEntry[];
  if (entries.length > budget.maxEntries) throw new EpubPolicyError("ARCHIVE_LIMIT", "Too many archive entries");
  let total = 0;
  let totalCompressed = 0;
  for (const entry of entries) {
    const rawPath = entry.unsafeOriginalName ?? entry.name;
    const path = normalizePublicationPath(entry.dir && rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath);
    if (path.length > budget.maxPathLength) throw new EpubPolicyError("ARCHIVE_LIMIT", "Archive path is too long");
    if (isSymlink(entry)) throw new EpubPolicyError("RESOURCE_BLOCKED", "Symbolic links are not allowed");
    if (entry.dir) continue;
    const isLoadedEmpty = entry._data instanceof Promise
      && entry.options?.compression === "STORE"
      && typeof entry.unsafeOriginalName === "string";
    const compressed = isLoadedEmpty ? 0 : entry._data instanceof Promise ? undefined : entry._data?.compressedSize;
    const uncompressed = isLoadedEmpty ? 0 : entry._data instanceof Promise ? undefined : entry._data?.uncompressedSize;
    if (!Number.isSafeInteger(compressed) || !Number.isSafeInteger(uncompressed) || compressed! < 0 || uncompressed! < 0) {
      throw new EpubPolicyError("INVALID_PACKAGE", "Invalid ZIP size metadata");
    }
    if (uncompressed! > budget.maxEntryUncompressedBytes) throw new EpubPolicyError("ARCHIVE_LIMIT", "Archive entry is too large");
    if (
      uncompressed! >= budget.minEntryRatioCheckBytes
      && uncompressed! / Math.max(compressed!, 1) > budget.maxCompressionRatio
    ) {
      throw new EpubPolicyError("ARCHIVE_LIMIT", "Archive entry compression ratio is too high");
    }
    total += uncompressed!;
    totalCompressed += compressed!;
    if (total > budget.maxTotalUncompressedBytes) throw new EpubPolicyError("ARCHIVE_LIMIT", "Archive expands beyond its budget");
  }
  if (
    total >= budget.minEntryRatioCheckBytes
    && total / Math.max(totalCompressed, 1) > budget.maxCompressionRatio
  ) {
    throw new EpubPolicyError("ARCHIVE_LIMIT", "Archive aggregate compression ratio is too high");
  }
  return { entries: entries.length, totalUncompressedBytes: total };
}
