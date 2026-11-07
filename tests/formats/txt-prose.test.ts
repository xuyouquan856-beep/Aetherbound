import { describe, expect, it } from "vitest";
import { parseTxtDocument } from "../../src/formats/txt/chapters.js";

describe("conservative TXT chapter detection", () => {
  it("does not turn prose or volume announcements into chapters", () => {
    const text = [
      "Book",
      "# \u7b2c1\u8bdd \u5f00\u59cb",
      "\u6b63\u6587",
      "\u7b2c\u4e09\u8005\u5f3a\u5236\u6539\u53d8\u72b6\u6001\u3002\u53ea\u770b\u4e00\u773c\u7684\u8bdd\uff0c\u65e0\u6cd5\u5206\u8fa8\u5dee\u5f02\u3002",
      "\u7b2c\u4e09\u5377\u7ec8\u4e8e\u51b3\u5b9a\u5728\u4e09\u6708\u53d1\u552e\u2026\u2026\uff01\u7b2c\u4e09\u5377\u7ec8\u4e8e\u8981\u8fdb\u5165\u65b0\u7ae0\u8282\u4e86\uff01",
      "# \u7b2c2\u8bdd \u7ee7\u7eed",
      "\u6b63\u6587",
    ].join("\n");
    expect(parseTxtDocument(text, "rev1").chapters.map((item) => item.title)).toEqual(["\u7b2c1\u8bdd \u5f00\u59cb", "\u7b2c2\u8bdd \u7ee7\u7eed"]);
  });
});
