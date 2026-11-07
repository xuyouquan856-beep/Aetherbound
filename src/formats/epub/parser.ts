import { posix } from "node:path";
import JSZip from "jszip";
import { DOMParser } from "linkedom";
import type { PublicationView, TocNode } from "../../shared/contracts.js";
import { EpubPolicyError } from "./errors.js";
import { enforceEpubCoverBudget } from "./cover.js";
import { normalizePublicationPath } from "./resource-path.js";

type ManifestItem = { id: string; href: string; mediaType: string; properties: string };
export type EpubTextUnit = { spineIndex: number; spineHref: string; text: string };
export type EpubCover = {
  mediaType: "image/jpeg" | "image/png" | "image/webp";
  bytes: Uint8Array;
};
export type ParsedEpub = {
  metadata: PublicationView["metadata"];
  toc: TocNode[];
  spine: PublicationView["spine"];
  resources: { href: string; mediaType: string }[];
  extractTextUnits(signal?: AbortSignal): AsyncIterable<EpubTextUnit>;
  readCover(): Promise<EpubCover | null>;
};

const COVER_MEDIA_TYPES = new Set<EpubCover["mediaType"]>(["image/jpeg", "image/png", "image/webp"]);
type SizedZipEntry = JSZip.JSZipObject & {
  _data?: { uncompressedSize?: number } | Promise<unknown>;
};


function xml(input: string) {
  const document = new DOMParser().parseFromString(input, "text/xml");
  if (!document?.documentElement) throw new EpubPolicyError("INVALID_PACKAGE", "Invalid publication XML");
  return document;
}

function childElements(node: Element, name: string) {
  return [...node.children].filter((child) => child.localName.split(":").at(-1) === name);
}

function firstByLocalName(root: { querySelectorAll(selector: string): Iterable<Element> }, name: string) {
  return [...root.querySelectorAll("*")].find((node) => node.localName.split(":").at(-1) === name);
}

function resolveHref(baseFile: string, href: string) {
  const [path, fragment] = href.split("#", 2);
  const resolved = normalizePublicationPath(posix.normalize(posix.join(posix.dirname(baseFile), path ?? "")));
  return fragment ? `${resolved}#${fragment}` : resolved;
}

function navNodes(list: Element, navPath: string): TocNode[] {
  return childElements(list, "li").flatMap((li, index) => {
    const anchor = [...li.children].find((node) => node.localName === "a") as Element | undefined;
    if (!anchor?.getAttribute("href")) return [];
    const nested = [...li.children].find((node) => node.localName === "ol") as Element | undefined;
    const href = resolveHref(navPath, anchor.getAttribute("href")!);
    return [{ id: `toc-${href}-${index}`, label: anchor.textContent?.trim() || href, href, children: nested ? navNodes(nested, navPath) : [] }];
  });
}

function ncxNodes(parent: Element, ncxPath: string): TocNode[] {
  return childElements(parent, "navPoint").flatMap((point, index) => {
    const hrefValue = point.querySelector("content")?.getAttribute("src");
    if (!hrefValue) return [];
    const href = resolveHref(ncxPath, hrefValue);
    return [{ id: point.getAttribute("id") || `toc-${href}-${index}`, label: point.querySelector("navLabel text")?.textContent?.trim() || href, href, children: ncxNodes(point, ncxPath) }];
  });
}

