import { realpath, stat } from "node:fs/promises";
import { extname, relative } from "node:path";
import { ReaderError } from "../../shared/errors.js";

/** Formats the scan system is allowed to handle. */
const MANAGED_EXTENSIONS = [".txt", ".epub"];

/**
 * Resolves a candidate path and proves it is a plain book file inside `root`.
 *
 * Every filesystem operation on the user's behalf goes through here first. The checks
 * that matter:
 *  - `realpath` on BOTH sides, so a symlink or NTFS junction inside the root cannot
 *    be used to reach outside it;
 *  - the relation must not escape (`..`), and `relation.includes(":")` rejects a
 *    cross-drive result — `path.relative("E:\\a", "C:\\b")` returns the absolute
 *    `C:\b`, which does NOT start with ".." and would otherwise pass;
 *  - `isFile()`, so a directory or device path is refused;
 *  - an extension allowlist, so this can never be pointed at an arbitrary file.
 *
 * Returns the canonical path, which callers must use rather than the original, so a
 * path swapped after the check cannot redirect the operation.
 */
export async function assertManagedFile(root: string, candidate: string): Promise<string> {
  let canonicalRoot: string;
  let canonicalCandidate: string;
  try {
    [canonicalRoot, canonicalCandidate] = await Promise.all([
      realpath(root),
      realpath(candidate),
    ]);
  } catch {
    throw new ReaderError("FILE_NOT_READABLE", "文件不存在或无法读取。");
  }

  const relation = relative(canonicalRoot, canonicalCandidate);
  if (!relation || relation.startsWith("..") || relation.includes(":")) {
    throw new ReaderError("INVALID_REQUEST", "文件不在已授权的图书目录中。");
  }

  const facts = await stat(canonicalCandidate);
  if (!facts.isFile()) throw new ReaderError("INVALID_REQUEST", "只允许管理普通图书文件。");
  if (!MANAGED_EXTENSIONS.includes(extname(canonicalCandidate).toLowerCase())) {
    throw new ReaderError("FORMAT_NOT_SUPPORTED", "扫描系统只处理 TXT 和 EPUB。");
  }
  return canonicalCandidate;
}
