// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChapterSidebar } from "../../src/renderer/src/features/reader/ChapterSidebar.js";
afterEach(cleanup);
it("collapses nested chapters and searches within collapsed sections", () => {
  const chapters = [ { id: "a.xhtml#part", title: "第一卷", depth: 0 }, { id: "a.xhtml#one", title: "清晨", depth: 1 }, { id: "b.xhtml", title: "第二卷", depth: 0 } ].map((chapter,index) => ({ ...chapter, index, startOffset: 0, endOffset: 10 }));
  render(<ChapterSidebar chapters={chapters} activeId="a.xhtml" open onSelect={vi.fn()} onClose={vi.fn()} />);
  expect(screen.getByRole("button", { name: "1第一卷" })).toHaveAttribute("data-active", "true");
  fireEvent.click(screen.getByRole("button", { name: "折叠章节" }));
  expect(screen.queryByRole("button", { name: /清晨/ })).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole("textbox", { name: "查找章节" }), { target: { value: "清晨" } });
  expect(screen.getByRole("button", { name: /清晨/ })).toBeInTheDocument();
});
