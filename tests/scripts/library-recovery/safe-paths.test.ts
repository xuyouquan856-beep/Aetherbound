import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveInsideRoot,
  toSafeRelative,
} from "../../../scripts/library-recovery/safe-paths.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("library recovery safe paths", () => {
  it("resolves a publication path inside the canonical root", async () => {
    const root = await mkdtemp(join(tmpdir(), "recovery-paths-"));
    roots.push(root);
    await mkdir(join(root, "Series"));
    await writeFile(join(root, "Series", "book.epub"), "book");

    await expect(resolveInsideRoot(root, "Series/book.epub"))
      .resolves.toBe(await realpath(join(root, "Series", "book.epub")));
    await expect(toSafeRelative(root, join(root, "Series", "book.epub")))
      .resolves.toBe("Series/book.epub");
  });

  it.each([
    "../escape.epub",
    "E:/escape.epub",
    "/escape.epub",
    "Series\\book.epub",
    "Series/../book.epub",
    "Series//book.epub",
  ])("rejects boundary escape %s", async (relativePath) => {
    const root = await mkdtemp(join(tmpdir(), "recovery-paths-"));
    roots.push(root);
    await expect(resolveInsideRoot(root, relativePath)).rejects.toThrow();
  });

  it("rejects an absolute path outside the root", async () => {
    const root = await mkdtemp(join(tmpdir(), "recovery-paths-"));
    const outside = await mkdtemp(join(tmpdir(), "recovery-outside-"));
    roots.push(root, outside);
    await writeFile(join(outside, "book.epub"), "book");

    await expect(toSafeRelative(root, join(outside, "book.epub"))).rejects.toThrow();
  });
});
