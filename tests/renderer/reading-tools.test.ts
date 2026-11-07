// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { parseEpubRunnerCommand, parseEpubRunnerEvent } from "../../src/renderer/src/epub-runner/protocol.js";
import { textOffsetInBlock, rangeForTextOffsets } from "../../src/renderer/src/renditions/txt-dom-range.js";

const identity = { version: 1 as const, bookId: "book-1", sourceRevision: "rev-1", nonce: "nonce-1" };
const location = {
  locatorVersion: 1, sourceRevision: "rev-1", format: "epub", primary: {
    kind: "epub", spineIndex: 0, spineHref: "chapter.xhtml", engineLocator: { kind: "epub-cfi", value: "epubcfi(/6/2!/4/2:0)" },
  }, progression: { resource: 0 }, text: { exact: "hello", prefix: "", suffix: "" },
};

describe("reading interaction protocol", () => {
  it("rejects forged identities and excessive selection text", () => {
    const event = { channel: "reader-epub-event", ...identity, event: "selection", selection: {
      text: "hello", location, rect: { x: 1, y: 2, width: 3, height: 4 },
    } };
    expect(parseEpubRunnerEvent(event, identity)).not.toBeNull();
    expect(parseEpubRunnerEvent({ ...event, nonce: "forged" }, identity)).toBeNull();
    expect(parseEpubRunnerEvent({ ...event, selection: { ...event.selection, text: "x".repeat(100_001) } }, identity)).toBeNull();
  });

  it("validates marks and search commands strictly", () => {
    const envelope = { channel: "reader-epub-command", ...identity };
    expect(parseEpubRunnerCommand({ ...envelope, command: "search", query: "hello", requestId: 1 }, identity)).not.toBeNull();
    expect(parseEpubRunnerCommand({ ...envelope, command: "search", query: "x".repeat(501), requestId: 1 }, identity)).toBeNull();
    expect(parseEpubRunnerCommand({ ...envelope, command: "setMarks", marks: [{ id: "a", location, color: "yellow" }] }, identity)).not.toBeNull();
    expect(parseEpubRunnerCommand({ ...envelope, command: "setMarks", marks: [{ id: "a", location, color: "red" }] }, identity)).toBeNull();
  });
});

describe("TXT DOM range offsets", () => {
  it("counts Unicode code points before a selected range", () => {
    const p = document.createElement("p"); p.textContent = "A😀中B";
    const text = p.firstChild!;
    expect(textOffsetInBlock(p, text, 3)).toBe(2);
    const range = rangeForTextOffsets(p, 1, 3);
    expect(range?.toString()).toBe("😀中");
  });
});
