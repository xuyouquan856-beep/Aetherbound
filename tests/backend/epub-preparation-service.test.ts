import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BookPreparationJobRepository } from "../../src/backend/library/book-preparation-job-repository.js";
import { COVER_THUMBNAIL_FILE, EpubPreparationService } from "../../src/backend/library/epub-preparation-service.js";
import { LibraryAdmissionService } from "../../src/backend/library/library-admission-service.js";
import { openDatabase, type OpenedDatabase } from "../../src/backend/storage/database.js";
import { prepareEpub } from "../../src/formats/epub/prepare.js";

let dataRoot = "";
let opened: OpenedDatabase | null = null;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "reader-epub-preparation-"));
  opened = openDatabase(dataRoot);
});

afterEach(async () => {
  opened?.close();
  opened = null;
  await rm(dataRoot, { recursive: true, force: true });
});

async function fixture(title = "Prepared Book") {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip");
  zip.file("META-INF/container.xml", `<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  zip.file("EPUB/package.opf", `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title><dc:creator>Aether Author</dc:creator></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`);
  zip.file("EPUB/nav.xhtml", `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml">Chapter One</a></li></ol></nav></body></html>`);
  zip.file("EPUB/chapter.xhtml", `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body onload="pwned()"><p>Story</p><img src="https://tracker.invalid/pixel"/><script>pwned()</script></body></html>`);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

/** Minimal 1x1 PNG, enough to satisfy the raster-cover signature check. */
const TINY_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

async function fixtureWithCover(title: string) {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip");
  zip.file("META-INF/container.xml", `<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  zip.file("EPUB/package.opf", `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title><dc:creator>Aether Author</dc:creator></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/><item id="c1" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`);
  zip.file("EPUB/nav.xhtml", `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml">Chapter One</a></li></ol></nav></body></html>`);
  zip.file("EPUB/chapter.xhtml", `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>Story</p></body></html>`);
  zip.file("EPUB/cover.png", TINY_PNG);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

async function admit(sourcePath: string) {
  const book = await new LibraryAdmissionService(opened!.db).admitEpub(sourcePath);
  const source = opened!.db.prepare(
    "SELECT source_revision FROM book_sources WHERE book_id = ?",
  ).get(book.id) as { source_revision: string };
  const jobs = new BookPreparationJobRepository(opened!.db);
  expect(jobs.markPreparing(
    book.id,
    source.source_revision,
    "2026-07-29T00:00:00.000Z",
  )).toBe(true);
  return { book, sourceRevision: source.source_revision };
}

describe("EpubPreparationService", () => {
  it("atomically commits sanitized publication assets, metadata, and the source hash", async () => {
    const sourcePath = join(dataRoot, "untrusted.epub");
    const bytes = await fixture();
    await writeFile(sourcePath, bytes);
    const admitted = await admit(sourcePath);
    const service = new EpubPreparationService(opened!.db, dataRoot);

    const result = await service.prepare(admitted.book.id, admitted.sourceRevision);

    expect(result.fullContentHash).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(result.book).toMatchObject({
      title: "Prepared Book",
      author: "Aether Author",
    });
    expect(result.publication.toc[0]).toMatchObject({ label: "Chapter One" });
    const finalDir = join(
      dataRoot,
      "publications",
      admitted.book.id,
      admitted.sourceRevision,
    );
    const prepared = await JSZip.loadAsync(await readFile(join(finalDir, "book.epub")));
    const chapter = await prepared.file("EPUB/chapter.xhtml")!.async("text");
    expect(chapter).not.toContain("<script");
    expect(chapter).not.toContain("onload");
    expect(chapter).not.toContain("https://tracker.invalid");
    expect(JSON.parse(await readFile(join(finalDir, "publication.json"), "utf8")))
      .toEqual(result.publication);
    expect(opened!.db.prepare(
      "SELECT full_content_hash FROM book_sources WHERE book_id = ?",
    ).get(admitted.book.id)).toEqual({ full_content_hash: result.fullContentHash });
  });

  it("refuses an obsolete revision and removes every obsolete staged asset", async () => {
    const sourcePath = join(dataRoot, "changed.epub");
    await writeFile(sourcePath, await fixture("Old Revision"));
    const admitted = await admit(sourcePath);
    const service = new EpubPreparationService(opened!.db, dataRoot, {
      prepareEpub: async (source, destination, signal) => {
        const result = await prepareEpub(source, destination, signal);
        opened!.db.prepare(
          "UPDATE book_sources SET source_revision = ? WHERE book_id = ?",
        ).run("replacement-revision", admitted.book.id);
        return result;
      },
    });

    await expect(
      service.prepare(admitted.book.id, admitted.sourceRevision),
    ).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    await expect(access(join(
      dataRoot,
      "publications",
      admitted.book.id,
      admitted.sourceRevision,
    ))).rejects.toThrow();
    expect(opened!.db.prepare("SELECT title FROM books WHERE id = ?").get(
      admitted.book.id,
    )).toEqual({ title: "changed" });
  });

  it("cleans partial staging data after a preparation failure", async () => {
    const sourcePath = join(dataRoot, "broken.epub");
    await writeFile(sourcePath, await fixture());
    const admitted = await admit(sourcePath);
    const service = new EpubPreparationService(opened!.db, dataRoot, {
      prepareEpub: async (_source, destination) => {
        await writeFile(destination, "incomplete");
        await writeFile(`${destination}.partial`, "partial");
        throw new Error("simulated write failure");
      },
    });

    await expect(
      service.prepare(admitted.book.id, admitted.sourceRevision),
    ).rejects.toMatchObject({ code: "INVALID_PACKAGE" });
    const publications = join(dataRoot, "publications");
    const remaining = await readdir(publications, { recursive: true }).catch(() => []);
    expect(remaining).toEqual([]);
  });

  it("does not add a second full-file hash pass to the preparation service", async () => {
    const sourceCode = await readFile(
      join(process.cwd(), "src/backend/library/epub-preparation-service.ts"),
      "utf8",
    );
    expect(sourceCode).not.toContain("fullContentHash(");
    expect(sourceCode).not.toContain("createReadStream(");
  });

  describe("cover thumbnails", () => {
    it("writes a downscaled thumbnail next to the full-size cover", async () => {
      const sourcePath = join(dataRoot, "with-cover.epub");
      await writeFile(sourcePath, await fixtureWithCover("Covered Book"));
      const admitted = await admit(sourcePath);
      const thumbnailBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
      let receivedMediaType = "";
      const service = new EpubPreparationService(opened!.db, dataRoot, {
        createCoverThumbnail: async (_bytes, mediaType) => {
          receivedMediaType = mediaType;
          return thumbnailBytes;
        },
      });

      await service.prepare(admitted.book.id, admitted.sourceRevision);

      const finalDir = join(dataRoot, "publications", admitted.book.id, admitted.sourceRevision);
      expect(new Uint8Array(await readFile(join(finalDir, COVER_THUMBNAIL_FILE))))
        .toEqual(thumbnailBytes);
      // The full-size cover is retained as the fallback.
      expect((await readFile(join(finalDir, "cover"))).byteLength).toBeGreaterThan(0);
      expect(receivedMediaType).toBe("image/png");
    });

    it("still commits the import when thumbnailing is unavailable", async () => {
      const sourcePath = join(dataRoot, "no-thumbnailer.epub");
      await writeFile(sourcePath, await fixtureWithCover("No Thumbnailer"));
      const admitted = await admit(sourcePath);
      // Default runtime: no thumbnailer injected at all.
      const service = new EpubPreparationService(opened!.db, dataRoot);

      await service.prepare(admitted.book.id, admitted.sourceRevision);

      const finalDir = join(dataRoot, "publications", admitted.book.id, admitted.sourceRevision);
      await expect(access(join(finalDir, COVER_THUMBNAIL_FILE))).rejects.toThrow();
      await expect(access(join(finalDir, "cover"))).resolves.toBeUndefined();
    });

    it("survives a thumbnailer that throws", async () => {
      const sourcePath = join(dataRoot, "throwing-thumbnailer.epub");
      await writeFile(sourcePath, await fixtureWithCover("Throwing"));
      const admitted = await admit(sourcePath);
      const service = new EpubPreparationService(opened!.db, dataRoot, {
        createCoverThumbnail: async () => {
          throw new Error("decoder exploded");
        },
      });

      await expect(
        service.prepare(admitted.book.id, admitted.sourceRevision),
      ).resolves.toMatchObject({ book: { title: "Throwing" } });
      const finalDir = join(dataRoot, "publications", admitted.book.id, admitted.sourceRevision);
      await expect(access(join(finalDir, "cover"))).resolves.toBeUndefined();
    });
  });
});
