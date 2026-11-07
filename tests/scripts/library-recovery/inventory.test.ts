import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureManifest,
  compareContentMultisets,
  diffManifestPaths,
  writeBaselineBundle,
} from "../../../scripts/library-recovery/inventory.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function corpus() {
  const root = await mkdtemp(join(tmpdir(), "recovery-inventory-"));
  roots.push(root);
  await mkdir(join(root, "Series"));
  await writeFile(join(root, "root.epub"), "root");
  await writeFile(join(root, "Series", "01.epub"), "one");
  await writeFile(join(root, "Series", "02.epub"), "two");
  await writeFile(join(root, "title.txt"), "title");
  await writeFile(join(root, "ignored.jpg"), "image");
  return root;
}

describe("library recovery inventory", () => {
  it("captures supported files deterministically without changing the corpus", async () => {
    const root = await corpus();
    const beforeNames = (await captureManifest(root)).map((entry) => entry.relativePath);
    const manifest = await captureManifest(root);

    expect(manifest.map((entry) => entry.relativePath)).toEqual([
      "root.epub",
      "Series/01.epub",
      "Series/02.epub",
      "title.txt",
    ]);
    expect(manifest.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256))).toBe(true);
    expect(manifest.map((entry) => entry.relativePath)).toEqual(beforeNames);
  });

  it("distinguishes approved path moves from content changes", async () => {
    const root = await corpus();
    const before = await captureManifest(root);
    const moved = before.map((entry) => entry.relativePath === "root.epub"
      ? { ...entry, relativePath: "Series/root.epub", parentFolder: "Series" }
      : entry);

    expect(diffManifestPaths(before, moved)).toEqual([
      { kind: "removed", relativePath: "root.epub" },
      { kind: "added", relativePath: "Series/root.epub" },
    ]);
    expect(compareContentMultisets(before, moved)).toEqual([]);

    const changed = moved.map((entry) => entry.relativePath === "Series/root.epub"
      ? { ...entry, sha256: "f".repeat(64) }
      : entry);
    expect(compareContentMultisets(before, changed)).not.toEqual([]);
  });

  it("writes a validated baseline bundle outside the corpus", async () => {
    const root = await corpus();
    const audit = await mkdtemp(join(tmpdir(), "recovery-audit-"));
    roots.push(audit);

    const bundle = await writeBaselineBundle({ root, auditDirectory: audit });
    const summary = JSON.parse(await readFile(bundle.summaryPath, "utf8"));
    const lines = (await readFile(bundle.manifestPath, "utf8")).trim().split("\n");

    expect(lines).toHaveLength(4);
    expect(summary).toMatchObject({
      inventoryVersion: 1,
      totalFiles: 4,
      epubFiles: 3,
      txtFiles: 1,
      rootFileCount: 2,
      folderCount: 1,
    });
    expect(bundle.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(diffManifestPaths(await captureManifest(root), bundle.manifest)).toEqual([]);
  });
});
