// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { UncategorizedPage } from "../../src/renderer/src/features/library/UncategorizedPage.js";
import type { BookSummary, CollectionDetails, CollectionSummary } from "../../src/shared/contracts.js";

function book(id: string, title: string): BookSummary {
  return { id, title, author: "作者", format: "epub", availabilityStatus: "available", progress: 0,
    addedAt: "2026-01-01T00:00:00.000Z", lastReadAt: null,
    updatedAt: "2026-01-01T00:00:00.000Z", coverUrl: null };
}

function collection(id: string, name: string, books: BookSummary[]): CollectionDetails {
  return { id, name, books, createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z" };
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("lets the user remove a wrong suggestion and search for a missing volume before filing", async () => {
  const first = book("first", "星河物语 第1卷");
  const wrong = book("wrong", "星河物语 第2卷");
  const missing = book("missing", "星河物语 第3卷");
  const existing: CollectionSummary = {
    id: "old", name: "星河物语", bookCount: 0, previewBooks: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const add = vi.fn(async () => ({ id: "old", name: "星河物语", books: [],
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }) as CollectionDetails);
  render(<UncategorizedPage
    books={[first, wrong]}
    libraryBooks={[first, wrong, missing]}
    collections={[existing]}
    busy={false}
    onOpen={vi.fn()}
    onGetMemberships={vi.fn(async () => [])}
    onGetCollection={vi.fn(async () => collection("old", "星河物语", []))}
    onCreateCollection={vi.fn()}
    onAddBooksToCollection={add}
  />);

  expect(add).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /检查系列.*星河物语/ }));
  fireEvent.click(screen.getByRole("button", { name: "移出建议《星河物语 第2卷》" }));
  fireEvent.change(screen.getByRole("searchbox", { name: "查找漏掉的书" }), { target: { value: "第3卷" } });
  fireEvent.click(screen.getByRole("checkbox", { name: /星河物语 第3卷/ }));
  await screen.findByRole("heading", { name: "珍藏现有书籍 0 本" });
  fireEvent.click(screen.getByRole("button", { name: "确认加入珍藏" }));
  await waitFor(() => expect(add).toHaveBeenCalledWith("old", ["first", "missing"]));
});

it("filters unorganized books and selects only the visible results for manual filing", async () => {
  const first = book("first", "星河物语 第1卷");
  const second = book("second", "夜航记");
  const add = vi.fn(async () => ({ id: "old", name: "星河物语", books: [],
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }) as CollectionDetails);
  render(<UncategorizedPage books={[first, second]} collections={[
    { id: "old", name: "星河物语", bookCount: 0, previewBooks: [], updatedAt: "2026-01-01T00:00:00.000Z" },
  ]} busy={false} onOpen={vi.fn()} onGetMemberships={vi.fn(async () => [])}
    onGetCollection={vi.fn(async () => collection("old", "星河物语", []))}
    onCreateCollection={vi.fn()} onAddBooksToCollection={add} />);

  fireEvent.change(screen.getByRole("searchbox", { name: "筛选未整理书籍" }), { target: { value: "夜航" } });
  expect(screen.getByRole("button", { name: "列表显示" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "打开《夜航记》" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "打开《星河物语 第1卷》" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "封面显示" }));
  expect(screen.getByRole("button", { name: "封面显示" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "整理书籍" }));
  fireEvent.click(screen.getByRole("button", { name: "全选当前结果" }));
  expect(screen.getByText("已选择 1 本")).toBeInTheDocument();
});

it("uses one search to narrow both series suggestions and unorganized books", () => {
  const names = ["星河物语 第1卷", "星河物语 第2卷", "夜航 第1卷", "夜航 第2卷"];
  render(<UncategorizedPage books={names.map((name, index) => book(String(index), name))}
    collections={[]} busy={false} onOpen={vi.fn()} onGetMemberships={vi.fn(async () => [])}
    onGetCollection={vi.fn()}
    onCreateCollection={vi.fn()} onAddBooksToCollection={vi.fn()} />);
  fireEvent.change(screen.getByRole("searchbox", { name: "筛选未整理书籍" }), { target: { value: "夜航" } });
  expect(screen.getByRole("button", { name: /检查系列《夜航》/ })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /检查系列《星河物语》/ })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "打开《夜航 第1卷》" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "打开《星河物语 第1卷》" })).not.toBeInTheDocument();
});

