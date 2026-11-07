// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ShelfPreferenceDefaults,
  useShelfViewPreferences,
} from "../../src/renderer/src/features/library/shelf-preferences.js";

beforeEach(() => window.localStorage.clear());
afterEach(() => window.localStorage.clear());

describe("shelf view preferences", () => {
  it("starts from the defaults when nothing is stored", () => {
    const { result } = renderHook(() => useShelfViewPreferences());
    expect(result.current.displayMode).toBe(ShelfPreferenceDefaults.displayMode);
    expect(result.current.sort).toBe(ShelfPreferenceDefaults.sort);
    expect(result.current.filter).toBe(ShelfPreferenceDefaults.filter);
  });

  it("persists each choice under its own key", () => {
    const { result } = renderHook(() => useShelfViewPreferences());

    act(() => result.current.setDisplayMode("list"));
    act(() => result.current.setSort("title"));
    act(() => result.current.setFilter("epub"));

    expect(window.localStorage.getItem("aetherbound.shelf.displayMode")).toBe("list");
    expect(window.localStorage.getItem("aetherbound.shelf.sort")).toBe("title");
    expect(window.localStorage.getItem("aetherbound.shelf.filter")).toBe("epub");
    expect(result.current.displayMode).toBe("list");
  });

  it("restores a stored choice on the next mount", () => {
    // This is the actual defect: leaving the view and returning used to reset it.
    window.localStorage.setItem("aetherbound.shelf.displayMode", "compact");
    window.localStorage.setItem("aetherbound.shelf.sort", "author");
    window.localStorage.setItem("aetherbound.shelf.filter", "finished");

    const { result } = renderHook(() => useShelfViewPreferences());
    expect(result.current.displayMode).toBe("compact");
    expect(result.current.sort).toBe("author");
    expect(result.current.filter).toBe("finished");
  });

  it("ignores a stored value that is not an accepted option", () => {
    // A stale or hand-edited value must not reach the query and empty the shelf.
    window.localStorage.setItem("aetherbound.shelf.displayMode", "huge");
    window.localStorage.setItem("aetherbound.shelf.sort", "by-vibes");

    const { result } = renderHook(() => useShelfViewPreferences());
    expect(result.current.displayMode).toBe(ShelfPreferenceDefaults.displayMode);
    expect(result.current.sort).toBe(ShelfPreferenceDefaults.sort);
  });

  it("refuses to persist an invalid value", () => {
    const { result } = renderHook(() => useShelfViewPreferences());
    act(() => result.current.setDisplayMode("nonsense" as never));
    expect(result.current.displayMode).toBe(ShelfPreferenceDefaults.displayMode);
    expect(window.localStorage.getItem("aetherbound.shelf.displayMode")).toBeNull();
  });

  it("keeps working when storage rejects writes", () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new Error("quota exceeded"); };
    try {
      const { result } = renderHook(() => useShelfViewPreferences());
      // The in-memory value still updates even though it cannot be persisted.
      act(() => result.current.setDisplayMode("list"));
      expect(result.current.displayMode).toBe("list");
    } finally {
      Storage.prototype.setItem = original;
    }
  });
});
