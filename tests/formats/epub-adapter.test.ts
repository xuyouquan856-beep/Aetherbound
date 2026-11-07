import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import { EpubBookFormatAdapter } from "../../src/formats/epub/adapter.js";
import { prepareEpubBytes } from "../../src/formats/epub/prepare.js";
import { MAX_EPUB_COVER_BYTES } from "../../src/formats/epub/cover.js";

async function epub(version: 2 | 3) {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip");
  zip.file("META-INF/container.xml", `<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  zip.file("EPUB/package.opf", version === 3
    ? `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>三号书</dc:title><dc:creator>作者甲</dc:creator><dc:language>zh-CN</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2" linear="no"/></spine></package>`
    : `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>二号书</dc:title><dc:creator>作者乙</dc:creator><dc:language>zh</dc:language></metadata><manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/></manifest><spine toc="ncx"><itemref idref="c1"/></spine></package>`);
  zip.file("EPUB/text/ch1.xhtml", `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1>第一章</h1><p>第一段正文。</p></body></html>`);
  if (version === 3) {
    zip.file("EPUB/text/ch2.xhtml", `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1>第二章</h1><p>第二段正文。</p></body></html>`);
    zip.file("EPUB/nav.xhtml", `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="text/ch1.xhtml">第一章</a><ol><li><a href="text/ch2.xhtml#target">第二章</a></li></ol></li></ol></nav></body></html>`);
  } else {
    zip.file("EPUB/toc.ncx", `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap><navPoint id="n1"><navLabel><text>第一章</text></navLabel><content src="text/ch1.xhtml"/></navPoint></navMap></ncx>`);
  }
  const raw = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  return (await prepareEpubBytes(raw)).bytes;
}
async function epubWithCover(
  version: 2 | 3,
  coverBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
) {
  const zip = await JSZip.loadAsync(await epub(version));
  const opf = await zip.file("EPUB/package.opf")!.async("text");
  const coverItem = version === 3
    ? '<item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/>'
    : '<item id="cover" href="cover.png" media-type="image/png"/>';
  const withManifest = opf.replace("</manifest>", `${coverItem}</manifest>`);
  zip.file("EPUB/package.opf", version === 3
    ? withManifest
    : withManifest.replace("</metadata>", '<meta name="cover" content="cover"/></metadata>'));
  zip.file("EPUB/cover.png", coverBytes, { compression: "STORE" });
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}


async function epubWithUnreadableSpine() {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip");
  zip.file("META-INF/container.xml", `<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  zip.file("EPUB/package.opf", `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>懒加载验证</dc:title></metadata><manifest><item id="c1" href="broken.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`);
  zip.file("EPUB/broken.xhtml", new Uint8Array([0xff, 0xfe, 0xfd, 0xfc]));
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

describe.each([2, 3] as const)("EPUB %i BookFormatAdapter", (version) => {
  it("returns serializable metadata, spine, nested TOC and independent text units", async () => {
    const bytes = await epub(version);
    const adapter = new EpubBookFormatAdapter(async (source) => source.sourceRevision === "rev-1" ? bytes : null);
    const opened = await adapter.openSource({ bookId: "book-1", sourceRevision: "rev-1" });
    expect(opened, opened.ok ? undefined : opened.detail).toMatchObject({ ok: true, value: { bookId: "book-1", sourceRevision: "rev-1" } });
    expect(await adapter.readMetadata()).toMatchObject({ ok: true, value: { title: version === 3 ? "三号书" : "二号书" } });
    expect(await adapter.readToc()).toMatchObject({ ok: true, value: [expect.objectContaining({ label: "第一章" })] });
    if (version === 3 && opened.ok) expect(opened.value.toc[0]?.children[0]).toMatchObject({ href: "EPUB/text/ch2.xhtml#target" });
    if (opened.ok) expect(opened.value.spine).toEqual(expect.arrayContaining([expect.objectContaining({ href: "EPUB/text/ch1.xhtml" })]));
    const units = [];
    for await (const unit of adapter.extractTextUnits()) units.push(unit);
    expect(await adapter.readCover()).toEqual({ ok: true, value: null });
    expect(units[0]).toMatchObject({ spineIndex: 0, spineHref: "EPUB/text/ch1.xhtml", text: expect.stringContaining("第一段正文") });
    await adapter.close();
    expect(await adapter.readMetadata()).toMatchObject({ ok: false, code: "INVALID_PACKAGE" });
  });
  it("selects the version-specific raster cover convention", async () => {
    const adapter = new EpubBookFormatAdapter(async () => epubWithCover(version));
    expect(await adapter.openSource({ bookId: "covered", sourceRevision: "cover-rev" })).toMatchObject({ ok: true });
    expect(await adapter.readCover()).toMatchObject({
      ok: true,
      value: { mediaType: "image/png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
    });
  });

});
describe("EPUB cover budget integration", () => {
  it("rejects an oversized cover from ZIP metadata before inflating it", async () => {
    const coverBytes = new Uint8Array(MAX_EPUB_COVER_BYTES + 1);
    coverBytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const bytes = await epubWithCover(3, coverBytes);
    const adapter = new EpubBookFormatAdapter(async () => bytes);
    expect(await adapter.openSource({ bookId: "large-cover", sourceRevision: "large-rev" })).toMatchObject({ ok: true });

    const inspection = await JSZip.loadAsync(bytes);
    const prototype = Object.getPrototypeOf(inspection.file("EPUB/cover.png")!);
    const inflate = vi.spyOn(prototype, "async").mockRejectedValue(new Error("cover body must not be inflated"));
    try {
      expect(await adapter.readCover()).toMatchObject({ ok: false, code: "ARCHIVE_LIMIT" });
      expect(inflate).not.toHaveBeenCalled();
    } finally {
      inflate.mockRestore();
    }
  });
});


describe("EPUB adapter errors", () => {
  it("opens structure without inflating spine text until extraction is requested", async () => {
    const adapter = new EpubBookFormatAdapter(async () => epubWithUnreadableSpine());
    const opened = await adapter.openSource({ bookId: "book-lazy", sourceRevision: "rev-lazy" });

    expect(opened).toMatchObject({ ok: true, value: { metadata: { title: "懒加载验证" } } });

    const read = async () => {
      for await (const _unit of adapter.extractTextUnits()) {
        // The invalid body must only be touched by this explicit extraction pass.
      }
    };
    await expect(read()).rejects.toThrow("Invalid publication XML");
  });

  it("returns SOURCE_CHANGED when the path-free source handle no longer resolves", async () => {
    const adapter = new EpubBookFormatAdapter(async () => null);
    expect(await adapter.openSource({ bookId: "missing", sourceRevision: "stale" }))
      .toEqual({ ok: false, code: "SOURCE_CHANGED" });
  });
});
