import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LibraryService } from "../../src/backend/library/library-service.js";
import { openDatabase } from "../../src/backend/storage/database.js";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("external source refresh", () => {
  it("creates a new revision when a source changes outside the reader", async () => {
    const root = await mkdtemp(join(tmpdir(), "reader-source-refresh-"));
    cleanup.push(root);
    const opened = openDatabase(root);
    const library = new LibraryService(opened.db);
    const source = join(root, "book.txt");
    await writeFile(source, "Book\n\n# Chapter 1\nOld text\n# Chapter 2\nEnd", "utf8");
    const book = await library.importTxt(source);
    const oldRevision = library.getSourceForBook(book.id).sourceRevision;
    expect(await library.isSourceCurrent(book.id, oldRevision)).toBe(true);
    expect(await library.isSourceCurrent(book.id, "wrong-revision")).toBe(false);

    await writeFile(source, "Book\n\n# Chapter 1\nNew external text\n# Chapter 2\nEnd", "utf8");
    expect(await library.isSourceCurrent(book.id, oldRevision)).toBe(false);
    await library.readDocument(book.id);

    expect(library.getSourceForBook(book.id).sourceRevision).not.toBe(oldRevision);
    opened.close();
  });
});
