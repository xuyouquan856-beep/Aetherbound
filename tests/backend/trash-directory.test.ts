import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TrashBinService } from "../../src/backend/library/trash-service.js";
import {
  TRASH_DIRECTORY_NAME,
  hasTrashDirectorySegment,
  isInTrashDirectory,
} from "../../src/backend/storage/trash-directory.js";
import { QUARANTINE_DIR_NAME } from "../../src/backend/library-scan/recycle-file.js";
import { openDatabase } from "../../src/backend/storage/database.js";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("trash directory naming", () => {
  it("is defined once and shared by both trash mechanisms", () => {
    // The scanner once skipped `.aetherbound-trash` while quarantining into
    // `.aether-trash`. Two independent strings is how that happened, so there is now
    // exactly one.
    expect(QUARANTINE_DIR_NAME).toBe(TRASH_DIRECTORY_NAME);
  });

  it("recognises the trash directory and its contents", () => {
    const root = join("E:", "books");
    expect(isInTrashDirectory(root, join(root, TRASH_DIRECTORY_NAME))).toBe(true);
    expect(isInTrashDirectory(root, join(root, TRASH_DIRECTORY_NAME, "a.epub"))).toBe(true);
    expect(isInTrashDirectory(root, join(root, "novels", "a.epub"))).toBe(false);
  });

  it("does not treat a user folder that merely contains the name as the trash", () => {
    const root = join("E:", "books");
    // `includes(".aether-trash")` said yes to all of these, so a book in a folder the
    // user legitimately named could never be removed.
    expect(isInTrashDirectory(root, join(root, "my.aether-trash-notes", "a.epub"))).toBe(false);
    expect(hasTrashDirectorySegment(join(root, "my.aether-trash-notes", "a.epub"))).toBe(false);
    expect(hasTrashDirectorySegment(join(root, "aether-trash-backup"))).toBe(false);
    expect(hasTrashDirectorySegment(join(root, TRASH_DIRECTORY_NAME, "a.epub"))).toBe(true);
  });
});

describe("library trash path boundary", () => {
  async function setup() {
    const root = await mkdtemp(join(tmpdir(), "reader-trash-boundary-"));
    cleanup.push(root);
    const opened = openDatabase(join(root, "data"));
    return { root, opened, service: new TrashBinService(opened.db, root) };
  }

  it("refuses a path on another drive", async () => {
    const { root, opened, service } = await setup();
    // `path.relative("E:\\root", "D:\\evil.txt")` returns the absolute target, which
    // does not start with ".." — so a containment check built only on `..` accepts it.
    const foreign = resolve(`${process.platform === "win32" ? "D:" : "/"}/evil.txt`);
    await expect(service.trashFile(root, foreign)).rejects.toThrow("路径不在授权根目录内");
    opened.close();
  });

  it("refuses a path that escapes the root", async () => {
    const { root, opened, service } = await setup();
    await expect(service.trashFile(root, join(root, "..", "outside.txt")))
      .rejects.toThrow("路径不在授权根目录内");
    opened.close();
  });

  it("accepts a book inside a folder whose name merely looks like the trash", async () => {
    const { root, opened, service } = await setup();
    const folder = join(root, "my.aether-trash-notes");
    await mkdir(folder, { recursive: true });
    const book = join(folder, "a.txt");
    await writeFile(book, "content");

    const record = await service.trashFile(root, book);

    expect(record.originalPath).toBe(resolve(book));
    expect(hasTrashDirectorySegment(record.trashPath)).toBe(true);
    opened.close();
  });

  it("still refuses a path inside the real trash directory", async () => {
    const { root, opened, service } = await setup();
    const inside = join(root, TRASH_DIRECTORY_NAME, "already-trashed.txt");
    await mkdir(join(root, TRASH_DIRECTORY_NAME), { recursive: true });
    await writeFile(inside, "content");

    await expect(service.trashFile(root, inside)).rejects.toThrow("不能操作回收站内文件");
    opened.close();
  });
});
