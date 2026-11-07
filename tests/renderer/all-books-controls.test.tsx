// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AllBooksView } from "../../src/renderer/src/features/library/AllBooksView.js";
import type {
  BookSummary,
  CollectionDetails,
  CollectionSummary,
} from "../../src/shared/contracts.js";

function book(id: string, title: string, progress = 0): BookSummary {
  return {
    id,
    title,
    author: id === "book-1" ? "林舟" : "顾遥",
    format: id === "book-3" ? "txt" : "epub",
    coverUrl: null,
    availabilityStatus: "available",
    progress,
    addedAt: `2026-07-2${id.at(-1)}T00:00:00.000Z`,
    lastReadAt: null,
    updatedAt: "2026-07-29T00:00:00.000Z",
  };
}

function collection(id: string, name: string, bookCount = 0): CollectionSummary {
  return {
    id,
    name,
    bookCount,
    previewBooks: [],
    updatedAt: "2026-07-29T00:00:00.000Z",
  };
}

function details(summary: CollectionSummary, books: BookSummary[] = []): CollectionDetails {
  return {
    id: summary.id,
    name: summary.name,
    books,
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: summary.updatedAt,
  };
}

const books = [
  book("book-1", "长夜书", 0),
  book("book-2", "星海书", 0.5),
  book("book-3", "终幕书", 1),
];

const collections = [
  collection("complete", "已经收录", 2),
  collection("partial", "部分收录", 1),
  collection("empty-a", "待读", 0),
  collection("empty-b", "轻小说", 0),
];

function renderView(overrides: Partial<Parameters<typeof AllBooksView>[0]> = {}) {
  const props: Parameters<typeof AllBooksView>[0] = {
    books,
    collections,
    query: "",
    busy: false,
    notice: null,
    onImportFiles: vi.fn(),
    onOpen: vi.fn(),
    onRemove: vi.fn(async () => true),
    onGetMemberships: vi.fn(async () => [
      { collectionId: "complete", bookIds: ["book-1", "book-2"] },
      { collectionId: "partial", bookIds: ["book-1"] },
    ]),
    onCreateCollection: vi.fn(async (name) => details(collection("created", name))),
    onAddBooksToCollection: vi.fn(async (id, selectedIds) =>
      details(collection(id, id), books.filter((item) => selectedIds.includes(item.id)))),
    ...overrides,
  };
  render(<AllBooksView {...props} />);
  return props;
}

