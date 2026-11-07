// @vitest-environment jsdom
import { act, cleanup, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DefaultReaderShortcutProfile,
  type ReaderCommandId,
} from "../../src/shared/contracts.js";
import {
  isReaderEditingTarget,
  keyBindingFromEvent,
  moveBinding,
  resolveReaderCommand,
} from "../../src/renderer/src/features/reader/reader-shortcuts.js";
import { useReaderShortcuts } from "../../src/renderer/src/features/reader/useReaderShortcuts.js";

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe("reader shortcut engine", () => {
  it("resolves physical key codes to reader commands", () => {
    expect(resolveReaderCommand(DefaultReaderShortcutProfile, {
      code: "KeyD",
      ctrl: false,
      alt: false,
      shift: false,
      meta: false,
    })).toBe("reader.page.next");
    expect(resolveReaderCommand(DefaultReaderShortcutProfile, {
      code: "ArrowLeft",
      ctrl: false,
      alt: false,
      shift: false,
      meta: false,
    })).toBe("reader.page.previous");
    expect(resolveReaderCommand(DefaultReaderShortcutProfile, {
      code: "PageDown",
      ctrl: false,
      alt: false,
      shift: false,
      meta: false,
    })).toBe("reader.page.next");
    expect(resolveReaderCommand(DefaultReaderShortcutProfile, {
      code: "PageUp",
      ctrl: false,
      alt: false,
      shift: false,
      meta: false,
    })).toBe("reader.page.previous");
    expect(resolveReaderCommand(DefaultReaderShortcutProfile, {
      code: "Space",
      ctrl: false,
      alt: false,
      shift: false,
      meta: false,
    })).toBe("reader.page.next");
    expect(resolveReaderCommand(DefaultReaderShortcutProfile, {
      code: "Space",
      ctrl: false,
      alt: false,
      shift: true,
      meta: false,
    })).toBe("reader.page.previous");
  });

  it("normalizes usable key events and rejects reserved or repeated events", () => {
    expect(keyBindingFromEvent(new KeyboardEvent("keydown", {
      code: "KeyD",
      ctrlKey: true,
    }))).toEqual({
      code: "KeyD",
      ctrl: true,
      alt: false,
      shift: false,
      meta: false,
    });
    expect(keyBindingFromEvent(new KeyboardEvent("keydown", { code: "Escape" }))).toBeNull();
    expect(keyBindingFromEvent(new KeyboardEvent("keydown", { code: "F11" }))).toBeNull();
    expect(keyBindingFromEvent(new KeyboardEvent("keydown", { code: "KeyD", repeat: true }))).toBeNull();
  });

  it("moves a conflicting binding to the new command atomically", () => {
    const moved = moveBinding(
      DefaultReaderShortcutProfile,
      "reader.brightness.increase",
      0,
      { code: "KeyD", ctrl: false, alt: false, shift: false, meta: false },
    );

    expect(moved.bindings["reader.brightness.increase"]).toEqual([
      { code: "KeyD", ctrl: false, alt: false, shift: false, meta: false },
    ]);
    expect(moved.bindings["reader.page.next"]).toEqual([
      { code: "ArrowRight", ctrl: false, alt: false, shift: false, meta: false },
    ]);
  });

  it("recognizes text editing and shortcut capture targets", () => {
    for (const element of [
      document.createElement("input"),
      document.createElement("textarea"),
      document.createElement("select"),
    ]) {
      expect(isReaderEditingTarget(element)).toBe(true);
    }

    const editable = document.createElement("div");
    editable.contentEditable = "true";
    expect(isReaderEditingTarget(editable)).toBe(true);

    const capture = document.createElement("button");
    capture.dataset.readerShortcutCapture = "true";
    expect(isReaderEditingTarget(capture)).toBe(true);
    expect(isReaderEditingTarget(document.createElement("div"))).toBe(false);
  });

  it("dispatches commands while the reader is active", () => {
    const commands: ReaderCommandId[] = [];
    renderHook(() => useReaderShortcuts({
      profile: DefaultReaderShortcutProfile,
      panelOpen: false,
      onCommand: (command) => commands.push(command),
    }));

    fireEvent.keyDown(window, { code: "KeyD" });
    expect(commands).toEqual(["reader.page.next"]);
  });

  it("ignores all commands while the retained reader is hidden", () => {
    const onCommand = vi.fn();
    const { result } = renderHook(() => useReaderShortcuts({
      profile: DefaultReaderShortcutProfile,
      panelOpen: false,
      enabled: false,
      onCommand,
    }));

    fireEvent.keyDown(window, { code: "KeyD" });
    expect(result.current({
      code: "KeyD",
      ctrl: false,
      alt: false,
      shift: false,
      meta: false,
    })).toBe(false);
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("ignores editing targets and repeated events", () => {
    const onCommand = vi.fn();
    renderHook(() => useReaderShortcuts({
      profile: DefaultReaderShortcutProfile,
      panelOpen: false,
      onCommand,
    }));

    const input = document.createElement("input");
    document.body.append(input);
    fireEvent.keyDown(input, { code: "KeyD" });
    fireEvent.keyDown(window, { code: "KeyD", repeat: true });
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("suspends page commands while a panel is open but allows panel toggles", () => {
    const commands: ReaderCommandId[] = [];
    renderHook(() => useReaderShortcuts({
      profile: DefaultReaderShortcutProfile,
      panelOpen: true,
      onCommand: (command) => commands.push(command),
    }));

    act(() => {
      fireEvent.keyDown(window, { code: "KeyD" });
      fireEvent.keyDown(window, { code: "KeyV" });
    });
    expect(commands).toEqual(["reader.panel.appearance.toggle"]);
  });
});
