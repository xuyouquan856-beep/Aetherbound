import { resolve } from "node:path";

/** Keep the default profile on Electron's per-user path; callers may opt in to another root. */
export function resolveReaderDataRoot(userDataPath: string, override?: string): string {
  return resolve(override?.trim() ? override : userDataPath);
}
