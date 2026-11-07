import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import JSZip from "jszip";
import {
  diffCorpusManifests,
  runReaderCoreSmoke,
  type ReaderCorpusFact,
} from "../../scripts/corpus-smoke.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function createMinimalEpub(path: string) {
  const epub = new JSZip();
  epub.file("mimetype", "application/epub+zip");
  epub.file(
    "META-INF/container.xml",
    `<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
  );
  epub.file(
    "EPUB/package.opf",
    `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>只读验收 EPUB</dc:title></metadata><manifest><item id="c1" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`,
  );
  epub.file(
    "EPUB/chapter.xhtml",
    `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>正文</p></body></html>`,
  );
  await writeFile(
    path,
    await epub.generateAsync({ type: "uint8array", compression: "DEFLATE" }),
  );
}

describe("Reader Core read-only corpus smoke", () => {
  it("validates TXT and EPUB without changing the source manifest", async () => {
    const corpus = await mkdtemp(join(tmpdir(), "reader-core-corpus-"));
    roots.push(corpus);
    await writeFile(join(corpus, "novel.txt"), "测试书名\n\n# 第一章\n正文", "utf8");
    await createMinimalEpub(join(corpus, "novel.epub"));

    const result = await runReaderCoreSmoke(corpus);

    expect(result.before).toEqual(result.after);
    expect(result.supported).toBe(2);
    expect(result.validated).toBe(2);
    expect(result.validationErrors).toEqual([]);
    expect(result.mutated).toEqual([]);
  });

  it("reports added, removed, and changed files deterministically", () => {
    const base = {
      extension: ".txt" as const,
      fileSize: 3,
      modifiedAt: "2026-07-27T00:00:00.000Z",
      sha256: "a".repeat(64),
    };
    const before: ReaderCorpusFact[] = [
      { ...base, relativePath: "changed.txt" },
      { ...base, relativePath: "removed.txt" },
    ];
    const after: ReaderCorpusFact[] = [
      { ...base, relativePath: "added.txt" },
      { ...base, relativePath: "changed.txt", sha256: "b".repeat(64) },
    ];

    expect(diffCorpusManifests(before, after)).toEqual([
      "added.txt",
      "changed.txt",
      "removed.txt",
    ]);
  });
});
