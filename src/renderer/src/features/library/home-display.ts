import { useSyncExternalStore } from "react";
import type { BookSummary } from "../../../../shared/contracts.js";

export type HomeDisplay = { mode: "auto" | "custom"; front: string; back: string };
const key = "aetherbound.home.display";
const automatic: HomeDisplay = { mode: "auto", front: "", back: "" };
let cachedRaw: string | null | undefined;
let cached = automatic;
const listeners = new Set<() => void>();
function read() {
  let raw: string | null = null;
  try { raw = localStorage.getItem(key); } catch { return cached; }
  if (raw === cachedRaw) return cached;
  cachedRaw = raw;
  try {
    const value = JSON.parse(raw ?? "null");
    cached = value && ["auto", "custom"].includes(value.mode) && typeof value.front === "string" && typeof value.back === "string" ? value : automatic;
  } catch { cached = automatic; }
  return cached;
}
export function saveHomeDisplay(value: HomeDisplay) {
  localStorage.setItem(key, JSON.stringify(value));
  listeners.forEach(notify => notify());
}
function subscribe(notify: () => void) {
  listeners.add(notify);
  window.addEventListener("storage", notify);
  return () => { listeners.delete(notify); window.removeEventListener("storage", notify); };
}
export function useHomeDisplay() { return useSyncExternalStore(subscribe, read, read); }
export function resolveHomeDisplay(books: BookSummary[], value: HomeDisplay, fallback?: BookSummary) {
  const available = books.filter(book => book.availabilityStatus === "available");
  const front = (value.mode === "custom" && available.find(book => book.id === value.front)) || fallback || available[0];
  const back = (value.mode === "custom" && available.find(book => book.id === value.back && book.id !== front?.id)) || available.find(book => book.id !== front?.id);
  return { front, back };
}
