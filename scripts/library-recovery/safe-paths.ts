import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

function assertSafeRelativePath(relativePath: string): string[] {
  if (!relativePath || isAbsolute(relativePath) || /^(?:[a-z]:|\/)/i.test(relativePath)) {
    throw new Error("Expected a relative path inside the library root.");
  }
  if (relativePath.includes("\\")) {
    throw new Error("Relative paths must use forward slashes.");
  }
  const segments = relativePath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("Unsafe relative path segment.");
  }
  return segments;
}

function assertInside(root: string, candidate: string): void {
  const difference = relative(root, candidate);
  if (
    difference === ""
    || difference === ".."
    || difference.startsWith(`..${sep}`)
    || isAbsolute(difference)
  ) {
    throw new Error("Path escapes the library root.");
  }
}

export async function resolveInsideRoot(root: string, relativePath: string): Promise<string> {
  const canonicalRoot = await realpath(root);
  const candidate = resolve(canonicalRoot, ...assertSafeRelativePath(relativePath));
  assertInside(canonicalRoot, candidate);
  return candidate;
}

export async function toSafeRelative(root: string, absolutePath: string): Promise<string> {
  const canonicalRoot = await realpath(root);
  const canonicalCandidate = await realpath(absolutePath);
  assertInside(canonicalRoot, canonicalCandidate);
  return relative(canonicalRoot, canonicalCandidate).split(sep).join("/");
}
