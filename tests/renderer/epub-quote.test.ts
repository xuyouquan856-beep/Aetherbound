// @vitest-environment jsdom
import { expect, it } from "vitest";
import { findQuoteRange } from "../../src/renderer/src/epub-runner/quote-range.js";

it("finds a quote across text nodes using its context", () => {
  const doc = document.implementation.createHTMLDocument();
  doc.body.innerHTML = "<p>alpha <em>shared</em> phrase one</p><p>beta <strong>shared</strong> phrase two</p>";
  expect(findQuoteRange(doc, "shared phrase", "beta ", " two")?.toString()).toBe("shared phrase");
  expect(findQuoteRange(doc, "shared phrase", "beta ", " two")?.startContainer.parentElement?.tagName).toBe("STRONG");
});

it("does not choose an ambiguous quote without context", () => {
  const doc = document.implementation.createHTMLDocument();
  doc.body.innerHTML = "<p>same</p><p>same</p>";
  expect(findQuoteRange(doc, "same", "", "")).toBeNull();
});
