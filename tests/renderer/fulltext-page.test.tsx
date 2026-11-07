// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FulltextSearchPage } from "../../src/renderer/src/features/library/FulltextSearchPage.js";
import type { FulltextSearchResult } from "../../src/shared/contracts.js";

afterEach(() => cleanup());

type S = (q: string) => Promise<FulltextSearchResult[]>;
const stub = (): S => vi.fn() as any;

describe("FulltextSearchPage", () => {
  it("loads the next page of matches and appends it to the first page", async () => {
    const firstPage = Array.from({ length: 20 }, (_, index) => ({
      bookId: `book-${index}`, title: `Book ${index}`, matchSnippet: "match", unitIndex: index,
    }));
    const nextPage = [{ bookId: "book-20", title: "Book 20", matchSnippet: "match", unitIndex: 20 }];
    const onSearch = vi.fn(async (_query: string, offset?: number) => offset === 20 ? nextPage : firstPage);
    render(<FulltextSearchPage onSearch={onSearch} onOpenBook={vi.fn()} />);
    fireEvent.change(screen.getByRole("searchbox", { name: "全文搜索关键词" }), { target: { value: "match" } });
    fireEvent.click(screen.getByRole("button", { name: /^搜索$/ }));
    await waitFor(() => expect(screen.getByText("Book 19")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "加载更多结果" }));
    await waitFor(() => expect(screen.getByText("Book 20")).toBeTruthy());
    expect(onSearch).toHaveBeenNthCalledWith(2, "match", 20);
    expect(screen.getByText("Book 0")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "加载更多结果" })).toBeNull();
  });
  it("shows search input and button", () => {
    render(<FulltextSearchPage onSearch={stub()} onOpenBook={vi.fn()} />);
    expect(screen.getByRole("searchbox", { name: "全文搜索关键词" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^搜索$/ })).toBeTruthy();
  });

  it("search button disabled when query is empty", () => {
    render(<FulltextSearchPage onSearch={stub()} onOpenBook={vi.fn()} />);
    expect(screen.getByRole("button", { name: /^搜索$/ })).toBeDisabled();
  });

  it("submits query and shows loading", async () => {
    const onSearch = vi.fn(() => new Promise(() => {})) as any as S;
    render(<FulltextSearchPage onSearch={onSearch} onOpenBook={vi.fn()} />);
    fireEvent.change(screen.getByRole("searchbox", { name: "全文搜索关键词" }), { target: { value: "test" } });
    fireEvent.click(screen.getByRole("button", { name: /^搜索$/ }));
    expect(onSearch).toHaveBeenCalledWith("test");
    expect(screen.getByRole("button", { name: /搜索中/ })).toBeTruthy();
  });

  it("displays results in plain text", async () => {
    const results = [{ bookId: "b1", title: "Book One", matchSnippet: "hello <b>world</b>", unitIndex: 0 }];
    const { container } = render(<FulltextSearchPage onSearch={async () => results} onOpenBook={vi.fn()} />);
    fireEvent.change(screen.getByRole("searchbox", { name: "全文搜索关键词" }), { target: { value: "world" } });
    fireEvent.click(screen.getByRole("button", { name: /^搜索$/ }));
    await waitFor(() => { expect(screen.getByText("Book One")).toBeTruthy(); });
    const snippet = container.querySelector(".search-result-snippet");
    expect(snippet?.textContent).toContain("hello <b>world</b>");
    expect(snippet?.querySelector("b")).toBeNull();
  });

  it("shows empty state when no results", async () => {
    render(<FulltextSearchPage onSearch={async () => []} onOpenBook={vi.fn()} />);
    fireEvent.change(screen.getByRole("searchbox", { name: "全文搜索关键词" }), { target: { value: "xyz" } });
    fireEvent.click(screen.getByRole("button", { name: /^搜索$/ }));
    await waitFor(() => { expect(screen.getByText(/未找到匹配结果/)).toBeTruthy(); });
  });

  it("shows error on search failure", async () => {
    render(<FulltextSearchPage onSearch={async () => { throw new Error("SEARCH_ERR"); }} onOpenBook={vi.fn()} />);
    fireEvent.change(screen.getByRole("searchbox", { name: "全文搜索关键词" }), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: /^搜索$/ }));
    await waitFor(() => { expect(screen.getByText(/SEARCH_ERR/)).toBeTruthy(); });
  });

  it("clicking result calls onOpenBook", async () => {
    const onOpen = vi.fn();
    const results = [{ bookId: "b1", title: "T", matchSnippet: "s", unitIndex: 0 }];
    render(<FulltextSearchPage onSearch={async () => results} onOpenBook={onOpen} />);
    fireEvent.change(screen.getByRole("searchbox", { name: "全文搜索关键词" }), { target: { value: "t" } });
    fireEvent.click(screen.getByRole("button", { name: /^搜索$/ }));
    await waitFor(() => { expect(screen.getByText("T")).toBeTruthy(); });
    fireEvent.click(screen.getByText("T"));
    expect(onOpen).toHaveBeenCalledWith("b1");
  });
});
