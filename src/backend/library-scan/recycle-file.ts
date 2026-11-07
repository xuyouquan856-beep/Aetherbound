import { mkdir, rename } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { assertManagedFile } from "./path-guard.js";
import { TRASH_DIRECTORY_NAME } from "../storage/trash-directory.js";

/**
 * Quarantine directory inside the managed root, used when the OS recycle bin fails.
 *
 * The name comes from the shared constant rather than a literal here: the library's own
 * recycle bin uses the same folder name in its own root, and the inventory walker has
 * to skip it. When these were independent strings they disagreed, and the walker spent
 * its time re-discovering files the previous scan had already quarantined.
 */
export const QUARANTINE_DIR_NAME = TRASH_DIRECTORY_NAME;

export type RecycleDisposition = "recycle-bin" | "quarantine";

/**
 * Moves a managed book file out of the library, preferring the OS recycle bin so the
 * user can restore it from Explorer, and falling back to a quarantine folder inside
 * the managed root.
 *
 * The file is never deleted. Both paths are a rename, so a failure anywhere leaves the
 * original in place — which is why the caller can safely record the outcome afterwards.
 */
export async function recycleManagedFile(
  root: string,
  candidate: string,
  moveToRecycleBin: (path: string) => Promise<void>,
): Promise<RecycleDisposition> {
  // Throws unless this is a plain .txt/.epub inside the root.
  const canonical = await assertManagedFile(root, candidate);

  try {
    await moveToRecycleBin(canonical);
    return "recycle-bin";
  } catch {
    const quarantine = join(root, QUARANTINE_DIR_NAME);
    await mkdir(quarantine, { recursive: true });
    await rename(canonical, join(quarantine, `${randomUUID()}-${basename(canonical)}`));
    return "quarantine";
  }
}
