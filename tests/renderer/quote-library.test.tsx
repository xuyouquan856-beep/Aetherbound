// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuoteLibrary } from "../../src/renderer/src/features/quotes/QuoteLibrary.js";
import type { ReadingRecord, ReadingRecordsApi } from "../../src/shared/reading-records.js";

afterEach(cleanup);

function record(index: number): ReadingRecord {
  return { id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, kind: "quote", bookId: null,
    bookTitle: `Book ${index}`, author: "Author", text: `Line ${index}`, excerpt: "", sourceUrl: "", note: "", color: "cyan",
    location: null, endLocation: null, enabled: true, pinned: false,
    createdAt: "2026-10-06T00:00:00.000Z", updatedAt: "2026-10-06T00:00:00.000Z" };
}

describe("quote library", () => {
  it("shows a bounded page and filters by text", async () => {
    const api = { list: vi.fn(async () => Array.from({ length: 15 }, (_, index) => record(index + 1))) } as unknown as ReadingRecordsApi;
    render(<QuoteLibrary api={api} books={[]} onOpenSource={vi.fn()} />);
    await screen.findByText("Line 1");
    expect(screen.getAllByRole("article")).toHaveLength(12);
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(screen.getAllByRole("article")).toHaveLength(3);
    fireEvent.change(screen.getByLabelText("搜索摘录"), { target: { value: "Line 15" } });
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(screen.getByText("Line 15")).toBeInTheDocument();
  });

  it("saves a manual quote through the record API", async () => {
    const api = { list: vi.fn(async () => []), save: vi.fn(async (input) => ({ ...record(1), ...input })) } as unknown as ReadingRecordsApi;
    render(<QuoteLibrary api={api} books={[]} onOpenSource={vi.fn()} />);
    await screen.findByText(/摘录库还是空的/);
    fireEvent.click(screen.getByRole("button", { name: "添加摘录" }));
    fireEvent.change(screen.getByLabelText("摘录原文"), { target: { value: "New words" } });
    fireEvent.change(screen.getByLabelText("作品 / 书名"), { target: { value: "New Book" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.save).toHaveBeenCalledWith(expect.objectContaining({
      kind: "quote", bookId: null, bookTitle: "New Book", text: "New words", location: null,
    })));
    await waitFor(() => expect(screen.getByRole("button", { name: "查看摘录：New words" })).toBeInTheDocument());
  });

  it("retries only unfinished imported entries after a partial failure", async () => {
    const save = vi.fn().mockImplementationOnce(async input => ({ ...record(1), ...input })).mockRejectedValueOnce(new Error("disk"))
      .mockImplementation(async input => ({ ...record(2), ...input }));
    const api = { list: vi.fn(async () => []), save } as unknown as ReadingRecordsApi;
    render(<QuoteLibrary api={api} books={[]} onOpenSource={vi.fn()} />);
    await screen.findByText(/摘录库还是空的/);
    fireEvent.click(screen.getByRole("button", { name: "导入" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: JSON.stringify([{ text: "First" }, { text: "Second" }]) } });
    fireEvent.click(within(dialog).getByRole("button", { name: /导入所选/ }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: /导入所选/ })).toBeEnabled());
    fireEvent.click(within(dialog).getByRole("button", { name: /导入所选/ }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(3));
    expect(save.mock.calls.map(call => call[0].text)).toEqual(["First", "Second", "Second"]);
  });
});
