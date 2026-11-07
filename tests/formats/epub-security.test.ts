import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { EpubPolicyError } from "../../src/formats/epub/errors.js";
import { enforceArchiveBudget } from "../../src/formats/epub/archive-policy.js";
import { prepareEpubBytes } from "../../src/formats/epub/prepare.js";
import { normalizePublicationPath } from "../../src/formats/epub/resource-path.js";

async function archive(entries: Record<string, string | Uint8Array>) {
  const zip = new JSZip();
  for (const [path, value] of Object.entries(entries)) zip.file(path, value);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

function deterministicNoise(length: number) {
  const bytes = new Uint8Array(length);
  let state = 0x12345678;
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    bytes[index] = state >>> 24;
  }
  return bytes;
}

describe("EPUB security preparation", () => {
  it.each([
    "../escape.xhtml", "EPUB/../escape.xhtml", "/absolute.xhtml", "C:/drive.xhtml",
    "EPUB\\chapter.xhtml", "EPUB/%2e%2e/escape.xhtml", "EPUB/%252e%252e/escape.xhtml", "EPUB/\0bad.xhtml",
  ])("rejects unsafe publication path %s", (path) => {
    expect(() => normalizePublicationPath(path)).toThrow(EpubPolicyError);
  });

  it("rejects a traversal name before JSZip's sanitized name can hide it", async () => {
    const bytes = await archive({ "../escape.xhtml": "escape", mimetype: "application/epub+zip" });
    await expect(prepareEpubBytes(bytes)).rejects.toMatchObject({ code: "RESOURCE_BLOCKED" });
  });

  it("enforces archive budgets before inflating entries", async () => {
    const bytes = await archive({ mimetype: "application/epub+zip", "EPUB/huge.txt": "a".repeat(20_000) });
    await expect(prepareEpubBytes(bytes, {
      maxSourceBytes: 1_000_000, maxEntries: 10, maxEntryUncompressedBytes: 25_000,
      maxTotalUncompressedBytes: 25_000, maxCompressionRatio: 2,
      minEntryRatioCheckBytes: 1_000, maxPathLength: 1024,
    })).rejects.toMatchObject({ code: "ARCHIVE_LIMIT" });
  });

  it("accepts a harmless highly-compressed small resource in an otherwise normal archive", async () => {
    const bytes = await archive({
      mimetype: "application/epub+zip",
      "EPUB/image.jpg": deterministicNoise(64_000),
      "EPUB/placeholder.jpg": new Uint8Array(20_000),
    });

    await expect(prepareEpubBytes(bytes, {
      maxSourceBytes: 1_000_000,
      maxEntries: 10,
      maxEntryUncompressedBytes: 100_000,
      maxTotalUncompressedBytes: 100_000,
      maxCompressionRatio: 2,
      minEntryRatioCheckBytes: 32_000,
      maxPathLength: 1024,
    })).resolves.toMatchObject({
      report: {
        archive: {
          totalUncompressedBytes: 84_020,
        },
      },
    });
  });

  it("rejects a split ZIP bomb by aggregate ratio even when every entry is small", async () => {
    const entries: Record<string, string> = { mimetype: "application/epub+zip" };
    for (let index = 0; index < 8; index += 1) {
      entries[`EPUB/chunk-${index}.txt`] = "a".repeat(20_000);
    }
    const bytes = await archive(entries);

    await expect(prepareEpubBytes(bytes, {
      maxSourceBytes: 1_000_000,
      maxEntries: 20,
      maxEntryUncompressedBytes: 100_000,
      maxTotalUncompressedBytes: 200_000,
      maxCompressionRatio: 2,
      minEntryRatioCheckBytes: 32_000,
      maxPathLength: 1024,
    })).rejects.toThrow(/aggregate compression ratio/i);
  });

  it("accepts legitimate zero-byte archive entries without weakening size checks", async () => {
    const bytes = await archive({
      mimetype: "application/epub+zip",
      "EPUB/empty.css": "",
    });
    const prepared = await prepareEpubBytes(bytes);
    const zip = await JSZip.loadAsync(prepared.bytes);
    await expect(zip.file("EPUB/empty.css")!.async("text")).resolves.toBe("");
  });

  it("still rejects programmatic entries whose size metadata is unknown", () => {
    const zip = new JSZip();
    zip.file("EPUB/unknown.bin", Promise.resolve("not measured"));
    expect(() => enforceArchiveBudget(zip)).toThrowError(/Invalid ZIP size metadata/);
  });

  it("removes publication scripts, active elements, event handlers and remote URLs", async () => {
    const bytes = await archive({
      mimetype: "application/epub+zip",
      "EPUB/chapter.xhtml": `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head>
        <base href="https://evil.invalid/"/><style>@import "https://evil.invalid/a.css";p{background:url(https://evil.invalid/x)}</style>
        <script>globalThis.pwned=true</script></head><body onload="pwned()"><iframe src="https://evil.invalid/f"></iframe>
        <a href="javascript:pwned()">bad</a><img src="https://evil.invalid/x.png"/><p style="background:url(file:///secret)">safe text</p></body></html>`,
      "EPUB/style.css": "@import url(https://evil.invalid/x.css); body{background:url(//evil.invalid/x)}",
    });
    const prepared = await prepareEpubBytes(bytes);
    const zip = await JSZip.loadAsync(prepared.bytes);
    const html = await zip.file("EPUB/chapter.xhtml")!.async("text");
    const css = await zip.file("EPUB/style.css")!.async("text");
    expect(html).toContain("safe text");
    expect(`${html}\n${css}`).not.toMatch(/<script|onload|<iframe|javascript:|evil\.invalid|file:|@import/i);
    expect(prepared.report.removed).toMatchObject({ scripts: 1, eventAttributes: 1 });
  });
});
