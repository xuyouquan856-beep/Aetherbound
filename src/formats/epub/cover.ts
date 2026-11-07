import { EpubPolicyError } from "./errors.js";

export type RasterCoverMediaType = "image/jpeg" | "image/png" | "image/webp";
export const MAX_EPUB_COVER_BYTES = 8 * 1024 * 1024;

export function enforceEpubCoverBudget(byteLength: number) {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new EpubPolicyError("INVALID_PACKAGE", "Invalid cover size metadata");
  }
  if (byteLength > MAX_EPUB_COVER_BYTES) throw new EpubPolicyError("ARCHIVE_LIMIT", "EPUB cover exceeds its byte budget");
}


export function detectRasterCoverMediaType(bytes: Uint8Array): RasterCoverMediaType | null {
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12
    && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF"
    && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") {
    return "image/webp";
  }
  return null;
}

export function isDeclaredRasterCover(mediaType: string, bytes: Uint8Array) {
  return detectRasterCoverMediaType(bytes) === mediaType;
}