it("shows every book in the selected collection beside proposed books with cover images", async () => {
  const proposed = [book("new-1", "星河物语 第4卷"), book("new-2", "星河物语 第5卷")];
  proposed[0]!.coverUrl = "reader-app://covers/new-1";
  const existingBooks = [book("old-1", "星河物语 第1卷"), book("old-2", "星河物语 第2卷"), book("old-3", "星河物语 第3卷")];
  existingBooks[1]!.coverUrl = "reader-app://covers/old-2";
  const details = collection("old", "星河物语", existingBooks);
  const getCollection = vi.fn(async () => details);
  render(<UncategorizedPage books={proposed} libraryBooks={[...proposed, ...existingBooks]}
    collections={[{ id: "old", name: details.name, bookCount: 3, previewBooks: existingBooks.slice(0, 1), updatedAt: details.updatedAt }]}
    busy={false} onOpen={vi.fn()} onGetMemberships={vi.fn(async () => [])}
    onGetCollection={getCollection} onCreateCollection={vi.fn()} onAddBooksToCollection={vi.fn()} />);

  fireEvent.click(screen.getByRole("button", { name: /检查系列.*星河物语/ }));
  expect(screen.getByRole("img", { name: "《星河物语 第4卷》封面" })).toBeInTheDocument();
  const existingList = await screen.findByRole("list", { name: "珍藏现有书籍" });
  expect(existingList).toHaveTextContent("星河物语 第1卷");
  expect(existingList).toHaveTextContent("星河物语 第2卷");
  expect(existingList).toHaveTextContent("星河物语 第3卷");
  expect(screen.getByRole("img", { name: "《星河物语 第2卷》封面" })).toBeInTheDocument();
  expect(getCollection).toHaveBeenCalledWith("old");
});

it("marks books already in the target collection and excludes them from the add request", async () => {
  const proposed = [book("new-1", "星河物语 第4卷"), book("new-2", "星河物语 第5卷")];
  const alreadyThere = book("old-1", "星河物语 第1卷");
  const details = collection("old", "星河物语", [alreadyThere]);
  const add = vi.fn(async () => details);
  render(<UncategorizedPage books={proposed} libraryBooks={[...proposed, alreadyThere]}
    collections={[{ id: "old", name: details.name, bookCount: 1, previewBooks: [alreadyThere], updatedAt: details.updatedAt }]}
    busy={false} onOpen={vi.fn()} onGetMemberships={vi.fn(async () => [])}
    onGetCollection={vi.fn(async () => details)} onCreateCollection={vi.fn()} onAddBooksToCollection={add} />);

  fireEvent.click(screen.getByRole("button", { name: /检查系列.*星河物语/ }));
  fireEvent.change(screen.getByRole("searchbox", { name: "查找漏掉的书" }), { target: { value: "第1卷" } });
  fireEvent.click(screen.getByRole("checkbox", { name: /星河物语 第1卷/ }));
  expect(await screen.findByText("已在该珍藏", { selector: ".series-review__selected *" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "确认加入珍藏" }));
  await waitFor(() => expect(add).toHaveBeenCalledWith("old", ["new-1", "new-2"]));
});

it("warns about a different library record with the same title without blocking the user's choice", async () => {
  const proposed = [book("new-1", "星河物语 第1卷"), book("new-2", "星河物语 第2卷")];
  const existingBook = book("old-1", "星河物语 第1卷");
  const details = collection("old", "星河物语", [existingBook]);
  const add = vi.fn(async () => details);
  render(<UncategorizedPage books={proposed} libraryBooks={[...proposed, existingBook]}
    collections={[{ id: "old", name: details.name, bookCount: 1, previewBooks: [existingBook], updatedAt: details.updatedAt }]}
    busy={false} onOpen={vi.fn()} onGetMemberships={vi.fn(async () => [])}
    onGetCollection={vi.fn(async () => details)} onCreateCollection={vi.fn()} onAddBooksToCollection={add} />);

  fireEvent.click(screen.getByRole("button", { name: /检查系列.*星河物语/ }));
  expect(await screen.findByText("与珍藏现有书籍同名，请核对")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "确认加入珍藏" }));
  await waitFor(() => expect(add).toHaveBeenCalledWith("old", ["new-1", "new-2"]));
});
