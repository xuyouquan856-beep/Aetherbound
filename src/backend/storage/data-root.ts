import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

export function ensureDataRoot(path: string): string {
  const root = resolve(path);
  mkdirSync(root, { recursive: true });
  return root;
}
