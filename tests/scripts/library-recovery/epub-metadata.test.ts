import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractMetadataBatch,
  extractRecoveryMetadata,
} from "../../../scripts/library-recovery/epub-metadata.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(opf: string, containerPath = "EPUB/package.opf") {
  const root = await mkdtemp(join(tmpdir(), "recovery-metadata-"));
  roots.push(root);
  const path = join(root, "book.epub");
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip");
  zip.file("META-INF/container.xml", `<container><rootfiles><rootfile full-path="${containerPath}"/></rootfiles></container>`);
  if (!containerPath.includes("..")) zip.file(containerPath, opf);
  await writeFile(path, await zip.generateAsync({ type: "uint8array" }));
  return { root, path };
}

describe("recovery EPUB metadata", () => {
  it("extracts EPUB 3 collection metadata", async () => {
    const { path } = await fixture(`
      <package><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
        <dc:title>作品名 03</dc:title><dc:creator>作者</dc:creator>
        <dc:language>zh</dc:language><dc:identifier>id-3</dc:identifier>
        <dc:publisher>出版社</dc:publisher><dc:date>2026-01-01</dc:date>
        <meta id="series" property="belongs-to-collection">作品名</meta>
        <meta refines="#series" property="collection-type">series</meta>
        <meta refines="#series" property="group-position">3</meta>
      </metadata></package>`);

    await expect(extractRecoveryMetadata({
      absolutePath: path,
      relativePath: "book.epub",
    })).resolves.toMatchObject({
      title: "作品名 03",
      creator: "作者",
      language: "zh",
      series: "作品名",
      groupPosition: 3,
    });
  });

  it("extracts EPUB 2 calibre series metadata", async () => {
    const { path } = await fixture(`
      <package><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
        <dc:title>作品名 2</dc:title>
        <meta name="calibre:series" content="作品名"/>
        <meta name="calibre:series_index" content="2"/>
      </metadata></package>`);
    await expect(extractRecoveryMetadata({
      absolutePath: path,
      relativePath: "book.epub",
    })).resolves.toMatchObject({ series: "作品名", groupPosition: 2 });
  });

  it("rejects traversal and oversized OPF", async () => {
    const traversal = await fixture("<package/>", "../package.opf");
    await expect(extractRecoveryMetadata({
      absolutePath: traversal.path,
      relativePath: "book.epub",
    })).rejects.toThrow(/path/i);

    const oversized = await fixture(`<package><metadata><dc:title>${"x".repeat(5 * 1024 * 1024)}</dc:title></metadata></package>`);
    await expect(extractRecoveryMetadata({
      absolutePath: oversized.path,
      relativePath: "book.epub",
    })).rejects.toThrow(/5 MiB/i);
  });

  it("isolates broken EPUB errors in a batch", async () => {
    const valid = await fixture("<package><metadata><dc:title>正常书</dc:title></metadata></package>");
    await writeFile(join(valid.root, "broken.epub"), "not a zip");
    const result = await extractMetadataBatch({
      root: valid.root,
      manifest: [
        { inventoryVersion: 1, relativePath: "book.epub", extension: ".epub", fileSize: 1, modifiedAt: new Date().toISOString(), sha256: "a".repeat(64), parentFolder: "" },
        { inventoryVersion: 1, relativePath: "broken.epub", extension: ".epub", fileSize: 1, modifiedAt: new Date().toISOString(), sha256: "b".repeat(64), parentFolder: "" },
      ],
    });
    expect(result).toHaveLength(2);
    expect(result[0].ok).toBe(true);
    expect(result[1]).toMatchObject({ ok: false, errorCode: "INVALID_PACKAGE" });
  });
});
