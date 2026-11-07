import iconv from "iconv-lite";
import { describe, expect, it } from "vitest";
import { decodeTxt } from "../../src/formats/txt/decode.js";
import { parseTxtDocument } from "../../src/formats/txt/chapters.js";

describe("TXT decoding", () => {
  it.each([
    ["utf-8", Buffer.from("书名\n正文", "utf8")],
    ["utf-8", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("书名\n正文", "utf8")])],
    ["utf-16le", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("书名\n正文", "utf16le")])],
    ["gb18030", iconv.encode("书名\n正文", "gb18030")],
  ])("decodes %s text without replacement characters", (encoding, bytes) => {
    const result = decodeTxt(bytes);
    expect(result.encoding).toBe(encoding);
    expect(result.text).toBe("书名\n正文");
  });

  it("rejects NUL-heavy binary input", () => {
    expect(() => decodeTxt(Buffer.from([0, 1, 0, 2, 0, 3, 0, 4]))).toThrowError(/TXT_ENCODING_UNCERTAIN/);
  });
});

describe("TXT chapters", () => {
  it("recognizes markdown-prefixed Chinese episode headings", () => {
    const parsed = parseTxtDocument("书名\n作者[https://example.invalid]\n\n# 第1话 开始\n正文\n# 第2话 继续\n正文", "rev1");
    expect(parsed.title).toBe("书名");
    expect(parsed.author).toBe("作者");
    expect(parsed.chapters.map((item) => item.title)).toEqual(["第1话 开始", "第2话 继续"]);
    expect(parsed.chapters.every((item) => item.id.startsWith("txt-"))).toBe(true);
  });

  it("falls back to one chapter when headings are absent", () => {
    const parsed = parseTxtDocument("书名\n\n普通正文", "rev1");
    expect(parsed.chapters).toHaveLength(1);
    expect(parsed.chapters[0].title).toBe("正文");
  });

  it("preserves prologue and epilogue headings alongside dominant chapter headings and extracts standard author lines", () => {
    const parsed = parseTxtDocument(
      "内容简介：这是一段关于旧信与归途的简介\n作者：林舟\n\n序章 旧信\n序章内容\n第一章 雨夜\n正文一\n第二章 清晨\n正文二\n尾声 归途\n尾声内容",
      "rev1",
      "长夜书.txt",
    );
    expect(parsed.title).toBe("长夜书");
    expect(parsed.author).toBe("林舟");
    expect(parsed.chapters.map((item) => item.title)).toEqual([
      "序章 旧信",
      "第一章 雨夜",
      "第二章 清晨",
      "尾声 归途",
    ]);
  });
});
