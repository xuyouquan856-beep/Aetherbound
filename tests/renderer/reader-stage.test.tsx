// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReaderStage } from "../../src/renderer/src/features/reader/ReaderStage.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ReaderStage", () => {
  it("keeps the library interactive while a full-size reader prepares", () => {
    render(<ReaderStage
      phase="preparing"
      library={<main>Library underlay</main>}
      reader={<main>Restored reader</main>}
      onPresented={vi.fn()}
    />);

    const library = screen.getByTestId("reader-transition-library");
    const reader = screen.getByTestId("reader-transition-reader");
    expect(library).toHaveAttribute("aria-hidden", "false");
    expect(library).not.toHaveAttribute("inert");
    expect(reader).toHaveAttribute("aria-hidden", "true");
    expect(reader).toHaveAttribute("inert");
  });

  it("hands interaction to the reader only after its opacity transition finishes", () => {
    const onPresented = vi.fn();
    render(<ReaderStage
      phase="presenting"
      library={<main>Library underlay</main>}
      reader={<main>Restored reader</main>}
      onPresented={onPresented}
    />);
    const reader = screen.getByTestId("reader-transition-reader");

    expect(reader).toHaveAttribute("aria-hidden", "false");
    expect(reader).not.toHaveAttribute("inert");
    fireEvent.transitionEnd(reader, { propertyName: "transform" });
    expect(onPresented).not.toHaveBeenCalled();
    fireEvent.transitionEnd(reader, { propertyName: "opacity" });
    fireEvent.transitionEnd(reader, { propertyName: "opacity" });
    expect(onPresented).toHaveBeenCalledOnce();
  });

  it("completes atomically when reduced motion is requested", async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        matches: true,
        media: "(prefers-reduced-motion: reduce)",
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    const onPresented = vi.fn();

    render(<ReaderStage
      phase="presenting"
      library={<main>Library underlay</main>}
      reader={<main>Restored reader</main>}
      onPresented={onPresented}
    />);

    await vi.waitFor(() => expect(onPresented).toHaveBeenCalledOnce());
  });
});
