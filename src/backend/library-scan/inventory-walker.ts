import { lstat, opendir, realpath } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import { QUARANTINE_DIR_NAME } from "./recycle-file.js";
import { InventoryEntryInput } from "./types.js";

export type WalkedInventoryEntry = InventoryEntryInput & {
  absolutePath: string;
};

const supportedFormat = (name: string): "txt" | "epub" | null => {
  const extension = extname(name).toLowerCase();
  if (extension === ".txt") return "txt";
  if (extension === ".epub") return "epub";
  return null;
};

/**
 * True when `candidate` is the root itself or strictly inside it.
 *
 * `path.relative` is not enough on its own: across drives it returns the absolute
 * target path, which does not start with ".." and would otherwise read as contained.
 * The `:` check rejects exactly that case.
 */
function isInsideRoot(rootReal: string, candidate: string): boolean {
  const relation = relative(rootReal, candidate);
  if (relation === "") return true;
  if (relation.startsWith("..")) return false;
  if (relation.includes(":")) return false;
  return !relation.split(sep).some((part) => part === "." || part === "..");
}

/**
 * Walks a folder and yields every TXT and EPUB in it.
 *
 * Syscall budget matters here: this runs over the user's whole book folder, and the
 * previous version spent one `lstat` *and* one `realpath` on every file plus an
 * `lstat` on every directory whose result it already had from `readdir`. The rules
 * that make it cheap without weakening it:
 *
 *  - `Dirent` type from `readdir` is used for the link/directory/file decision. It
 *    costs nothing, and on Windows a junction is a reparse point, which `readdir`
 *    reports as a link — so junctions are rejected here too.
 *  - Directories are canonicalised once with `realpath` and the walk recurses into
 *    the canonical path. That single call replaces the per-directory `lstat` *and*
 *    the per-file `realpath`, because a regular file directly inside a proven
 *    canonical directory cannot resolve outside it.
 *  - Files still get one `lstat`: size and modification time come from nowhere else,
 *    and it doubles as confirmation that the entry is a regular file rather than
 *    something that changed between `readdir` and now.
 *  - Containment is then re-checked in memory against the canonical root, so the
 *    guarantee does not rest on the recursion argument alone.
 */
export async function* walkInventory(
  canonicalRoot: string,
  signal: AbortSignal,
  onIgnoredFile?: () => void,
): AsyncGenerator<WalkedInventoryEntry> {
  const rootReal = await realpath(canonicalRoot);
  const rootStat = await lstat(rootReal);
  if (rootStat.isSymbolicLink()) {
    return;
  }

  // To ensure stable lexicographic traversal, we collect directory items, sort them, and recurse.
  async function* traverseDirectory(dirReal: string): AsyncGenerator<WalkedInventoryEntry> {
    signal.throwIfAborted();
    let dir;
    try {
      dir = await opendir(dirReal);
    } catch {
      return;
    }

    const dirents = [];
    for await (const dirent of dir) {
      dirents.push(dirent);
    }

    dirents.sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));

    for (const dirent of dirents) {
      signal.throwIfAborted();
      if (dirent.name === QUARANTINE_DIR_NAME) {
        continue;
      }
      if (dirent.isSymbolicLink()) {
        continue;
      }

      const fullPath = join(dirReal, dirent.name);

      if (dirent.isDirectory()) {
        yield* enterDirectory(fullPath);
        continue;
      }

      const fmt = supportedFormat(dirent.name);
      if (!fmt) {
        if (dirent.isFile()) onIgnoredFile?.();
        continue;
      }

      if (!dirent.isFile() && !(await isRegularFile(fullPath))) {
        continue;
      }

      const itemStat = await lstat(fullPath).catch(() => null);
      if (!itemStat?.isFile()) {
        continue;
      }
      if (!isInsideRoot(rootReal, fullPath)) {
        continue;
      }

      yield {
        absolutePath: fullPath,
        relativePath: relative(rootReal, fullPath).split(sep).join("/"),
        format: fmt,
        fileSize: itemStat.size,
        modifiedAt: itemStat.mtime.toISOString(),
      };
    }
  }

  /**
   * The fallback for entries whose type `readdir` did not report.
   *
   * Some filesystems leave `Dirent` type unknown. Dropping such an entry would silently
   * lose a book, so it is resolved with one `lstat` instead — the same call the file
   * path makes anyway, so a known-file entry still costs exactly one.
   */
  async function isRegularFile(path: string): Promise<boolean> {
    const facts = await lstat(path).catch(() => null);
    return facts?.isFile() === true && !facts.isSymbolicLink();
  }

  /**
   * Resolves a directory before descending into it.
   *
   * The containment check runs on the resolved path, so a link or junction that points
   * outside the root is refused *before* its contents are listed rather than one file
   * at a time, and recursion continues from the canonical path so nothing downstream
   * has to resolve it again.
   */
  async function* enterDirectory(path: string): AsyncGenerator<WalkedInventoryEntry> {
    const resolved = await realpath(path).catch(() => null);
    if (!resolved || !isInsideRoot(rootReal, resolved)) return;
    yield* traverseDirectory(resolved);
  }

  yield* traverseDirectory(rootReal);
}