// The shelf view controls persist to localStorage, and jsdom keeps one storage
// across the tests in this file, so a filter chosen in one test would otherwise
// leak into the next. Reset before every test.
beforeEach(() => window.localStorage.clear());

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("AllBooksView organization controls", () => {
  it("enters edit mode and selects a book after a long press without opening it", () => {
    vi.useFakeTimers();
    const props = renderView();
    const tile = screen.getByRole("button", { name: "打开《长夜书》" });
    fireEvent.pointerDown(tile, { pointerType: "mouse", pointerId: 1, button: 0, clientX: 20, clientY: 20 });
    act(() => vi.advanceTimersByTime(550));
    expect(screen.getByText("已选择 1 本")).toBeInTheDocument();
    fireEvent.pointerUp(tile, { pointerType: "mouse", pointerId: 1 });
    fireEvent.click(screen.getByRole("button", { name: "取消选择《长夜书》" }));
    expect(props.onOpen).not.toHaveBeenCalled();
  });

  it("offers an opt-in original-file deletion choice in the removal confirmation", async () => {
    const props = renderView();
    fireEvent.click(screen.getByRole("button", { name: "编辑书架" }));
    fireEvent.click(screen.getByRole("button", { name: "选择《长夜书》" }));
    fireEvent.click(screen.getByRole("button", { name: "移出书架" }));
    const deleteOriginal = screen.getByRole("checkbox", { name: /同时删除原始文件/ });
    expect(deleteOriginal).not.toBeChecked();
    fireEvent.click(deleteOriginal);
    fireEvent.click(screen.getByRole("button", { name: "确认移出" }));
    await waitFor(() => expect(props.onRemove).toHaveBeenCalledWith(["book-1"], true));
  });

  it("opens the unorganized series review from the bookshelf", () => {
    const onNavigateUnorganized = vi.fn();
    renderView({ onNavigateUnorganized });
    fireEvent.click(screen.getByRole("button", { name: "整理系列" }));
    expect(onNavigateUnorganized).toHaveBeenCalledOnce();
  });

  it("exposes sorting, filtering, and display density controls", () => {
    renderView();

    expect(within(screen.getByLabelText("排序")).getAllByRole("option")).toHaveLength(5);
    expect(within(screen.getByLabelText("筛选")).getAllByRole("option")).toHaveLength(6);
    expect(screen.getByRole("group", { name: "显示方式" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "舒适封面" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "紧凑封面" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "列表" })).toBeInTheDocument();
  });

  it("selects only the current filtered result and describes existing memberships", async () => {
    const props = renderView();
    fireEvent.change(screen.getByLabelText("筛选"), { target: { value: "reading" } });
    fireEvent.click(screen.getByRole("button", { name: "编辑书架" }));

    expect(screen.getByRole("button", { name: "加入珍藏" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "全选当前结果" }));
    expect(screen.getByText("已选择 1 本")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "加入珍藏" }));

    await waitFor(() => expect(props.onGetMemberships).toHaveBeenCalledWith(["book-2"]));
    expect(screen.getByRole("checkbox", { name: /已经收录/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /已经收录/ })).toBeDisabled();
    expect(screen.getByText("已包含全部 1 本")).toBeInTheDocument();
    const partial = screen.getByRole("checkbox", { name: /部分收录/ });
    expect(partial).not.toBeChecked();
    expect(within(partial.closest("label")!).getByText("已包含 0 本，可加入 1 本"))
      .toBeInTheDocument();
  });

  it("adds missing memberships to multiple collections without removing existing ones", async () => {
    const onAddBooksToCollection = vi.fn(async (id: string, selectedIds: string[]) =>
      details(collection(id, id), books.filter((item) => selectedIds.includes(item.id))));
    renderView({ onAddBooksToCollection });

    fireEvent.click(screen.getByRole("button", { name: "编辑书架" }));
    fireEvent.click(screen.getByRole("button", { name: "全选当前结果" }));
    fireEvent.click(screen.getByRole("button", { name: "加入珍藏" }));

    fireEvent.click(await screen.findByRole("checkbox", { name: /待读/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /轻小说/ }));
    fireEvent.click(screen.getByRole("button", { name: "加入所选珍藏" }));

    await waitFor(() => expect(onAddBooksToCollection).toHaveBeenCalledTimes(2));
    expect(onAddBooksToCollection).toHaveBeenCalledWith("empty-a", ["book-1", "book-2", "book-3"]);
    expect(onAddBooksToCollection).toHaveBeenCalledWith("empty-b", ["book-1", "book-2", "book-3"]);
    expect(onAddBooksToCollection).not.toHaveBeenCalledWith("complete", expect.anything());
  });

  it("adds only missing books when a partially populated collection is chosen", async () => {
    const onAddBooksToCollection = vi.fn(async (id: string, selectedIds: string[]) =>
      details(collection(id, id), books.filter((item) => selectedIds.includes(item.id))));
    renderView({ onAddBooksToCollection });

    fireEvent.click(screen.getByRole("button", { name: "编辑书架" }));
    fireEvent.click(screen.getByRole("button", { name: "全选当前结果" }));
    fireEvent.click(screen.getByRole("button", { name: "加入珍藏" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: /部分收录/ }));
    fireEvent.click(screen.getByRole("button", { name: "加入所选珍藏" }));

    await waitFor(() => expect(onAddBooksToCollection).toHaveBeenCalledWith(
      "partial",
      ["book-2", "book-3"],
    ));
  });

  it("creates a collection inline and adds all selected books", async () => {
    const onCreateCollection = vi.fn(async (name: string) =>
      details(collection("new-collection", name)));
    const onAddBooksToCollection = vi.fn(async (id: string, selectedIds: string[]) =>
      details(collection(id, "夜航"), books.filter((item) => selectedIds.includes(item.id))));
    renderView({ onCreateCollection, onAddBooksToCollection });

    fireEvent.click(screen.getByRole("button", { name: "编辑书架" }));
    fireEvent.click(screen.getByRole("button", { name: "选择《长夜书》" }));
    fireEvent.click(screen.getByRole("button", { name: "加入珍藏" }));
    fireEvent.change(await screen.findByLabelText("新珍藏名称"), { target: { value: "夜航" } });
    fireEvent.click(screen.getByRole("button", { name: "创建并加入" }));

    await waitFor(() => expect(onCreateCollection).toHaveBeenCalledWith("夜航"));
    expect(onAddBooksToCollection).toHaveBeenCalledWith("new-collection", ["book-1"]);
  });
});
