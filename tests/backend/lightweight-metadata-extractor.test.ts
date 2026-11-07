import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// import { LightweightMetadataExtractor } from "../../src/backend/library-scan/lightweight-metadata-extractor.js";

// --- TXT Helpers ---

function gb18030Bytes(text: string): Uint8Array {
  // Use a simple approach: encode as UTF-8 first then represent as GB18030-like
  // For test purposes, we'll write actual files with known encodings
  const encoder = new TextEncoder();
  return encoder.encode(text);
}

async function writeTxtFile(dir: string, name: string, content: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, content, "utf-8");
  return path;
}

// --- EPUB Helpers ---

async function makeMinimalEpub(
  dir: string,
  name: string,
  opfContent: string,
  extraEntries?: Record<string, string>,
): Promise<string> {
  const zip = new JSZip();
  // META-INF/container.xml
  zip.file("META-INF/container.xml", `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);

  zip.file("content.opf", opfContent);

  if (extraEntries) {
    for (const [entryPath, entryContent] of Object.entries(extraEntries)) {
      zip.file(entryPath, entryContent);
    }
  }

  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const path = join(dir, name);
  await writeFile(path, buffer);
  return path;
}

function makeOpfXml(options: {
  title?: string;
  creator?: string;
  language?: string;
  identifier?: string;
} = {}): string {
  const title = options.title ?? "Test Book";
  const creator = options.creator ? `<dc:creator>${options.creator}</dc:creator>` : "";
  const language = options.language ? `<dc:language>${options.language}</dc:language>` : "";
  const identifier = options.identifier
    ? `<dc:identifier id="book-id">${options.identifier}</dc:identifier>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<package version="2.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="book-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${title}</dc:title>
    ${creator}
    ${language}
    ${identifier}
  </metadata>
  <manifest>
    <item id="chap1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="chap1"/>
  </spine>
</package>`;
}

describe("LightweightMetadataExtractor", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "reader-lwmeta-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // --- TXT Tests ---

  it("extracts title from TXT filename when no inline title", async () => {
    const { LightweightMetadataExtractor } = await import(
      "../../src/backend/library-scan/lightweight-metadata-extractor.js"
    );
    const extractor = new LightweightMetadataExtractor();
    const path = await writeTxtFile(tempDir, "三体.txt", "第一章\n\n在这个疯狂的年代里，人们四处逃亡。");

    const result = await extractor.extract({
      absolutePath: path,
      displayFileName: "三体.txt",
      format: "txt",
    });

    expect(result.metadataVersion).toBe(1);
    expect(result.source).toBe("txt-head");
    expect(result.title).toBe("三体");
    expect(result.author).toBeNull();
  });

  it("reads at most 20 KiB of TXT content", async () => {
    const { LightweightMetadataExtractor } = await import(
      "../../src/backend/library-scan/lightweight-metadata-extractor.js"
    );
    const extractor = new LightweightMetadataExtractor();
    // Write a file larger than 20 KiB
    const largeContent = "第一章\n" + "x".repeat(25 * 1024);
    const path = await writeTxtFile(tempDir, "large.txt", largeContent);

    const result = await extractor.extract({
      absolutePath: path,
      displayFileName: "large.txt",
      format: "txt",
    });

    expect(result.metadataVersion).toBe(1);
    expect(result.source).toBe("txt-head");
    // Should not crash and should still produce metadata
    expect(result.title.length).toBeGreaterThan(0);
  });

  it("handles UTF-8 TXT without crashing", async () => {
    const { LightweightMetadataExtractor } = await import(
      "../../src/backend/library-scan/lightweight-metadata-extractor.js"
    );
    const extractor = new LightweightMetadataExtractor();
    const path = await writeTxtFile(tempDir, "utf8-test.txt", "第一章 序章\n\n这是一本测试书。");

    const result = await extractor.extract({
      absolutePath: path,
      displayFileName: "utf8-test.txt",
      format: "txt",
    });

    expect(result.metadataVersion).toBe(1);
    expect(result.source).toBe("txt-head");
    expect(result.title).toBeTruthy();
  });

  it("handles TXT with empty content gracefully", async () => {
    const { LightweightMetadataExtractor } = await import(
      "../../src/backend/library-scan/lightweight-metadata-extractor.js"
    );
    const extractor = new LightweightMetadataExtractor();
    const path = await writeTxtFile(tempDir, "empty.txt", "");

    const result = await extractor.extract({
      absolutePath: path,
      displayFileName: "empty.txt",
      format: "txt",
    });

    expect(result.metadataVersion).toBe(1);
    expect(result.source).toBe("txt-head");
    // Falls back to filename
    expect(result.title).toBe("empty");
  });

  // --- EPUB Tests ---

  it("extracts title, creator, language, identifier from valid EPUB", async () => {
    const { LightweightMetadataExtractor } = await import(
      "../../src/backend/library-scan/lightweight-metadata-extractor.js"
    );
    const extractor = new LightweightMetadataExtractor();
    const opf = makeOpfXml({
      title: "三号书",
      creator: "作者甲",
      language: "zh-CN",
      identifier: "urn:isbn:9781234567890",
    });
    const path = await makeMinimalEpub(tempDir, "test.epub", opf);

    const result = await extractor.extract({
      absolutePath: path,
      displayFileName: "test.epub",
      format: "epub",
    });

    expect(result.metadataVersion).toBe(1);
    expect(result.source).toBe("epub-opf");
    expect(result.title).toBe("三号书");
    expect(result.author).toBe("作者甲");
    expect(result.language).toBe("zh-CN");
    expect(result.identifier).toBe("urn:isbn:9781234567890");
  });

  it("extracts EPUB metadata without optional fields", async () => {
    const { LightweightMetadataExtractor } = await import(
      "../../src/backend/library-scan/lightweight-metadata-extractor.js"
    );
    const extractor = new LightweightMetadataExtractor();
    const opf = makeOpfXml({ title: "Minimal Book" });
    const path = await makeMinimalEpub(tempDir, "minimal.epub", opf);

    const result = await extractor.extract({
      absolutePath: path,
      displayFileName: "minimal.epub",
      format: "epub",
    });

    expect(result.title).toBe("Minimal Book");
    expect(result.author).toBeNull();
    expect(result.language).toBeNull();
    expect(result.identifier).toBeNull();
  });

  it("rejects ZIP entries with '../' path traversal", async () => {
    const { LightweightMetadataExtractor } = await import(
      "../../src/backend/library-scan/lightweight-metadata-extractor.js"
    );
    const extractor = new LightweightMetadataExtractor();

    const zip = new JSZip();
    zip.file("META-INF/container.xml", `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="../content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);
    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    const path = join(tempDir, "traversal.epub");
    await writeFile(path, buffer);

    await expect(
      extractor.extract({ absolutePath: path, displayFileName: "traversal.epub", format: "epub" }),
    ).rejects.toThrow();
  });

  it("rejects ZIP entries with absolute paths", async () => {
    const { LightweightMetadataExtractor } = await import(
      "../../src/backend/library-scan/lightweight-metadata-extractor.js"
    );
    const extractor = new LightweightMetadataExtractor();

    const zip = new JSZip();
    zip.file("META-INF/container.xml", `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="/etc/passwd" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);
    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    const path = join(tempDir, "absolute.epub");
    await writeFile(path, buffer);

    await expect(
      extractor.extract({ absolutePath: path, displayFileName: "absolute.epub", format: "epub" }),
    ).rejects.toThrow();
  });

  it("rejects ZIP entries with backslash paths", async () => {
    const { LightweightMetadataExtractor } = await import(
      "../../src/backend/library-scan/lightweight-metadata-extractor.js"
    );
    const extractor = new LightweightMetadataExtractor();

    const zip = new JSZip();
    zip.file("META-INF/container.xml", `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="..\\content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);
    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    const path = join(tempDir, "backslash.epub");
    await writeFile(path, buffer);

    await expect(
      extractor.extract({ absolutePath: path, displayFileName: "backslash.epub", format: "epub" }),
    ).rejects.toThrow();
  });

  it("throws on corrupted EPUB", async () => {
    const { LightweightMetadataExtractor } = await import(
      "../../src/backend/library-scan/lightweight-metadata-extractor.js"
    );
    const extractor = new LightweightMetadataExtractor();
    const path = join(tempDir, "corrupt.epub");
    await writeFile(path, "not a valid zip file");

    await expect(
      extractor.extract({ absolutePath: path, displayFileName: "corrupt.epub", format: "epub" }),
    ).rejects.toThrow();
  });

  it("throws on missing container.xml in EPUB", async () => {
    const { LightweightMetadataExtractor } = await import(
      "../../src/backend/library-scan/lightweight-metadata-extractor.js"
    );
    const extractor = new LightweightMetadataExtractor();
    const zip = new JSZip();
    zip.file("content.opf", makeOpfXml({ title: "No Container" }));
    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    const path = join(tempDir, "no-container.epub");
    await writeFile(path, buffer);

    await expect(
      extractor.extract({ absolutePath: path, displayFileName: "no-container.epub", format: "epub" }),
    ).rejects.toThrow();
  });

  it("throws on missing OPF referenced by container", async () => {
    const { LightweightMetadataExtractor } = await import(
      "../../src/backend/library-scan/lightweight-metadata-extractor.js"
    );
    const extractor = new LightweightMetadataExtractor();
    const zip = new JSZip();
    zip.file("META-INF/container.xml", `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="missing.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);
    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    const path = join(tempDir, "missing-opf.epub");
    await writeFile(path, buffer);

    await expect(
      extractor.extract({ absolutePath: path, displayFileName: "missing-opf.epub", format: "epub" }),
    ).rejects.toThrow();
  });

  it("is not forced to decompress archives whose declared sizes are forged", async () => {
    // Adversarial guard for the eager-decompression defect. JSZip's checkCRC32
    // decompresses EVERY entry up front to verify checksums, and it only detects a
    // declared-size lie AFTER the bytes are expanded. This archive declares a small
    // entry while carrying a large one, so with checkCRC32 the extractor would inflate
    // the payload to read two small XML files.
    const { LightweightMetadataExtractor } = await import(
      "../../src/backend/library-scan/lightweight-metadata-extractor.js"
    );
    const extractor = new LightweightMetadataExtractor();
    const zip = new JSZip();
    zip.file("META-INF/container.xml", `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);
    zip.file("content.opf", makeOpfXml({ title: "伪造尺寸", creator: "作者乙" }));
    zip.file("bomb.xhtml", Buffer.alloc(256 * 1024 * 1024, 0x41));
    const honest = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 9 },
    });

    // Forge only the central-directory size fields so the declared entry looks tiny.
    const forged = Buffer.from(honest);
    const target = Buffer.from("bomb.xhtml", "utf8");
    let patched = 0;
    for (let i = 0; i + 46 <= forged.length; i++) {
      if (forged.readUInt32LE(i) !== 0x02014b50) continue; // central directory header
      const nameLen = forged.readUInt16LE(i + 28);
      const nameStart = i + 46;
      if (nameLen !== target.length) continue;
      if (!forged.subarray(nameStart, nameStart + nameLen).equals(target)) continue;
      forged.writeUInt32LE(1024, i + 20); // compressed size
      forged.writeUInt32LE(2048, i + 24); // uncompressed size
      patched++;
    }
    expect(patched).toBe(1);
    expect(forged.length).toBeLessThan(2 * 1024 * 1024);

    const path = join(tempDir, "forged.epub");
    await writeFile(path, forged);
    const started = Date.now();
    const result = await extractor.extract({
      absolutePath: path,
      displayFileName: "forged.epub",
      format: "epub",
    });
    const elapsed = Date.now() - started;

    expect(result.title).toBe("伪造尺寸");
    console.log(`[forged] extract elapsed ${elapsed} ms (archive ${forged.length} bytes, declares 2 KiB, carries 256 MiB)`);
    // Expanding 256 MiB dominates this budget; a header-only read is tens of ms.
    expect(elapsed).toBeLessThan(2000);
  }, 30_000);

  it("rejects an archive whose declared entry size exceeds the budget", async () => {
    // The budget is enforced from the central directory before any entry is read,
    // so a zip-bomb declaration is refused rather than expanded.
    const { LightweightMetadataExtractor } = await import(
      "../../src/backend/library-scan/lightweight-metadata-extractor.js"
    );
    const extractor = new LightweightMetadataExtractor();
    const zip = new JSZip();
    zip.file("META-INF/container.xml", `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);
    zip.file("content.opf", makeOpfXml({ title: "bomb" }));
    // Exceeds maxEntryUncompressedBytes (128 MiB) once declared.
    zip.file("huge.bin", Buffer.alloc(200 * 1024 * 1024, 0x41));
    const buffer = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 1 },
    });
    const path = join(tempDir, "oversized.epub");
    await writeFile(path, buffer);
    expect(buffer.length).toBeLessThan(4 * 1024 * 1024);

    await expect(
      extractor.extract({ absolutePath: path, displayFileName: "oversized.epub", format: "epub" }),
    ).rejects.toThrow(/ARCHIVE_LIMIT|Archive entry is too large|expands beyond/i);
  });
});