export async function parseEpub(bytes: Uint8Array): Promise<ParsedEpub> {
  const zip = await JSZip.loadAsync(bytes, { createFolders: false });
  const containerFile = zip.file("META-INF/container.xml");
  if (!containerFile) throw new EpubPolicyError("INVALID_PACKAGE", "Missing container.xml");
  const container = xml(await containerFile.async("text"));
  const opfPath = normalizePublicationPath(container.querySelector("rootfile")?.getAttribute("full-path") ?? "");
  const opfFile = zip.file(opfPath);
  if (!opfFile) throw new EpubPolicyError("INVALID_PACKAGE", "Missing package document");
  const opf = xml(await opfFile.async("text"));
  const metadataElement = firstByLocalName(opf, "metadata");
  const title = metadataElement && firstByLocalName(metadataElement, "title")?.textContent?.trim();
  if (!title) throw new EpubPolicyError("INVALID_PACKAGE", "Missing publication title");
  const metadata = {
    title,
    author: metadataElement && firstByLocalName(metadataElement, "creator")?.textContent?.trim() || null,
    language: metadataElement && firstByLocalName(metadataElement, "language")?.textContent?.trim() || null,
  };
  const manifest = [...opf.querySelectorAll("manifest item")].map((item): ManifestItem => ({
    id: item.getAttribute("id") ?? "",
    href: resolveHref(opfPath, item.getAttribute("href") ?? ""),
    mediaType: item.getAttribute("media-type") ?? "application/octet-stream",
    properties: item.getAttribute("properties") ?? "",
  }));
  if (manifest.some((item) => !item.id)) throw new EpubPolicyError("INVALID_PACKAGE", "Manifest item is missing an id");
  const byId = new Map(manifest.map((item) => [item.id, item]));
  const spine = [...opf.querySelectorAll("spine itemref")].map((item, index) => {
    const resource = byId.get(item.getAttribute("idref") ?? "");
    if (!resource) throw new EpubPolicyError("INVALID_PACKAGE", "Spine references a missing resource");
    return { index, href: resource.href, linear: item.getAttribute("linear") !== "no" };
  });
  if (!spine.length) throw new EpubPolicyError("INVALID_PACKAGE", "Publication spine is empty");
  for (const item of spine) {
    if (!zip.file(item.href.split("#", 1)[0]!)) throw new EpubPolicyError("INVALID_PACKAGE", "Spine resource is missing");
  }

  let toc: TocNode[] = [];
  const nav = manifest.find((item) => item.properties.split(/\s+/).includes("nav"));
  if (nav) {
    const navFile = zip.file(nav.href);
    if (!navFile) throw new EpubPolicyError("INVALID_PACKAGE", "Navigation resource is missing");
    const document = xml(await navFile.async("text"));
    const tocNav = [...document.querySelectorAll("nav")].find((node) => (node.getAttribute("epub:type") ?? node.getAttribute("type") ?? "").split(/\s+/).includes("toc"));
    const list = tocNav?.querySelector("ol");
    if (list) toc = navNodes(list, nav.href);
  } else {
    const tocId = opf.querySelector("spine")?.getAttribute("toc");
    const ncx = tocId ? byId.get(tocId) : manifest.find((item) => item.mediaType === "application/x-dtbncx+xml");
    if (ncx) {
      const ncxFile = zip.file(ncx.href);
      if (!ncxFile) throw new EpubPolicyError("INVALID_PACKAGE", "NCX resource is missing");
      const document = xml(await ncxFile.async("text"));
      const map = document.querySelector("navMap");
      if (map) toc = ncxNodes(map, ncx.href);
    }
  }

  const epub3Cover = manifest.find((item) => item.properties.split(/\s+/).includes("cover-image"));
  const epub2CoverId = metadataElement
    ? [...metadataElement.querySelectorAll("*")].find((node) =>
        node.localName.split(":").at(-1) === "meta" && node.getAttribute("name")?.toLowerCase() === "cover",
      )?.getAttribute("content")
    : null;
  const coverResource = epub3Cover ?? (epub2CoverId ? byId.get(epub2CoverId) : undefined);

  async function* extractTextUnits(signal?: AbortSignal): AsyncIterable<EpubTextUnit> {
    for (const item of spine) {
      if (signal?.aborted) return;
      const file = zip.file(item.href.split("#", 1)[0]!);
      if (!file) throw new EpubPolicyError("INVALID_PACKAGE", "Spine resource is missing");
      const document = xml(await file.async("text"));
      yield {
        spineIndex: item.index,
        spineHref: item.href,
        text: (document.querySelector("body")?.textContent ?? "").replace(/\s+/g, " ").trim(),
      };
    }
  }

  async function readCover(): Promise<EpubCover | null> {
    if (!coverResource || !COVER_MEDIA_TYPES.has(coverResource.mediaType as EpubCover["mediaType"])) return null;
    const file = zip.file(coverResource.href.split("#", 1)[0]!);
    if (!file) return null;
    const sizeMetadata = (file as SizedZipEntry)._data;
    if (!(sizeMetadata instanceof Promise) && typeof sizeMetadata?.uncompressedSize === "number") {
      enforceEpubCoverBudget(sizeMetadata.uncompressedSize);
    }
    const bytes = await file.async("uint8array");
    enforceEpubCoverBudget(bytes.byteLength);
    return { mediaType: coverResource.mediaType as EpubCover["mediaType"], bytes };
  }

  return {
    metadata,
    toc,
    spine,
    resources: manifest.map(({ href, mediaType }) => ({ href, mediaType })),
    extractTextUnits,
    readCover,
  };
}