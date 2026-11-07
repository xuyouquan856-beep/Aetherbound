import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { LibraryService } from "../../src/backend/library/library-service.js";
import { LibraryAdmissionService } from "../../src/backend/library/library-admission-service.js";
import { BookPreparationCoordinator } from "../../src/backend/library/book-preparation-coordinator.js";
import { BookPreparationJobRepository } from "../../src/backend/library/book-preparation-job-repository.js";
import { EpubPreparationService } from "../../src/backend/library/epub-preparation-service.js";
import { openDatabase } from "../../src/backend/storage/database.js";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** An EPUB with a declared cover, small enough to build inline. */
async function coverEpub(title: string) {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip");
  zip.file("META-INF/container.xml", `<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  zip.file("EPUB/package.opf", `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title><dc:creator>作者</dc:creator></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/><item id="c1" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`);
  zip.file("EPUB/nav.xhtml", `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml">第一章</a></li></ol></nav></body></html>`);
  zip.file("EPUB/chapter.xhtml", `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1>第一章</h1><p>正文</p></body></html>`);
  zip.file("EPUB/cover.png", PNG_SIGNATURE);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

/**
 * The cover of a freshly imported EPUB.
 *
 * In the app, importing an EPUB admits the book and queues preparation: the shelf is
 * listed, and painted, well before the cover exists. `presentBook` memoises resolved
 * cover URLs to avoid two SQLite lookups plus an existsSync per book per list, and the
 * first version of that memo also remembered the *miss*. The result was that a book
 * imported in the running app never showed its cover — the "no cover yet" answer was
 * computed while preparation was queued and outlived it — while a book imported before
 * launch was fine, which is exactly the shape of failure that a restart appears to fix.
 */
describe("cover resolution across background preparation", () => {
  async function setup() {
    const root = await mkdtemp(join(tmpdir(), "reader-cover-cache-"));
    cleanup.push(root);
    const opened = openDatabase(root);
    const library = new LibraryService(opened.db, root, async () => null);
    const admission = new LibraryAdmissionService(opened.db);
    const jobs = new BookPreparationJobRepository(opened.db);
    const coordinator = new BookPreparationCoordinator(
      jobs,
      new EpubPreparationService(opened.db, root, { createCoverThumbnail: async () => null }),
    );
    return { root, opened, library, admission, coordinator };
  }

  it("shows the cover once background preparation finishes", async () => {
    const { root, opened, library, admission, coordinator } = await setup();
    try {
      const source = join(root, "background.epub");
      await writeFile(source, await coverEpub("后台准备书"));

      // Import the way the app does: admit, then let the coordinator prepare later.
      const admitted = await admission.admitEpub(source);
      expect(admitted.preparationStatus).toBe("queued");

      const whileQueued = (await library.listBooks()).find((book) => book.id === admitted.id);
      expect(whileQueued?.coverUrl ?? null).toBeNull();

      await coordinator.ensureReady(admitted.id);

      const afterReady = (await library.listBooks()).find((book) => book.id === admitted.id);
      expect(afterReady?.preparationStatus).toBe("ready");
      expect(afterReady?.coverUrl).toBe(
        `reader-resource://publication/${admitted.id}/${library.getSourceForBook(admitted.id).sourceRevision}/cover`,
      );
    } finally {
      await coordinator.stop();
      opened.close();
    }
  });

  it("re-resolves the cover when the book is re-prepared from a new revision", async () => {
    const { root, opened, library, admission, coordinator } = await setup();
    try {
      const source = join(root, "revised.epub");
      await writeFile(source, await coverEpub("改版书"));

      const first = await admission.admitEpub(source);
      await coordinator.ensureReady(first.id);
      const originalRevision = library.getSourceForBook(first.id).sourceRevision;
      const covered = (await library.listBooks()).find((book) => book.id === first.id);
      expect(covered?.coverUrl).toContain(originalRevision);

      // A second source file for the same book produces a new revision, and the URL has
      // to follow it: the published files live under the revision directory, so a
      // memoised URL from the previous one would 404.
      const replacement = join(root, "revised-v2.epub");
      await writeFile(replacement, await coverEpub("改版书"));
      await admission.admitEpub(replacement, first.id);
      await coordinator.ensureReady(first.id);

      const newRevision = library.getSourceForBook(first.id).sourceRevision;
      expect(newRevision).not.toBe(originalRevision);
      const after = (await library.listBooks()).find((book) => book.id === first.id);
      expect(after?.coverUrl).toBe(
        `reader-resource://publication/${first.id}/${newRevision}/cover`,
      );
    } finally {
      await coordinator.stop();
      opened.close();
    }
  });
});
