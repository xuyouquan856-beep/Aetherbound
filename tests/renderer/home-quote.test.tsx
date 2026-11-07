// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { HomeQuote } from "../../src/renderer/src/features/quotes/HomeQuote.js";
import type { ReadingRecord, ReadingRecordsApi } from "../../src/shared/reading-records.js";
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it("randomly changes to a different quote without inventing an author", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  const records = ["First", "Second", "Third"].map((text, index) => ({ id: `${index}`, text, author: null, enabled: true, excerpt: "", bookTitle: "" })) as ReadingRecord[];
  render(<HomeQuote api={{ list: async () => records } as unknown as ReadingRecordsApi} revision={0} onManage={vi.fn()} />);
  await screen.findByText("First");
  expect(screen.getByText("未署名")).toBeInTheDocument();
  vi.mocked(Math.random).mockReturnValue(.99);
  fireEvent.click(screen.getByRole("button", { name: "更换首页摘录" }));
  expect(screen.getByText("Third")).toBeInTheDocument();
});
