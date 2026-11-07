import { open as fsOpen, readFile as fsReadFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import JSZip from "jszip";
import { ReaderError } from "../../shared/errors.js";
import { enforceArchiveBudget } from "../../formats/epub/archive-policy.js";
import { EpubPolicyError } from "../../formats/epub/errors.js";
import type { InventoryMetadata } from "../../shared/contracts.js";

async function readTxtHead(absolutePath: string): Promise<string> {
  const handle = await fsOpen(absolutePath, "r");
  try {
    const maxBytes = 20 * 1024;
    const stats = await handle.stat();
    const readSize = Math.min(maxBytes, stats.size);
    const buf = Buffer.alloc(readSize);
    await handle.read(buf, 0, readSize, 0);

    if (readSize >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
      return new TextDecoder("utf-16le").decode(buf.subarray(2));
    }
    if (readSize >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
      return new TextDecoder("utf-16be").decode(buf.subarray(2));
    }

    const utf8Start = readSize >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0;
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(utf8Start));
    } catch {
      try {
        const { decodeTxt } = await import("../../formats/txt/decode.js");
        const decoded = decodeTxt(new Uint8Array(buf));
        return decoded.text;
      } catch {
        return buf.toString("latin1");
      }
    }
  } finally {
    await handle.close();
  }
}

function extractTitleFromFilename(fileName: string): string {
  const ext = extname(fileName);
  return basename(fileName, ext);
}

function isValidPublicationPath(path: string): boolean {
  if (!path || path.length === 0) return false;
  if (path.startsWith("/")) return false;
  if (/^[a-z]:[\\/]/i.test(path)) return false;
  if (path.includes("\\")) return false;

  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return false;
  }
  return true;
}

async function extractEpubMetadata(absolutePath: string): Promise<{
  title: string;
  author: string | null;
  language: string | null;
  identifier: string | null;
}> {
  let zipData: Uint8Array;
  try {
    zipData = new Uint8Array(await fsReadFile(absolutePath));
  } catch {
    throw new ReaderError("FILE_NOT_READABLE", "Cannot read EPUB file");
  }

  let zip: JSZip;
  try {
    // checkCRC32 MUST stay off. With it on, JSZip decompresses every entry up front
    // to verify checksums — before any budget is applied — so scanning an untrusted
    // folder would inflate whole archives just to read two small XML files. Measured
    // on this library it cost 442 ms per book against 90 ms for the header-only read.
    zip = await JSZip.loadAsync(zipData, { checkCRC32: false, createFolders: false });
  } catch {
    throw new ReaderError("INVALID_PACKAGE", "Not a valid ZIP/EPUB file");
  }

  // Bound the archive before reading anything out of it. The resource budget rejects
  // oversized entries and implausible compression ratios using the declared sizes in
  // the central directory; deeper enforcement for the read path lives in
  // formats/epub/prepare.ts, which streams with a produced-byte cap.
  try {
    enforceArchiveBudget(zip);
  } catch (error) {
    if (error instanceof EpubPolicyError) {
      throw new ReaderError(
        error.code === "RESOURCE_BLOCKED" ? "RESOURCE_BLOCKED" : "ARCHIVE_LIMIT",
        error.message,
      );
    }
    throw error;
  }

  const containerFile = zip.file("META-INF/container.xml");
  if (!containerFile) {
    throw new ReaderError("INVALID_PACKAGE", "META-INF/container.xml not found");
  }

  let containerXml: string;
  try {
    containerXml = await containerFile.async("text");
  } catch {
    throw new ReaderError("FILE_NOT_READABLE", "Failed to read META-INF/container.xml");
  }

  if (containerXml.length > 1024 * 1024) {
    throw new ReaderError("FILE_TOO_LARGE", "META-INF/container.xml exceeds 1 MiB size limit");
  }

  const rootfileMatch = containerXml.match(/<rootfile[^>]*full-path\s*=\s*["']([^"']+)["'][^>]*\/?>/i);
  if (!rootfileMatch) {
    throw new ReaderError("INVALID_PACKAGE", "No rootfile found in container.xml");
  }
  const opfPath = rootfileMatch[1];

  if (!isValidPublicationPath(opfPath)) {
    throw new ReaderError("INVALID_PACKAGE", `Invalid OPF path: ${opfPath}`);
  }

  const opfFile = zip.file(opfPath);
  if (!opfFile) {
    throw new ReaderError("INVALID_PACKAGE", `OPF file not found: ${opfPath}`);
  }

  let opfXml: string;
  try {
    opfXml = await opfFile.async("text");
  } catch {
    throw new ReaderError("FILE_NOT_READABLE", "Failed to read OPF file");
  }

  if (opfXml.length > 5 * 1024 * 1024) {
    throw new ReaderError("FILE_TOO_LARGE", "OPF exceeds 5 MiB limit");
  }

  const metadataSection = opfXml.match(/<metadata[^>]*>([\s\S]*?)<\/metadata\s*>/i);
  const metaContent = metadataSection ? metadataSection[1] : "";

  const titleMatch = metaContent.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title\s*>/i);
  const creatorMatch = metaContent.match(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator\s*>/i);
  const languageMatch = metaContent.match(/<dc:language[^>]*>([\s\S]*?)<\/dc:language\s*>/i);
  const identifierMatch = metaContent.match(/<dc:identifier[^>]*>([\s\S]*?)<\/dc:identifier\s*>/i);

  const title = titleMatch ? titleMatch[1].trim() : "Unknown Title";
  const author = creatorMatch ? creatorMatch[1].trim() : null;
  const language = languageMatch ? languageMatch[1].trim() : null;
  const identifier = identifierMatch ? identifierMatch[1].trim() : null;

  return { title, author, language, identifier };
}

export class LightweightMetadataExtractor {
  async extract(input: {
    absolutePath: string;
    displayFileName: string;
    format: "txt" | "epub";
  }): Promise<InventoryMetadata> {
    if (input.format === "txt") {
      const filenameTitle = extractTitleFromFilename(input.displayFileName);
      let bodyText = "";
      try {
        bodyText = await readTxtHead(input.absolutePath);
      } catch {
        // If can't read, still return metadata with filename title
      }

      const lines = bodyText.split(/\r?\n/).filter((l) => l.trim().length > 0);
      let title = filenameTitle;
      // Only use body text as title if the first non-empty line looks like a title
      // (not a chapter marker, not prose with sentence-ending punctuation)
      const firstLine = lines[0]?.trim();
      if (
        firstLine &&
        firstLine.length >= 2 &&
        firstLine.length <= 200 &&
        !/^[=\-*#]{3,}/.test(firstLine) &&
        !/^第[零一二三四五六七八九十百千万\d]+[章节卷篇部]/.test(firstLine) &&
        !/[。！？；]$/.test(firstLine) &&
        !/^[（(]/.test(firstLine)
      ) {
        title = firstLine;
      }

      return {
        metadataVersion: 1,
        title,
        author: null,
        language: null,
        identifier: null,
        source: "txt-head",
      };
    }

    const meta = await extractEpubMetadata(input.absolutePath);

    return {
      metadataVersion: 1,
      title: meta.title,
      author: meta.author,
      language: meta.language,
      identifier: meta.identifier,
      source: "epub-opf",
    };
  }
}
