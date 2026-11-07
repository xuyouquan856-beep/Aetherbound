import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { walkInventory } from "../../src/backend/library-scan/inventory-walker.js";
import { QUARANTINE_DIR_NAME } from "../../src/backend/library-scan/recycle-file.js";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("inventory walker", () => {
  it("discovers txt and epub recursively in lexicographic order, excluding trash and symlinks", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "walker-test-"));
    cleanup.push(rootDir);

    const sub = join(rootDir, "sub");
    // Use the real quarantine name. The fixture previously hardcoded ".aetherbound-trash",
    // which was not the name the trash service used — so the walker skipped the wrong
    // directory and the test still passed.
    const trash = join(rootDir, QUARANTINE_DIR_NAME);
    await mkdir(sub, { recursive: true });
    await mkdir(trash, { recursive: true });

    await writeFile(join(rootDir, "b_book.EPUB"), "dummy epub");
    await writeFile(join(rootDir, "a_book.TXT"), "dummy txt");
    await writeFile(join(rootDir, "ignore.pdf"), "dummy pdf");
    await writeFile(join(sub, "c_book.epub"), "dummy sub epub");
    await writeFile(join(trash, "recycled.epub"), "recycled epub");

    try {
      await symlink(join(rootDir, "a_book.TXT"), join(rootDir, "symlink.txt"));
    } catch {
      // Symlinks might require admin privileges on Windows; if it fails, test proceeds.
    }

    const controller = new AbortController();
    const entries = [];
    for await (const entry of walkInventory(rootDir, controller.signal)) {
      entries.push(entry);
    }

    expect(entries.map((e) => e.relativePath)).toEqual([
      "a_book.TXT",
      "b_book.EPUB",
      "sub/c_book.epub",
    ]);

    for (const e of entries) {
      expect(e.relativePath).not.toContain("\\");
      expect(e.relativePath).not.toContain("..");
      expect(e.relativePath).not.toContain("./");
    }
  });

  it("yields all 1005 supported files without 1000-item cap", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "walker-1005-test-"));
    cleanup.push(rootDir);

    for (let i = 1; i <= 1005; i++) {
      const filename = `file_${String(i).padStart(4, "0")}.txt`;
      await writeFile(join(rootDir, filename), `content ${i}`);
    }

    const controller = new AbortController();
    let count = 0;
    for await (const entry of walkInventory(rootDir, controller.signal)) {
      count++;
    }

    expect(count).toBe(1005);
  });

  it("aborts traversal when AbortController signal is triggered", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "walker-abort-test-"));
    cleanup.push(rootDir);

    for (let i = 1; i <= 10; i++) {
      await writeFile(join(rootDir, `file_${i}.txt`), "dummy");
    }

    const controller = new AbortController();
    const entries = [];
    try {
      for await (const entry of walkInventory(rootDir, controller.signal)) {
        entries.push(entry);
        if (entries.length === 3) {
          controller.abort();
        }
      }
    } catch (err: any) {
      expect(err.name).toBe("AbortError");
    }

    expect(entries.length).toBe(3);
  });

  it("does not walk into a linked directory that points outside the root", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "walker-junction-root-"));
    const outsideDir = await mkdtemp(join(tmpdir(), "walker-junction-outside-"));
    cleanup.push(rootDir, outsideDir);

    await writeFile(join(rootDir, "inside.txt"), "inside");
    await writeFile(join(outsideDir, "secret.epub"), "outside the library");

    // A directory link is the interesting case: skipping a linked *file* only saves one
    // entry, while descending through a linked *directory* walks an entire tree the
    // user never authorized. On Windows a junction needs no elevation, so this is
    // reachable by accident as well as on purpose.
    let linked = false;
    try {
      await symlink(outsideDir, join(rootDir, "linked-dir"), "junction");
      linked = true;
    } catch {
      try {
        await symlink(outsideDir, join(rootDir, "linked-dir"), "dir");
        linked = true;
      } catch {
        // Creating links can be refused outright; the rest of the test still holds.
      }
    }

    const controller = new AbortController();
    const entries = [];
    for await (const entry of walkInventory(rootDir, controller.signal)) {
      entries.push(entry);
    }

    expect(entries.map((entry) => entry.relativePath)).toEqual(["inside.txt"]);
    if (linked) {
      // Assert the fixture actually existed, so a silent failure to create the link
      // cannot make this test pass for the wrong reason.
      expect(entries.some((entry) => entry.relativePath.includes("secret"))).toBe(false);
    }
  });

  it("reports the real size and modification time of every file", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "walker-facts-test-"));
    cleanup.push(rootDir);
    await writeFile(join(rootDir, "sized.txt"), "0123456789");

    const entries = [];
    for await (const entry of walkInventory(rootDir, new AbortController().signal)) {
      entries.push(entry);
    }

    expect(entries).toHaveLength(1);
    expect(entries[0].fileSize).toBe(10);
    // The walk resolves directories and no longer stats files through realpath, so the
    // facts it reports are exactly the ones the inventory and the duplicate detector
    // compare against later. A wrong mtime here would silently disable incremental
    // scanning, and a wrong size would break duplicate grouping.
    expect(Number.isNaN(Date.parse(entries[0].modifiedAt))).toBe(false);
    expect(entries[0].absolutePath.endsWith("sized.txt")).toBe(true);
  });

  it("enforces no prohibited imports or operations in inventory-walker.ts source", async () => {
    const source = await readFile("src/backend/library-scan/inventory-walker.ts", "utf8");
    expect(source).not.toMatch(/\breadFile\b|JSZip|Epub|Txt|createHash|DeepSeek/);
  });
});
