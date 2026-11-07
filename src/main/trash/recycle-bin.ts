import { shell } from "electron";

/**
 * Moves a file to the operating system's recycle bin.
 *
 * The scan system only ever removes a file the user explicitly confirmed as a
 * redundant copy, and it puts it where the user can get it back — the Windows
 * recycle bin or the macOS trash — rather than deleting it. `shell.trashItem`
 * rejects when the platform refuses, which the caller turns into a fallback
 * quarantine inside the scanned folder instead of a silent loss.
 */
export async function moveFileToRecycleBin(path: string): Promise<void> {
  await shell.trashItem(path);
}
