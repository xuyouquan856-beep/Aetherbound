// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShortcutEditor } from "../../src/renderer/src/features/reader/ShortcutEditor.js";
import { DefaultReaderShortcutProfile } from "../../src/shared/contracts.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ShortcutEditor", () => {
  it("captures a modified physical key for a command", () => {
    const onChange = vi.fn();
    render(<ShortcutEditor profile={DefaultReaderShortcutProfile} onChange={onChange} />);

    const capture = screen.getByRole("button", { name: "修改下一页的第一个按键" });
    fireEvent.click(capture);
    fireEvent.keyDown(capture, { code: "KeyK", ctrlKey: true });

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      bindings: expect.objectContaining({
        "reader.page.next": expect.arrayContaining([
          expect.objectContaining({ code: "KeyK", ctrl: true }),
        ]),
      }),
    }));
  });

  it("explains conflicts and moves the binding only after confirmation", () => {
    const onChange = vi.fn();
    render(<ShortcutEditor profile={DefaultReaderShortcutProfile} onChange={onChange} />);

    const capture = screen.getByRole("button", { name: "修改下一页的第一个按键" });
    fireEvent.click(capture);
    fireEvent.keyDown(capture, { code: "KeyA" });

    expect(screen.getByText("A 已用于上一页")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "将 A 改用于下一页" }));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      bindings: expect.objectContaining({
        "reader.page.previous": [
          expect.objectContaining({ code: "ArrowLeft" }),
        ],
        "reader.page.next": [
          expect.objectContaining({ code: "KeyA" }),
          expect.objectContaining({ code: "ArrowRight" }),
        ],
      }),
    }));
  });

  it("rejects reserved keys and restores all defaults", () => {
    const onChange = vi.fn();
    render(<ShortcutEditor profile={DefaultReaderShortcutProfile} onChange={onChange} />);

    const capture = screen.getByRole("button", { name: "修改下一页的第一个按键" });
    fireEvent.click(capture);
    fireEvent.keyDown(capture, { code: "F11" });
    expect(screen.getByText("F11 保留给全屏，不能修改。")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "恢复默认快捷键" }));
    expect(onChange).toHaveBeenCalledWith(DefaultReaderShortcutProfile);
  });

  it("does not remove the only binding of another core command", () => {
    render(<ShortcutEditor profile={DefaultReaderShortcutProfile} onChange={vi.fn()} />);

    const capture = screen.getByRole("button", { name: "修改下一页的第一个按键" });
    fireEvent.click(capture);
    fireEvent.keyDown(capture, { code: "KeyV" });
    expect(screen.getByText("V 是阅读外观的唯一按键，请先为它设置备用键。")).toBeInTheDocument();
  });
});
