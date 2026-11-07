import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import JSZip from "jszip";

const COVER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

export type SourceSnapshot = {
  relativePath: string;
  fileSize: number;
  modifiedAt: string;
  sha256: string;
};

async function createSimpleEpub(
  path: string,
  title: string,
  withCover: boolean,
  payloadBytes = 0,
) {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  );
  const coverManifest = withCover
    ? '<item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/>'
    : "";
  zip.file(
    "EPUB/package.opf",
    `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title><dc:creator>测试作者</dc:creator><dc:language>zh-CN</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${coverManifest}<item id="c1" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`,
  );
  zip.file(
    "EPUB/nav.xhtml",
    '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml">正文</a></li></ol></nav></body></html>',
  );
  zip.file(
    "EPUB/chapter.xhtml",
    `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1>${title}</h1><p>用于珍藏流程验收的稳定正文。</p></body></html>`,
  );
  if (withCover) zip.file("EPUB/cover.png", COVER_PNG);
  if (payloadBytes > 0) {
    zip.file("EPUB/background-preparation-payload.bin", randomBytes(payloadBytes), {
      compression: "STORE",
    });
  }
  await writeFile(path, await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }));
}

export async function snapshotFixture(root: string): Promise<SourceSnapshot[]> {
  const files: string[] = [];
  async function walk(directory: string) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  await walk(root);
  const snapshots = await Promise.all(files.sort().map(async (path) => {
    const [info, bytes] = await Promise.all([stat(path), readFile(path)]);
    return {
      relativePath: relative(root, path).replaceAll("\\", "/"),
      fileSize: info.size,
      modifiedAt: info.mtime.toISOString(),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }));
  return snapshots;
}

export async function createCollectionFolderFixture() {
  const tempRoot = await mkdtemp(join(tmpdir(), "aetherbound-collection-e2e-"));
  const folderRoot = join(tempRoot, "星海珍藏");
  const nestedRoot = join(folderRoot, "子文件夹");
  await mkdir(nestedRoot, { recursive: true });

  await createSimpleEpub(
    join(folderRoot, "01-星海封面卷.epub"),
    "星海封面卷",
    true,
    12 * 1024 * 1024,
  );
  await createSimpleEpub(join(folderRoot, "02-星海无封面卷.epub"), "星海无封面卷", false);
  const txt = "星海短篇\n\n第一章 启程\n用于重复识别的稳定正文。\n第二章 归航\n结束。";
  await writeFile(join(folderRoot, "03-星海短篇.txt"), txt, "utf8");
  await writeFile(join(folderRoot, "04-星海短篇副本.txt"), txt, "utf8");
  await writeFile(join(folderRoot, "05-损坏.epub"), "not-an-epub", "utf8");
  await writeFile(join(folderRoot, "cover.jpg"), COVER_PNG);
  await createSimpleEpub(join(nestedRoot, "不应导入.epub"), "嵌套禁入", true);

  return {
    tempRoot,
    folderRoot,
    before: await snapshotFixture(folderRoot),
  };
}
