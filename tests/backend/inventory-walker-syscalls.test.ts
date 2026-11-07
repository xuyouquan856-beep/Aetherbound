import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The walker's syscall budget.
 *
 * The previous version asked the filesystem two questions it already had the answers
 * to. Every directory got an `lstat` whose only use was `isDirectory()` — which
 * `readdir` had already reported through `Dirent` — and every file got a `realpath` on
 * top of its `lstat`, even though a regular file directly inside a directory that has
 * already been canonicalised cannot resolve anywhere else.
 *
 * Over a real book folder (thousands of files, hundreds of directories) that is
 * thousands of avoidable round trips on the process that also runs the UI, so the
 * counts are asserted rather than left to a comment. These numbers are the contract:
 * one `lstat` per file for its size and mtime, one `realpath` per directory, plus the
 * single `realpath` + `lstat` that establish the root.
 */

const counters = vi.hoisted(() => ({ lstat: 0, realpath: 0 }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: (...args: Parameters<typeof actual.lstat>) => {
      counters.lstat += 1;
      return actual.lstat(...args);
    },
    realpath: (...args: Parameters<typeof actual.realpath>) => {
      counters.realpath += 1;
      return actual.realpath(...args);
    },
  };
});

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

let walkInventory: typeof import("../../src/backend/library-scan/inventory-walker.js").walkInventory;

beforeAll(async () => {
  ({ walkInventory } = await import("../../src/backend/library-scan/inventory-walker.js"));
});

describe("inventory walker syscall cost", () => {
  it("stats each file once and resolves each directory once", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "walker-syscall-"));
    cleanup.push(rootDir);

    const subDirectories = ["a", "b", "c"];
    const filesPerDirectory = 4;
    for (const name of subDirectories) {
      await mkdir(join(rootDir, name));
      for (let index = 0; index < filesPerDirectory; index += 1) {
        await writeFile(join(rootDir, name, `f${index}.txt`), `content ${index}`);
      }
    }
    // One unsupported file, to prove the format filter runs before any stat.
    await writeFile(join(rootDir, "notes.pdf"), "not a book");

    const fileCount = subDirectories.length * filesPerDirectory;
    const directoryCount = subDirectories.length + 1;

    counters.lstat = 0;
    counters.realpath = 0;
    const entries = [];
    for await (const entry of walkInventory(rootDir, new AbortController().signal)) {
      entries.push(entry);
    }

    expect(entries).toHaveLength(fileCount);
    // Root: one realpath + one lstat. Then one realpath per directory entered...
    expect(counters.realpath).toBe(directoryCount);
    // ...and one lstat per book file, plus the root's own. No per-directory stat.
    expect(counters.lstat).toBe(fileCount + 1);
  });

  it("does not stat files whose extension is not supported", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "walker-syscall-skip-"));
    cleanup.push(rootDir);

    for (let index = 0; index < 25; index += 1) {
      await writeFile(join(rootDir, `image_${index}.jpg`), "x");
    }
    await writeFile(join(rootDir, "book.epub"), "x");

    counters.lstat = 0;
    counters.realpath = 0;
    const entries = [];
    for await (const entry of walkInventory(rootDir, new AbortController().signal)) {
      entries.push(entry);
    }

    expect(entries.map((entry) => entry.relativePath)).toEqual(["book.epub"]);
    // A folder of images costs the same as a folder of nothing: the format gate comes
    // before the size lookup, so unsupported files are never touched. The two `lstat`
    // calls are the root's own and the one book's.
    expect(counters.lstat).toBe(2);
    expect(counters.realpath).toBe(1);
  });

  it("costs nothing extra for deep nesting beyond one resolve per directory", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "walker-syscall-deep-"));
    cleanup.push(rootDir);

    let current = rootDir;
    for (let depth = 0; depth < 8; depth += 1) {
      current = join(current, `level${depth}`);
      await mkdir(current);
    }
    await writeFile(join(current, "deep.epub"), "x");

    counters.lstat = 0;
    counters.realpath = 0;
    const entries = [];
    for await (const entry of walkInventory(rootDir, new AbortController().signal)) {
      entries.push(entry);
    }

    expect(entries.map((entry) => entry.relativePath)).toEqual([
      "level0/level1/level2/level3/level4/level5/level6/level7/deep.epub",
    ]);
    expect(counters.realpath).toBe(9);
    // One for the book, one for the root — the eight directories in between add none.
    expect(counters.lstat).toBe(2);
  });
});
