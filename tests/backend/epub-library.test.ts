import { existsSync } from "node:fs";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LibraryService } from "../../src/backend/library/library-service.js";
import { COVER_THUMBNAIL_FILE } from "../../src/backend/library/epub-preparation-service.js";
import { BookSummarySchema } from "../../src/shared/contracts.js";
import { openDatabase } from "../../src/backend/storage/database.js";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function fixture(title = "安全书") {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip");
  zip.file("META-INF/container.xml", `<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  zip.file("EPUB/package.opf", `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title><dc:creator>作者</dc:creator></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`);
  zip.file("EPUB/nav.xhtml", `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml">第一章</a></li></ol></nav></body></html>`);
  zip.file("EPUB/chapter.xhtml", `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1>第一章</h1><p>正文</p><script>pwned()</script></body></html>`);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** A tiny but valid-looking PNG, enough for a thumbnailer stub to return. */
const TINY_PNG_LIKE = new Uint8Array([...PNG_SIGNATURE, 1, 2, 3]);

async function fixtureWithCover() {
  const zip = await JSZip.loadAsync(await fixture("封面书"));
  const opf = await zip.file("EPUB/package.opf")!.async("text");
  zip.file("EPUB/package.opf", opf.replace("</manifest>", '<item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/></manifest>'));
  zip.file("EPUB/cover.png", PNG_SIGNATURE);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "reader-epub-library-"));
  cleanup.push(root);
  const opened = openDatabase(root);
  return { root, opened, service: new LibraryService(opened.db, root) };
}

