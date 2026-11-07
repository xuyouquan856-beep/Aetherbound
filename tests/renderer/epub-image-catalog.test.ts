// @vitest-environment jsdom
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { openEpubImageCatalog } from "../../src/renderer/src/features/reader/epub-image-catalog.js";

async function sampleEpub() {
  const zip = new JSZip();
  zip.file("META-INF/container.xml", '<container><rootfiles><rootfile full-path="EPUB/package.opf" /></rootfiles></container>');
  zip.file("EPUB/package.opf", `<?xml version="1.0"?>
    <package><metadata><meta name="cover" content="jacket" /></metadata><manifest>
      <item id="chapter" href="Text/chapter.xhtml" media-type="application/xhtml+xml" />
      <item id="jacket" href="Images/cover.png" media-type="image/png" />
      <item id="illustration" href="Images/scene%201.jpg" media-type="image/jpeg" />
      <item id="decoration" href="Images/decor.svg" media-type="image/svg+xml" />
      <item id="duplicate" href="Images/cover.png" media-type="image/png" />
    </manifest><spine><itemref idref="chapter" /></spine></package>`);
  zip.file("EPUB/Images/cover.png", new Uint8Array([137, 80, 78, 71]));
  zip.file("EPUB/Images/scene 1.jpg", new Uint8Array([255, 216, 255]));
  zip.file("EPUB/Images/decor.svg", "<svg/>");
  return zip.generateAsync({ type: "uint8array" });
}

describe("EPUB image catalog", () => {
  it("lists the cover first, deduplicates resources, and reads only local raster images", async () => {
    const catalog = await openEpubImageCatalog(await sampleEpub());
    expect(catalog.images.map((image) => ({ label: image.label, href: image.href }))).toEqual([
      { label: "封面", href: "EPUB/Images/cover.png" },
      { label: "插图 1", href: "EPUB/Images/scene 1.jpg" },
    ]);
    expect(await catalog.readImage(catalog.images[1]!)).toEqual(new Uint8Array([255, 216, 255]));
  });

  it("ignores external image references while keeping local images available", async () => {
    const zip = new JSZip();
    zip.file("META-INF/container.xml", '<container><rootfile full-path="book.opf" /></container>');
    zip.file("book.opf", '<package><manifest><item id="bad" href="https://example.com/a.png" media-type="image/png" /><item id="good" href="local.png" media-type="image/png" /></manifest></package>');
    zip.file("local.png", new Uint8Array([137, 80, 78, 71]));
    const catalog = await openEpubImageCatalog(await zip.generateAsync({ type: "uint8array" }));
    expect(catalog.images.map((image) => image.href)).toEqual(["local.png"]);
  });
});
