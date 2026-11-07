// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { DefaultReadingAppearance } from "../../src/shared/contracts.js";
import { TxtRendition, type TxtRenditionHandle } from "../../src/renderer/src/renditions/TxtRendition.js";

afterEach(cleanup);

it("returns current chapter Unicode search ranges with code point offsets", async () => {
  const ref = createRef<TxtRenditionHandle>();
  render(<TxtRendition ref={ref} content={{
    bookId: "book-1", sourceRevision: "rev-1", chapter: { id: "chapter-1", title: "One", index: 0, startOffset: 0, endOffset: 8 },
    text: "A😀中B 😀中", totalCharacters: 8,
  }} appearance={DefaultReadingAppearance} restoreLocation={null} chapterCount={1}
  onLocation={vi.fn()} onBoundary={vi.fn()} initialEdge="start" />);
  const results = await ref.current!.search("😀中");
  expect(results.map((result) => result.location.format === "txt" && result.location.primary.characterOffset)).toEqual([1, 5]);
  expect(results.map((result) => result.endLocation?.format === "txt" && result.endLocation.primary.characterOffset)).toEqual([3, 7]);
});
