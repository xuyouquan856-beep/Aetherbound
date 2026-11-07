// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LibraryHome } from "../../src/renderer/src/features/library/LibraryHome.js";
import type { BookSummary, CollectionSummary } from "../../src/shared/contracts.js";

function book(
  id: string,
  title: string,
  overrides: Partial<BookSummary> = {},
): BookSummary {
  return {
    id,
    title,
    author: null,
    format: "epub",
    coverUrl: null,
    availabilityStatus: "available",
    progress: 0,
    addedAt: "2026-07-20T00:00:00.000Z",
    lastReadAt: null,
    updatedAt: "2026-07-20T00:00:00.000Z",
    ...overrides,
  };
}

function collection(index: number): CollectionSummary {
  return {
    id: `collection-${index}`,
    name: `珍藏 ${index}`,
    bookCount: 1,
    previewBooks: [book(`preview-${index}`, `预览 ${index}`)],
    updatedAt: `2026-07-${String(20 + index).padStart(2, "0")}T00:00:00.000Z`,
  };
}

afterEach(cleanup);

describe("LibraryHome", () => {
  it("orders meaningful sections and chooses the newest unfinished reading activity", () => {
    const books = [
      book("older", "旧阅读", { progress: 0.8, lastReadAt: "2026-07-20T00:00:00.000Z" }),
      book("newer", "新阅读", { progress: 0.2, lastReadAt: "2026-07-29T00:00:00.000Z" }),
      book("finished", "已读完", { progress: 1, lastReadAt: "2026-07-30T00:00:00.000Z" }),
      book("recent", "刚刚加入", { addedAt: "2026-07-31T00:00:00.000Z" }),
    ];
    render(
      <LibraryHome
        books={books}
        collections={Array.from({ length: 8 }, (_, index) => collection(index))}
        unorganizedCount={3}
        onOpen={vi.fn()}
        onNavigateToBooks={vi.fn()}
        onNavigateToCollections={vi.fn()}
        onNavigateUnorganized={vi.fn()}
      />,
    );

    expect(screen.getAllByRole("region").map((section) => section.getAttribute("aria-label")))
      .toEqual(["继续阅读", "首页摘录", "最近加入", "我的珍藏", "等待整理"]);
    expect(screen.getByRole("button", { name: /继续阅读《新阅读》/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /继续阅读《已读完》/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText("我的珍藏").querySelectorAll("[data-collection-stack]"))
      .toHaveLength(6);
    expect(screen.getByLabelText("最近加入")).toHaveTextContent("刚刚加入");
  });

  it("omits empty home sections", () => {
    render(
      <LibraryHome
        books={[]}
        collections={[]}
        unorganizedCount={0}
        onOpen={vi.fn()}
        onNavigateToBooks={vi.fn()}
        onNavigateToCollections={vi.fn()}
        onNavigateUnorganized={vi.fn()}
      />,
    );

    expect(screen.getAllByRole("region").map((section) => section.getAttribute("aria-label")))
      .toEqual(["继续阅读", "首页摘录"]);
    expect(screen.queryByLabelText("最近加入")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("我的珍藏")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("等待整理")).not.toBeInTheDocument();
    expect(screen.getByText("把想读的书放在这里")).toBeInTheDocument();
  });
});
