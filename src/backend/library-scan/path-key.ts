import { resolve } from "node:path";

/**
 * The single normalization used whenever a filesystem path is used as a lookup key.
 *
 * Windows paths are case-insensitive, so `E:\Books\A.epub` and `e:\books\a.epub` name
 * the same file. Keying a map on the raw string would report such a file as both
 * "already in the library" and "not imported yet", and the scan would then offer to
 * import a book the user already owns — forever, on every scan.
 *
 * Every comparison between a scanned file and a library source goes through this one
 * function rather than a locally invented `toLowerCase()`, so the two sides cannot
 * drift apart.
 */
export function pathKey(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
