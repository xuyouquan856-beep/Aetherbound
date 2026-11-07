import { useSyncExternalStore, type CSSProperties } from "react";
export type CrystalAppearance = { color: string; strength: number; tint: number };
type Preferences = { theme: CrystalAppearance; collections: Record<string, CrystalAppearance> };
export const defaultCrystal: CrystalAppearance = { color: "#95ddff", strength: .65, tint: .12 };
const key = "aetherbound.crystal.v1";
let raw: string | null | undefined;
let snapshot: Preferences = { theme: defaultCrystal, collections: {} };
const listeners = new Set<() => void>();
export function validCrystal(value: unknown): value is CrystalAppearance {
  const v = value as CrystalAppearance | null;
  return !!v && /^#[0-9a-f]{6}$/i.test(v.color) && Number.isFinite(v.strength) && v.strength >= 0 && v.strength <= 1 && Number.isFinite(v.tint) && v.tint >= 0 && v.tint <= .4;
}
function read() {
  let next: string | null;
  try { next = localStorage.getItem(key); } catch { return snapshot; }
  if (next === raw) return snapshot;
  raw = next;
  snapshot = { theme: defaultCrystal, collections: {} };
  try {
    const parsed = JSON.parse(next ?? "null");
    if (validCrystal(parsed?.theme)) snapshot.theme = parsed.theme;
    if (parsed?.collections && typeof parsed.collections === "object") {
      snapshot.collections = Object.fromEntries(Object.entries(parsed.collections).filter((entry): entry is [string, CrystalAppearance] => validCrystal(entry[1])));
    }
  } catch { /* A damaged preference should never block the library. */ }
  return snapshot;
}
function subscribe(notify: () => void) { listeners.add(notify); window.addEventListener("storage", notify); return () => { listeners.delete(notify); window.removeEventListener("storage", notify); }; }
export function useCrystalAppearance(id?: string) {
  const value = useSyncExternalStore(subscribe, read, read);
  const custom = !!id && Object.hasOwn(value.collections, id);
  return { appearance: custom ? value.collections[id!] : value.theme, custom };
}
export function saveCrystalAppearance(value: CrystalAppearance | null, id?: string) {
  if (value && !validCrystal(value)) throw new Error("Invalid crystal appearance");
  const current = read();
  const next = { theme: current.theme, collections: { ...current.collections } };
  if (id) { if (value) next.collections[id] = value; else delete next.collections[id]; }
  else next.theme = value ?? defaultCrystal;
  localStorage.setItem(key, JSON.stringify(next));
  listeners.forEach(notify => notify());
}
export function crystalStyle(value: CrystalAppearance): CSSProperties {
  return { "--crystal-color": value.color, "--crystal-strength": value.strength, "--crystal-tint": value.tint } as CSSProperties;
}
