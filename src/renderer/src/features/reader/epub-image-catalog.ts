import JSZip from "jszip";
import { enforceArchiveBudget } from "../../../../formats/epub/archive-policy.js";
import { normalizePublicationPath } from "../../../../formats/epub/resource-path.js";

export type EpubGalleryImage = {
  href: string;
  mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  label: string;
};

export type EpubImageCatalog = {
  images: EpubGalleryImage[];
  readImage(image: EpubGalleryImage): Promise<Uint8Array>;
};

const IMAGE_TYPES = new Set<EpubGalleryImage["mediaType"]>([
  "image/jpeg", "image/png", "image/webp", "image/gif",
]);
const MAX_GALLERY_IMAGE_BYTES = 32 * 1024 * 1024;

function parseXml(value: string): Document {
  const document = new DOMParser().parseFromString(value, "application/xml");
  if (document.querySelector("parsererror")) throw new Error("EPUB 图片目录格式无效");
  return document;
}

function localName(element: Element, name: string): boolean {
  return element.localName.split(":").at(-1) === name;
}

function descendants(document: Document | Element, name: string): Element[] {
  return [...document.getElementsByTagName("*")].filter((element) => localName(element, name));
}

function resolveResource(baseFile: string, href: string): string {
  if (!href || href.startsWith("/") || href.includes("\\")) throw new Error("EPUB 图片路径无效");
  const base = new URL(`https://publication.invalid/${baseFile}`);
  const resolved = new URL(href, base);
  if (resolved.origin !== base.origin || resolved.search) throw new Error("EPUB 图片路径不是本地资源");
  return normalizePublicationPath(decodeURIComponent(resolved.pathname.slice(1)));
}

export async function openEpubImageCatalog(bytes: Uint8Array): Promise<EpubImageCatalog> {
  const zip = await JSZip.loadAsync(bytes, { createFolders: false });
  enforceArchiveBudget(zip);
  const container = zip.file("META-INF/container.xml");
  if (!container) throw new Error("EPUB 缺少容器目录");
  const containerXml = parseXml(await container.async("text"));
  const packagePath = normalizePublicationPath(descendants(containerXml, "rootfile")[0]?.getAttribute("full-path") ?? "");
  const packageFile = zip.file(packagePath);
  if (!packageFile) throw new Error("EPUB 缺少资源清单");
  const packageXml = parseXml(await packageFile.async("text"));
  const manifest = descendants(packageXml, "item").flatMap((item) => {
    try {
      return [{
        id: item.getAttribute("id") ?? "",
        href: resolveResource(packagePath, item.getAttribute("href") ?? ""),
        mediaType: item.getAttribute("media-type") ?? "",
        properties: item.getAttribute("properties") ?? "",
      }];
    } catch {
      return [];
    }
  });
  const coverId = descendants(packageXml, "meta")
    .find((item) => item.getAttribute("name")?.toLowerCase() === "cover")
    ?.getAttribute("content");
  const cover = manifest.find((item) => item.properties.split(/\s+/).includes("cover-image"))
    ?? manifest.find((item) => item.id === coverId)
    ?? manifest.find((item) => /(?:^|\/)cover(?:[._-]|$)/i.test(item.href));
  const ordered = cover ? [cover, ...manifest] : manifest;
  const seen = new Set<string>();
  let illustrationNumber = 0;
  const images: EpubGalleryImage[] = [];
  for (const item of ordered) {
    if (!IMAGE_TYPES.has(item.mediaType as EpubGalleryImage["mediaType"]) || seen.has(item.href)) continue;
    if (!zip.file(item.href)) continue;
    seen.add(item.href);
    const isCover = item.href === cover?.href;
    if (!isCover) illustrationNumber += 1;
    images.push({
      href: item.href,
      mediaType: item.mediaType as EpubGalleryImage["mediaType"],
      label: isCover ? "封面" : `插图 ${illustrationNumber}`,
    });
  }
  const allowed = new Map(images.map((image) => [image.href, image]));
  return {
    images,
    async readImage(image) {
      if (allowed.get(image.href) !== image) throw new Error("图片不在当前书籍中");
      const file = zip.file(image.href);
      if (!file) throw new Error("图片文件已丢失");
      const entry = file as JSZip.JSZipObject & { _data?: { uncompressedSize?: number } | Promise<unknown> };
      if (!(entry._data instanceof Promise) && (entry._data?.uncompressedSize ?? 0) > MAX_GALLERY_IMAGE_BYTES) {
        throw new Error("图片文件超过预览大小限制");
      }
      const data = await file.async("uint8array");
      if (data.byteLength > MAX_GALLERY_IMAGE_BYTES) throw new Error("图片文件超过预览大小限制");
      return data;
    },
  };
}
