import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import JSZip from "jszip";
const COVER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64",
);

export async function createEpubFixture(root: string) {
  const longChapter = "长章节性能段落。".repeat(4_000);
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip");
  zip.file("META-INF/container.xml", `<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  zip.file("EPUB/package.opf", `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>EPUB 验收书</dc:title><dc:creator>测试作者</dc:creator><dc:language>zh-CN</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/><item id="css" href="book.css" media-type="text/css"/><item id="font" href="fonts/embedded.ttf" media-type="font/ttf"/><item id="c1" href="chapter-1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="chapter-2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`);
  zip.file("EPUB/nav.xhtml", `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="chapter-1.xhtml#anchor">第一章</a><ol><li><a href="chapter-2.xhtml#target">第二章</a></li></ol></li></ol></nav></body></html>`);
  zip.file("EPUB/book.css", `@font-face{font-family:Phase0Embedded;src:url("fonts/embedded.ttf")}body{font-family:Phase0Embedded,serif}.vertical{writing-mode:vertical-rl}`);
  zip.file("EPUB/cover.png", COVER_PNG);
  zip.file("EPUB/fonts/embedded.ttf", await readFile("C:\\Windows\\Fonts\\arial.ttf"));
  zip.file("EPUB/chapter-1.xhtml", `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><link rel="stylesheet" href="book.css"/><script>globalThis.__publicationScriptRan=true</script></head><body onload="globalThis.__eventRan=true"><h1>第一章</h1><p id="anchor">这是一段用于定位恢复的稳定正文文本。</p><p><ruby>漢<rt>かん</rt></ruby></p><a id="to-second" href="chapter-2.xhtml#target">前往第二章</a><p id="long-chapter">${longChapter}</p><img src="https://evil.invalid/tracker.png" alt="blocked"/></body></html>`, { compression: "STORE" });
  zip.file("EPUB/chapter-2.xhtml", `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><link rel="stylesheet" href="book.css"/></head><body><h1 id="target">第二章</h1><p class="vertical">竖排文本</p><p>重启后仍应回到这里。</p></body></html>`);
  const path = join(root, "acceptance.epub");
  await writeFile(path, await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }));
  return path;
}
