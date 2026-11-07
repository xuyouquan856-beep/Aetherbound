import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";

async function sourceFiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const nested = await Promise.all(entries.map((entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return [".ts", ".tsx"].includes(extname(entry.name)) ? [path] : [];
    }));
    return nested.flat();
  } catch {
    return [];
  }
}

export async function findImports(roots: string[], forbidden: RegExp): Promise<string[]> {
  const files = (await Promise.all(roots.map(sourceFiles))).flat();
  const violations: string[] = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/(?:from\s+|import\s*\()(["'])([^"']+)\1/g)) {
      if (forbidden.test(match[2])) violations.push(`${file}: ${match[2]}`);
    }
  }
  return violations;
}

/** Every module specifier one file imports, in source order. */
export async function importsOf(file: string): Promise<string[]> {
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch {
    return [];
  }
  return Array.from(
    source.matchAll(/(?:from\s+|import\s*\()(["'])([^"']+)\1/g),
    (match) => match[2],
  );
}
