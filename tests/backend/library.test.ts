import { mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LibraryService } from "../../src/backend/library/library-service.js";
import { openDatabase } from "../../src/backend/storage/database.js";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "reader-library-"));
  cleanup.push(root);
  const opened = openDatabase(root);
  const service = new LibraryService(opened.db);
  return { root, opened, service };
}

describe("TXT library import", () => {
  it("removes application records while preserving the original source file", async () => {
    const { root, opened, service } = await setup();
    const source = join(root, "removable.txt");
    await writeFile(source, "可移出的书\n\n# 第一章\n正文", "utf8");
    const book = await service.importTxt(source);
    const revision = service.getSourceForBook(book.id).sourceRevision;
    const now = new Date().toISOString();
    const location = {
      locatorVersion: 1,
      sourceRevision: revision,
      format: "txt",
      primary: { kind: "txt", chapterId: "chapter-0", characterOffset: 3 },
      progression: { resource: 0.2, total: 0.2 },
      text: { exact: "正文", prefix: "", suffix: "" },
    };
    opened.db.prepare("INSERT INTO reading_progress VALUES (?,1,?,?,?)")
      .run(book.id, JSON.stringify(location), revision, now);
    opened.db.prepare("INSERT INTO reading_sessions VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run("session-1", book.id, revision, "closed", now, now, now, null, null, null);

    await expect(service.removeBooks([book.id, "missing-book"])).resolves.toEqual({ removed: 1 });

    expect(opened.db.prepare("SELECT COUNT(*) AS count FROM books").get()).toEqual({ count: 0 });
    expect(opened.db.prepare("SELECT COUNT(*) AS count FROM book_sources").get()).toEqual({ count: 0 });
    expect(opened.db.prepare("SELECT COUNT(*) AS count FROM reading_progress").get()).toEqual({ count: 0 });
    expect(opened.db.prepare("SELECT COUNT(*) AS count FROM reading_sessions").get()).toEqual({ count: 0 });
    expect((await stat(source)).isFile()).toBe(true);
    opened.close();
  });

  it("moves the original file to the recycle bin only when requested", async () => {
    const { root, opened, service } = await setup();
    const source = join(root, "remove-original.txt");
    const recycled = join(root, "recycled.txt");
    await writeFile(source, "要删除的书\n正文", "utf8");
    const imported = await service.importTxt(source);

    const result = await service.removeBooks([imported.id], {
      deleteOriginal: true,
      moveToTrash: async (path) => { expect(path).toBe(source); await rename(path, recycled); },
    });
    expect(result).toEqual({ removed: 1 });
    await expect(stat(source)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(recycled)).isFile()).toBe(true);
    expect(opened.db.prepare("SELECT COUNT(*) AS count FROM books").get()).toEqual({ count: 0 });
    opened.close();
  });

  it("keeps the book when the original file cannot be moved to the recycle bin", async () => {
    const { root, opened, service } = await setup();
    const source = join(root, "keep-original.txt");
    await writeFile(source, "保留的书\n正文", "utf8");
    const imported = await service.importTxt(source);

    await expect(service.removeBooks([imported.id], {
      deleteOriginal: true,
      moveToTrash: async () => { throw new Error("recycle bin unavailable"); },
    })).resolves.toEqual({ removed: 0, failedToDelete: 1 });
    expect((await stat(source)).isFile()).toBe(true);
    expect(opened.db.prepare("SELECT COUNT(*) AS count FROM books").get()).toEqual({ count: 1 });
    opened.close();
  });

  it("imports atomically and never returns a source path", async () => {
    const { root, opened, service } = await setup();
    const source = join(root, "book.txt");
    await writeFile(source, "书名\n作者[https://example.invalid]\n\n# 第1话 开始\n正文\n# 第2话 继续\n正文", "utf8");
    const imported = await service.importTxt(source);
    expect(imported.title).toBe("书名");
    expect(imported.author).toBe("作者");
    expect(JSON.stringify(imported)).not.toContain(source);
    expect(await service.listBooks()).toHaveLength(1);
    opened.close();
  });

  it("reuses a logical book when identical content is moved", async () => {
    const { root, opened, service } = await setup();
    const firstPath = join(root, "one.txt");
    const movedPath = join(root, "two.txt");
    await writeFile(firstPath, "书名\n\n正文", "utf8");
    await writeFile(movedPath, await readFile(firstPath));
    const first = await service.importTxt(firstPath);
    const second = await service.importTxt(movedPath);
    expect(second.id).toBe(first.id);
    expect(await service.listBooks()).toHaveLength(1);
    opened.close();
  });

  it("creates a new source revision when a known path changes", async () => {
    const { root, opened, service } = await setup();
    const source = join(root, "book.txt");
    await writeFile(source, "书名\n\n正文", "utf8");
    const book = await service.importTxt(source);
    const firstRevision = service.getSourceForBook(book.id).sourceRevision;
    await writeFile(source, "书名\n\n正文已改变", "utf8");
    await service.importTxt(source);
    expect(service.getSourceForBook(book.id).sourceRevision).not.toBe(firstRevision);
    opened.close();
  });

  it("leaves no rows after an invalid binary import", async () => {
    const { root, opened, service } = await setup();
    const source = join(root, "bad.txt");
    await writeFile(source, Buffer.from([0, 1, 0, 2, 0, 3, 0, 4]));
    await expect(service.importTxt(source)).rejects.toThrow(/TXT_ENCODING_UNCERTAIN/);
    expect(await service.listBooks()).toEqual([]);
    opened.close();
  });
});
