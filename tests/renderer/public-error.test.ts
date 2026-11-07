import { describe, expect, it } from "vitest";
import { describeReaderError, parsePublicReaderError } from "../../src/renderer/src/errors/public-error.js";

describe("renderer public errors", () => {
  it("parses direct and Electron-wrapped public error payloads", () => {
    expect(parsePublicReaderError(new Error('{"code":"ARCHIVE_LIMIT","message":"too large"}')))
      .toEqual({ code: "ARCHIVE_LIMIT", message: "too large" });
    expect(parsePublicReaderError(new Error('Error invoking remote method: Error: {"code":"SOURCE_UNAVAILABLE","message":"moved"}')))
      .toEqual({ code: "SOURCE_UNAVAILABLE", message: "moved" });
  });

  it("rejects malformed or unknown payloads", () => {
    expect(parsePublicReaderError(new Error("plain failure")).code).toBe("DATABASE_ERROR");
    expect(parsePublicReaderError(new Error('{"code":"INTERNAL_SECRET","message":"no"}')).code).toBe("DATABASE_ERROR");
  });

  it("maps import and open failures to safe recovery copy without rendering leaked paths", () => {
    const importNotice = describeReaderError(
      new Error(JSON.stringify({ code: "ARCHIVE_LIMIT", message: "E:\\private\\book.epub exploded" })),
      "import-epub",
    );
    expect(importNotice).toEqual({
      code: "ARCHIVE_LIMIT",
      title: "这本 EPUB 超过安全限制",
      detail: "文件体积、解压后内容或压缩比超出允许范围。请换用来源可靠、重新导出的 EPUB。",
    });
    expect(JSON.stringify(importNotice)).not.toContain("E:\\private");

    expect(describeReaderError(new Error('{"code":"SOURCE_UNAVAILABLE","message":"moved"}'), "open-book"))
      .toMatchObject({ code: "SOURCE_UNAVAILABLE", title: "找不到这本书的源文件" });
  });
});