describe("EPUB library import", () => {
  it("prepares before committing and returns a path-free EPUB summary/publication", async () => {
    const { root, opened, service } = await setup();
    const source = join(root, "source.epub");
    await writeFile(source, await fixture());
    const book = await service.importEpub(source);
    const publication = await service.readPublication(book.id);
    const sourceRecord = service.getSourceForBook(book.id);
    const prepared = service.getPreparedEpubPath(book.id, sourceRecord.sourceRevision);
    await expect(access(prepared!)).resolves.toBeUndefined();
    expect(book).toMatchObject({ format: "epub", title: "安全书", author: "作者" });
    expect(publication.toc[0]).toMatchObject({ label: "第一章" });
    expect(JSON.stringify({ book, publication })).not.toContain(source);
    const zip = await JSZip.loadAsync(await readFile(prepared!));
    expect(await zip.file("EPUB/chapter.xhtml")!.async("text")).not.toContain("<script");
    opened.close();
  });

  it("persists sanitized publication metadata and reuses it on ordinary open", async () => {
    const { root, opened, service } = await setup();
    const source = join(root, "cached-publication.epub");
    await writeFile(source, await fixture("缓存书"));
    const book = await service.importEpub(source);
    const publication = await service.readPublication(book.id);
    const metadataPath = join(
      root,
      "publications",
      book.id,
      publication.sourceRevision,
      "publication.json",
    );

    expect(JSON.parse(await readFile(metadataPath, "utf8"))).toEqual(publication);
    expect(await readFile(metadataPath, "utf8")).not.toContain(source);
    await expect(service.readPublication(book.id)).resolves.toEqual(publication);
    opened.close();
  });

  it("repairs a missing publication metadata sidecar once from the prepared EPUB", async () => {
    const { root, opened, service } = await setup();
    const source = join(root, "legacy-cache.epub");
    await writeFile(source, await fixture("旧缓存书"));
    const book = await service.importEpub(source);
    const revision = service.getSourceForBook(book.id).sourceRevision;
    const metadataPath = join(root, "publications", book.id, revision, "publication.json");
    await rm(metadataPath, { force: true });

    const publication = await service.readPublication(book.id);

    expect(JSON.parse(await readFile(metadataPath, "utf8"))).toEqual(publication);
    opened.close();
  });

  it("stores a safe cover beside the prepared EPUB and returns only a controlled URL", async () => {
    const { root, opened, service } = await setup();
    const source = join(root, "covered.epub");
    await writeFile(source, await fixtureWithCover());
    const book = await service.importEpub(source);
    const revision = service.getSourceForBook(book.id).sourceRevision;
    const cover = service.getPreparedPublicationPath(book.id, revision, "cover");

    expect(book.coverUrl).toBe(`reader-resource://publication/${book.id}/${revision}/cover`);
    await expect(readFile(cover!)).resolves.toEqual(Buffer.from(PNG_SIGNATURE));
    expect(JSON.stringify(book)).not.toContain(source);
    opened.close();
  });

  it("returns a cover URL that the shared contract accepts", async () => {
    // Regression guard: presentBook once emitted a resource name that the shared
    // ControlledCoverUrlSchema rejected. That failed the WHOLE library:list
    // response, which the UI could only render as a blank window.
    const root = await mkdtemp(join(tmpdir(), "reader-epub-contract-library-"));
    cleanup.push(root);
    const opened = openDatabase(root);
    const service = new LibraryService(opened.db, root, async () => TINY_PNG_LIKE);

    const source = join(root, "covered.epub");
    await writeFile(source, await fixtureWithCover());
    const book = await service.importEpub(source);

    expect(book.coverUrl).toBeTruthy();
    // The IPC handler validates the whole array with BookSummarySchema, so every
    // produced summary must satisfy it.
    expect(() => BookSummarySchema.parse(book)).not.toThrow();
    const listed = (await service.listBooks()).find((item) => item.id === book.id);
    expect(() => BookSummarySchema.parse(listed)).not.toThrow();
    opened.close();
  });

  it("prefers the downscaled thumbnail URL when a thumbnailer is available", async () => {
    const root = await mkdtemp(join(tmpdir(), "reader-epub-thumb-library-"));
    cleanup.push(root);
    const opened = openDatabase(root);
    const thumbnail = new Uint8Array([...PNG_SIGNATURE, 9, 9, 9]);
    let sawMediaType = "";
    const service = new LibraryService(opened.db, root, async (_bytes, mediaType) => {
      sawMediaType = mediaType;
      return thumbnail;
    });

    const source = join(root, "covered.epub");
    await writeFile(source, await fixtureWithCover());
    const book = await service.importEpub(source);
    const revision = service.getSourceForBook(book.id).sourceRevision;

    // The large source cover is kept for fallback, and the small one is preferred.
    expect(book.coverUrl).toBe(
      `reader-resource://publication/${book.id}/${revision}/${COVER_THUMBNAIL_FILE}`,
    );
    expect(sawMediaType).toBe("image/png");
    await expect(readFile(
      service.getPreparedPublicationPath(book.id, revision, "cover-thumb")!,
    )).resolves.toEqual(Buffer.from(thumbnail));
    await expect(readFile(
      service.getPreparedPublicationPath(book.id, revision, "cover")!,
    )).resolves.toEqual(Buffer.from(PNG_SIGNATURE));

    // Listing books resolves the same controlled URL.
    const listed = (await service.listBooks()).find((item) => item.id === book.id);
    expect(listed?.coverUrl).toBe(book.coverUrl);
    opened.close();
  });

  it("falls back to the full cover when thumbnailing produced nothing", async () => {
    const root = await mkdtemp(join(tmpdir(), "reader-epub-nothumb-library-"));
    cleanup.push(root);
    const opened = openDatabase(root);
    const service = new LibraryService(opened.db, root, async () => null);

    const source = join(root, "covered.epub");
    await writeFile(source, await fixtureWithCover());
    const book = await service.importEpub(source);
    const revision = service.getSourceForBook(book.id).sourceRevision;

    expect(book.coverUrl).toBe(`reader-resource://publication/${book.id}/${revision}/cover`);
    opened.close();
  });

  it("never serves a stale shelf after an import", async () => {
    const { root, opened, service } = await setup();
    // Concurrent listBooks() calls are coalesced; the result must still be dropped
    // once a new book is imported, or the shelf would omit it.
    expect(await service.listBooks()).toHaveLength(0);

    const source = join(root, "added.epub");
    await writeFile(source, await fixture("新书"));
    await service.importEpub(source);

    const afterImport = await service.listBooks();
    expect(afterImport.map((item) => item.title)).toContain("新书");
    opened.close();
  });

  it("drops the coalesced shelf when a book is removed", async () => {
    const { root, opened, service } = await setup();
    const source = join(root, "removable.epub");
    await writeFile(source, await fixture("将被移除"));
    const book = await service.importEpub(source);
    expect(await service.listBooks()).toHaveLength(1);

    await service.removeBooks([book.id]);
    expect(await service.listBooks()).toHaveLength(0);
    await vi.waitFor(() => expect(existsSync(join(root, "publications", book.id))).toBe(false),
      { timeout: 10_000, interval: 50 });
    opened.close();
  });

  it("deduplicates identical content and refreshes a changed known source", async () => {
    const { root, opened, service } = await setup();
    const firstPath = join(root, "one.epub");
    const movedPath = join(root, "two.epub");
    const bytes = await fixture();
    await writeFile(firstPath, bytes);
    await writeFile(movedPath, bytes);
    const first = await service.importEpub(firstPath);
    expect((await service.importEpub(movedPath)).id).toBe(first.id);
    const firstRevision = service.getSourceForBook(first.id).sourceRevision;
    await writeFile(movedPath, await fixture("修订书"));
    await service.importEpub(movedPath);
    expect(service.getSourceForBook(first.id).sourceRevision).not.toBe(firstRevision);
    expect((await service.readPublication(first.id)).metadata.title).toBe("修订书");
    opened.close();
  });

  it("keeps a retryable error summary but leaves no prepared cache after an invalid package", async () => {
    const { root, opened, service } = await setup();
    const source = join(root, "bad.epub");
    await writeFile(source, "not a zip", "utf8");
    await expect(service.importEpub(source)).rejects.toMatchObject({ code: "INVALID_PACKAGE" });
    expect(await service.listBooks()).toEqual([
      expect.objectContaining({
        title: "bad",
        preparationStatus: "error",
        preparationErrorCode: "INVALID_PACKAGE",
      }),
    ]);
    expect(await readdir(join(root, "publications"), { recursive: true })).toEqual([]);
    opened.close();
  });
  it("rebuilds a missing prepared cache instead of returning a stale summary", async () => {
    const { root, opened, service } = await setup();
    const source = join(root, "self-heal.epub");
    await writeFile(source, await fixture());
    const first = await service.importEpub(source);
    const firstRevision = service.getSourceForBook(first.id).sourceRevision;
    await rm(service.getPreparedEpubPath(first.id, firstRevision)!);

    const again = await service.importEpub(source);
    const nextRevision = service.getSourceForBook(first.id).sourceRevision;
    expect(again.id).toBe(first.id);
    expect(nextRevision).not.toBe(firstRevision);
    await expect(access(service.getPreparedEpubPath(first.id, nextRevision)!)).resolves.toBeUndefined();
    opened.close();
  });

  it("refreshes the book already owning a path when its bytes match another book", async () => {
    const { root, opened, service } = await setup();
    const firstPath = join(root, "first.epub");
    const secondPath = join(root, "second.epub");
    await writeFile(firstPath, await fixture("第一本"));
    await writeFile(secondPath, await fixture("第二本"));
    const first = await service.importEpub(firstPath);
    const second = await service.importEpub(secondPath);

    await writeFile(firstPath, await fixture("第二本"));
    const refreshed = await service.importEpub(firstPath);

    expect(refreshed).toMatchObject({ id: first.id, title: "第二本" });
    expect(service.getSourceForBook(first.id).sourcePath).toBe(firstPath);
    expect(service.getSourceForBook(second.id).sourcePath).toBe(secondPath);
    expect(await service.listBooks()).toHaveLength(2);
    opened.close();
  });

});
