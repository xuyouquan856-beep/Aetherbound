import { useSyncExternalStore } from "react";

export type BookShelfPreference = {
  pinned?: boolean;
  coverTone?: number | null;
};

type BookPreferenceMap = Record<string, BookShelfPreference>;

const STORAGE_KEY = "aetherbound.bookPreferences.v1";

let cachedRaw: string | null | undefined;
let cachedSnapshot: BookPreferenceMap = {};
const listeners = new Set<() => void>();

function readPreferences(): BookPreferenceMap {
  let nextRaw: string | null = null;
  try {
    nextRaw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return cachedSnapshot;
  }
  if (nextRaw === cachedRaw) return cachedSnapshot;
  cachedRaw = nextRaw;
  if (!nextRaw) {
    cachedSnapshot = {};
    return cachedSnapshot;
  }
  try {
    const parsed = JSON.parse(nextRaw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      cachedSnapshot = {};
      return cachedSnapshot;
    }
    const clean: BookPreferenceMap = {};
    for (const [bookId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!bookId || !value || typeof value !== "object") continue;
      const record = value as Record<string, unknown>;
      const entry: BookShelfPreference = {};
      if (typeof record.pinned === "boolean") entry.pinned = record.pinned;
      if (
        typeof record.coverTone === "number"
        && Number.isInteger(record.coverTone)
        && record.coverTone >= 0
        && record.coverTone <= 5
      ) {
        entry.coverTone = record.coverTone;
      }
      if (entry.pinned || entry.coverTone !== undefined) {
        clean[bookId] = entry;
      }
    }
    cachedSnapshot = clean;
  } catch {
    cachedSnapshot = {};
  }
  return cachedSnapshot;
}

function writePreferences(next: BookPreferenceMap) {
  cachedSnapshot = next;
  const serialized = JSON.stringify(next);
  cachedRaw = serialized;
  try {
    window.localStorage.setItem(STORAGE_KEY, serialized);
  } catch {
    // Ignore storage quota or security errors
  }
  for (const notify of listeners) notify();
}

function subscribe(notify: () => void) {
  listeners.add(notify);
  window.addEventListener("storage", notify);
  return () => {
    listeners.delete(notify);
    window.removeEventListener("storage", notify);
  };
}

export function useAllBookPreferences(): BookPreferenceMap {
  return useSyncExternalStore(subscribe, readPreferences, readPreferences);
}

export function useBookPreference(bookId: string): BookShelfPreference {
  const all = useAllBookPreferences();
  return all[bookId] ?? {};
}

export function isBookPinned(bookId: string): boolean {
  return Boolean(readPreferences()[bookId]?.pinned);
}

export function toggleBookPinned(bookId: string): boolean {
  const current = readPreferences();
  const prev = current[bookId] ?? {};
  const nextPinned = !prev.pinned;
  const nextMap = { ...current };
  const updated: BookShelfPreference = { ...prev, pinned: nextPinned };
  if (!updated.pinned && updated.coverTone === undefined) {
    delete nextMap[bookId];
  } else {
    nextMap[bookId] = updated;
  }
  writePreferences(nextMap);
  return nextPinned;
}

export function setBookCoverTone(bookId: string, coverTone: number | null) {
  const current = readPreferences();
  const prev = current[bookId] ?? {};
  const nextMap = { ...current };
  const updated: BookShelfPreference = { ...prev };
  if (coverTone === null || coverTone < 0 || coverTone > 5) {
    delete updated.coverTone;
  } else {
    updated.coverTone = coverTone;
  }
  if (!updated.pinned && updated.coverTone === undefined) {
    delete nextMap[bookId];
  } else {
    nextMap[bookId] = updated;
  }
  writePreferences(nextMap);
}
