import { relative, resolve, sep } from "node:path";

/**
 * The folder name both trash mechanisms use.
 *
 * There are two of them, they live in different roots, and they mean the same thing:
 *
 *  - the library's recycle bin moves a removed book into `<dataRoot>/.aether-trash`
 *    and records it in `trash_records` so it can be restored from the UI;
 *  - the scan's quarantine is the fallback for a confirmed duplicate when the operating
 *    system refuses to move it to the real recycle bin, under `<scannedRoot>/.aether-trash`.
 *
 * The name used to be written out by hand in four places. It drifted once already: the
 * inventory walker skipped `.aetherbound-trash`, a directory nothing ever created, so
 * every scan re-discovered the files the previous one had quarantined. The name lives
 * here so the two sides cannot disagree again.
 */
export const TRASH_DIRECTORY_NAME = ".aether-trash";

/** True when `path` is the trash directory itself or something inside it. */
export function isInTrashDirectory(root: string, path: string): boolean {
  const rootRelative = relative(resolve(root), resolve(path));
  if (rootRelative === TRASH_DIRECTORY_NAME) return true;
  return rootRelative.startsWith(`${TRASH_DIRECTORY_NAME}${sep}`);
}

/**
 * True when any segment of `path` names the trash directory.
 *
 * Segment-aware on purpose. The previous check was `path.includes(".aether-trash")`,
 * which also rejected `E:\books\my.aether-trash-notes\a.epub` — a folder the user can
 * legitimately own — while telling the caller nothing about whether the path was
 * really inside the trash.
 */
export function hasTrashDirectorySegment(path: string): boolean {
  return resolve(path)
    .split(/[\\/]/u)
    .some((segment) => segment === TRASH_DIRECTORY_NAME);
}
