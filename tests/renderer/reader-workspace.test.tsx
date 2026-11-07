// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useReaderWorkspace } from "../../src/renderer/src/features/reader/useReaderWorkspace.js";
import type { ReaderApi, ReadingLocationV1 } from "../../src/shared/contracts.js";

afterEach(cleanup);
const location: ReadingLocationV1 = { locatorVersion: 1, sourceRevision: "r", format: "txt", primary: { kind: "txt", chapterId: "c", characterOffset: 3 }, progression: { resource: .1 }, text: { exact: "星空", prefix: "", suffix: "" } };
function setup(fail = false) {
  const save = vi.fn(async (input: object) => { if (fail) throw new Error("disk full"); return { ...input, id: "record", createdAt: "now", updatedAt: "now" }; });
  const api = { records: { list: vi.fn(async () => []), save, remove: vi.fn() } } as unknown as ReaderApi;
  const navigate = vi.fn(); const clearSelection = vi.fn(); const setMarks = vi.fn();
  const result = renderHook(() => useReaderWorkspace({ api, book: { id: "b", title: "书", author: "作者" }, sourceRevision: "r", navigate, clearSelection, setMarks, search: async () => [], active: true }));
  return { ...result, save, navigate, clearSelection };
}
it("saves the full selected quote and keeps source position", async () => {
  const { result, save, clearSelection } = setup();
  act(() => result.current.setSelection({ text: "长句与星空", location, rect: { x: 10, y: 30, width: 100, height: 20 } }));
  await act(async () => { await result.current.saveSelection("quote"); });
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ kind: "quote", text: "长句与星空", location, bookId: "b", enabled: true }));
  expect(clearSelection).toHaveBeenCalled();
});
it("retains selected text and reports failure when record saving fails", async () => {
  const { result, clearSelection } = setup(true);
  act(() => result.current.setSelection({ text: "不要丢失", location, rect: { x: 0, y: 0, width: 20, height: 20 } }));
  await act(async () => { await result.current.saveSelection("quote"); });
  expect(result.current.selection?.text).toBe("不要丢失");
  expect(result.current.error).toBeTruthy();
  expect(clearSelection).not.toHaveBeenCalled();
});
it("blocks obsolete source jumps instead of pretending the quote is found", async () => {
  const { result, navigate } = setup();
  act(() => result.current.jump({ ...location, sourceRevision: "old" }));
  expect(navigate).not.toHaveBeenCalled();
  await waitFor(() => expect(result.current.error).toContain("版本"));
});

it("refreshes records when a retained reader becomes active again", async () => {
  const list = vi.fn(async () => []);
  const api = { records: { list } } as unknown as ReaderApi;
  const { rerender } = renderHook(({ active }) => useReaderWorkspace({ api, book: { id: "b", title: "书", author: null }, sourceRevision: "r", navigate: vi.fn(), clearSelection: vi.fn(), setMarks: vi.fn(), search: async () => [], active }), { initialProps: { active: true } });
  await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
  rerender({ active: false });
  rerender({ active: true });
  await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
});

it("keeps a newly saved record when an older list request resolves late", async () => {
  let resolveList!: (items: []) => void;
  const list = vi.fn(() => new Promise<[]>((resolve) => { resolveList = resolve; }));
  const api = { records: { list, save: vi.fn(async (input) => ({ ...input, id: "new", createdAt: "now", updatedAt: "now" })) } } as unknown as ReaderApi;
  const { result } = renderHook(() => useReaderWorkspace({ api, book: { id: "b", title: "书", author: null }, sourceRevision: "r", navigate: vi.fn(), clearSelection: vi.fn(), setMarks: vi.fn(), search: async () => [], active: true }));
  act(() => result.current.onLocation(location));
  await act(async () => { await result.current.addBookmark("书签"); });
  await act(async () => { resolveList([]); });
  expect(result.current.records).toHaveLength(1);
});

it("collects long text without claiming it participates in home rotation", async () => {
  const { result, save } = setup();
  act(() => result.current.setSelection({ text: "长".repeat(221), location, rect: { x: 0, y: 0, width: 20, height: 20 } }));
  await act(async () => { await result.current.saveSelection("quote"); });
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  expect(result.current.notice).toContain("节选");
});
