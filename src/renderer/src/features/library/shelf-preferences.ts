import { useCallback, useState } from "react";

/**
 * Shelf display preferences (display mode, sort order, filter).
 *
 * These live in component state today, which means navigating away from 全部书籍
 * and back resets them, because App unmounts the view when the page changes.
 *
 * They are persisted in localStorage rather than the SQLite `settings` table:
 * localStorage is synchronous, so the preference is already applied on the first
 * render (no flash of the default layout), needs no IPC round-trip or migration,
 * and is scoped to this window by design. These are per-window UI chrome, whereas
 * the settings table holds domain preferences like reading appearance.
 */

export const BookDisplayModeValues = ["comfortable", "compact", "list"] as const;
export type BookDisplayMode = (typeof BookDisplayModeValues)[number];

/**
 * Single source of truth for the sort/filter unions; `library-query.ts` derives its
 * types from these arrays so the persisted values and the query logic cannot drift.
 */
export const LibrarySortValues = ["added-desc", "last-read-desc", "title", "author", "progress-desc"] as const;
export type LibrarySort = (typeof LibrarySortValues)[number];

export const LibraryFilterValues = ["all", "unread", "reading", "finished", "epub", "txt"] as const;
export type LibraryFilter = (typeof LibraryFilterValues)[number];

export const LibrarySortDirectionValues = ["default", "reverse"] as const;
export type LibrarySortDirection = (typeof LibrarySortDirectionValues)[number];

export const LibraryFormatFilterValues = ["all", "epub", "txt"] as const;
export type LibraryFormatFilter = (typeof LibraryFormatFilterValues)[number];

export const ShelfPreferenceDefaults = {
  displayMode: "comfortable",
  sort: "added-desc",
  filter: "all",
} as const satisfies {
  displayMode: BookDisplayMode;
  sort: LibrarySort;
  filter: LibraryFilter;
};

const STORAGE_KEYS = {
  displayMode: "aetherbound.shelf.displayMode",
  sort: "aetherbound.shelf.sort",
  filter: "aetherbound.shelf.filter",
  sortDirection: "aetherbound.shelf.sortDirection",
  formatFilter: "aetherbound.shelf.formatFilter",
  pinnedOnly: "aetherbound.shelf.pinnedOnly",
} as const;

type ShelfPreferenceKey = keyof typeof STORAGE_KEYS;

/** Private-mode Safari and hardened profiles can throw on storage access. */
function readStored(key: ShelfPreferenceKey): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEYS[key]);
  } catch {
    return null;
  }
}

function writeStored(key: ShelfPreferenceKey, value: string) {
  try {
    window.localStorage.setItem(STORAGE_KEYS[key], value);
  } catch {
    // A preference that cannot be stored must never break the shelf.
  }
}

/**
 * Reads a stored preference, falling back to the default when the value is missing
 * or is not one of the accepted options. Validating matters: a stale or hand-edited
 * value would otherwise flow straight into the query and produce an empty shelf.
 */
function useStoredPreference<T extends string>(
  key: ShelfPreferenceKey,
  allowed: readonly T[],
  fallback: T,
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const stored = readStored(key);
    return stored !== null && (allowed as readonly string[]).includes(stored)
      ? stored as T
      : fallback;
  });

  const update = useCallback((next: T) => {
    if (!(allowed as readonly string[]).includes(next)) return;
    setValue(next);
    writeStored(key, next);
  }, [allowed, key]);

  return [value, update];
}

export function useShelfViewPreferences() {
  const [displayMode, setDisplayMode] = useStoredPreference(
    "displayMode", BookDisplayModeValues, ShelfPreferenceDefaults.displayMode,
  );
  const [sort, setSort] = useStoredPreference(
    "sort", LibrarySortValues, ShelfPreferenceDefaults.sort,
  );
  const [filter, setFilter] = useStoredPreference(
    "filter", LibraryFilterValues, ShelfPreferenceDefaults.filter,
  );
  const [sortDirection, setSortDirection] = useStoredPreference(
    "sortDirection", LibrarySortDirectionValues, "default",
  );
  const [formatFilter, setFormatFilter] = useStoredPreference(
    "formatFilter", LibraryFormatFilterValues, "all",
  );
  const [pinnedOnlyStr, setPinnedOnlyStr] = useStoredPreference(
    "pinnedOnly", ["off", "on"] as const, "off",
  );

  return {
    displayMode,
    setDisplayMode,
    sort,
    setSort,
    filter,
    setFilter,
    sortDirection,
    setSortDirection,
    formatFilter,
    setFormatFilter,
    pinnedOnly: pinnedOnlyStr === "on",
    setPinnedOnly: (next: boolean) => setPinnedOnlyStr(next ? "on" : "off"),
  };
}

