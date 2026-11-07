import chardet from "chardet";
import iconv from "iconv-lite";
import { ReaderError } from "../../shared/errors.js";

export type DecodedTxt = { text: string; encoding: "utf-8" | "utf-16le" | "utf-16be" | "gb18030" };

function clean(text: string) {
  return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

export function decodeTxt(input: Uint8Array): DecodedTxt {
  const bytes = Buffer.from(input);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: clean(iconv.decode(bytes.subarray(2), "utf16-le")), encoding: "utf-16le" };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: clean(iconv.decode(bytes.subarray(2), "utf16-be")), encoding: "utf-16be" };
  }
  const sample = bytes.subarray(0, Math.min(bytes.length, 64 * 1024));
  const nulRatio = sample.length ? sample.filter((value) => value === 0).length / sample.length : 0;
  if (nulRatio > 0.08) throw new ReaderError("TXT_ENCODING_UNCERTAIN", "无法确认这是可读取的文本文件。TXT_ENCODING_UNCERTAIN");
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0));
    return { text: clean(text), encoding: "utf-8" };
  } catch {
    const candidates = chardet.analyse(sample);
    const hasChineseCandidate = candidates.some((item) => ["gb18030", "gbk", "gb2312", "windows-936"].includes(item.name.toLowerCase()) && item.confidence >= 10);
    if (hasChineseCandidate) {
      const text = clean(iconv.decode(bytes, "gb18030"));
      if (!text.includes("�")) return { text, encoding: "gb18030" };
    }
    throw new ReaderError("TXT_ENCODING_UNCERTAIN", "无法可靠识别 TXT 编码。TXT_ENCODING_UNCERTAIN");
  }
}
