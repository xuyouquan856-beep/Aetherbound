// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { defaultCrystal, saveCrystalAppearance, useCrystalAppearance, validCrystal } from "../../src/renderer/src/features/library/crystal-preferences.js";
afterEach(() => { cleanup(); localStorage.clear(); });
it("keeps collection overrides independent, and restoring follows the latest global color", () => {
  const { result } = renderHook(() => ({ global: useCrystalAppearance(), own: useCrystalAppearance("series"), other: useCrystalAppearance("other") }));
  act(() => saveCrystalAppearance({ ...defaultCrystal, color: "#f7adc9" }));
  expect(result.current.other.appearance.color).toBe("#f7adc9");
  act(() => saveCrystalAppearance({ ...defaultCrystal, color: "#bba6ff", tint: .2 }, "series"));
  act(() => saveCrystalAppearance({ ...defaultCrystal, color: "#93ead5" }));
  expect(result.current.own.appearance.color).toBe("#bba6ff");
  expect(result.current.other.appearance.color).toBe("#93ead5");
  act(() => saveCrystalAppearance(null, "series"));
  expect(result.current.own.appearance.color).toBe("#93ead5");
  expect(result.current.own.custom).toBe(false);
});
it("rejects malformed colors and excessive tint", () => {
  expect(validCrystal({ ...defaultCrystal, color: "url(x)" })).toBe(false);
  expect(validCrystal({ ...defaultCrystal, tint: .9 })).toBe(false);
  localStorage.setItem("aetherbound.crystal.v1", "broken");
  const { result } = renderHook(() => useCrystalAppearance());
  expect(result.current.appearance).toEqual(defaultCrystal);
});
