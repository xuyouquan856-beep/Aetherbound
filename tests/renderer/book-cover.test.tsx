// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BookTile } from "../../src/renderer/src/features/library/BookTile.js";
import type { BookSummary } from "../../src/shared/contracts.js";

function book(overrides: Partial<BookSummary> = {}): BookSummary {
  return {
    id: "book-aether",
    title: "通往星海尽头的旅人",
    author: "林舟",
    format: "epub",
    coverUrl: "reader-app://bundle/cover/book-aether",
    availabilityStatus: "available",
    progress: 0.25,
    addedAt: "2026-07-29T00:00:00.000Z",
    lastReadAt: "2026-07-29T01:00:00.000Z",
    updatedAt: "2026-07-29T01:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("BookTile covers", () => {
  it("reveals a complete memory-cached cover without waiting for a new load event", async () => {
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(320);
    Object.defineProperty(HTMLImageElement.prototype, "decode", {
      configurable: true,
      value: vi.fn(async () => undefined),
    });

    render(<BookTile
      book={book({ coverUrl: "reader-resource://publication/memory-hit/rev/cover" })}
      onOpen={vi.fn()}
    />);

    await waitFor(() => expect(screen.getByRole("img")).toHaveAttribute(
      "data-loaded",
      "true",
    ));
  });

  it("keeps a decoded cover ready when the same URL remounts on another page", async () => {
    Object.defineProperty(HTMLImageElement.prototype, "decode", {
      configurable: true,
      value: vi.fn(async () => undefined),
    });
    const url = "reader-resource://publication/remount-hit/rev/cover";
    const first = render(<BookTile book={book({ coverUrl: url })} onOpen={vi.fn()} />);
    fireEvent.load(screen.getByRole("img"));
    await waitFor(() => expect(screen.getByRole("img")).toHaveAttribute("data-loaded", "true"));
    first.unmount();

    render(<BookTile book={book({ coverUrl: url })} onOpen={vi.fn()} />);

    expect(screen.getByRole("img")).toHaveAttribute("data-loaded", "true");
  });

  it("reveals a controlled publication cover only after load and decode", async () => {
    let finishDecode!: () => void;
    const decode = vi.fn(() => new Promise<void>((resolve) => {
      finishDecode = resolve;
    }));
    Object.defineProperty(HTMLImageElement.prototype, "decode", {
      configurable: true,
      value: decode,
    });

    render(<BookTile book={book()} onOpen={vi.fn()} />);

    const image = screen.getByRole("img", { name: "《通往星海尽头的旅人》封面" });
    expect(image).toHaveAttribute("loading", "lazy");
    expect(image).toHaveAttribute("decoding", "async");
    expect(image).toHaveAttribute("data-loaded", "false");

    fireEvent.load(image);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(image).toHaveAttribute("data-loaded", "false");

    await act(async () => finishDecode());
    expect(image).toHaveAttribute("data-loaded", "true");
  });

  it("keeps a deterministic generated cover as the error fallback", () => {
    const { rerender } = render(<BookTile book={book()} onOpen={vi.fn()} />);
    const firstFallback = screen.getByTestId("generated-book-cover");
    const firstTone = firstFallback.getAttribute("data-cover-tone");

    fireEvent.error(screen.getByRole("img"));
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByTestId("generated-book-cover")).toBeVisible();
    expect(screen.getByTestId("generated-book-cover")).toHaveAttribute("data-cover-tone", firstTone);

    rerender(<BookTile book={book({ coverUrl: "reader-app://bundle/cover/recovered" })} onOpen={vi.fn()} />);
    expect(screen.getByRole("img")).toHaveAttribute(
      "src",
      "reader-app://bundle/cover/recovered",
    );
    expect(screen.getByTestId("generated-book-cover")).toHaveAttribute("data-cover-tone", firstTone);
  });

  it("retains the full title for pointer and assistive access", () => {
    render(<BookTile book={book()} onOpen={vi.fn()} />);

    expect(screen.getByTestId("generated-book-cover")).toHaveAttribute(
      "title",
      "通往星海尽头的旅人",
    );
    expect(screen.getByRole("button", { name: "打开《通往星海尽头的旅人》" }))
      .toBeInTheDocument();
  });
});
