import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { NavigationHistory } from "../../src/renderer/src/epub-runner/navigation-history.js";

describe("EPUB internal-link navigation history", () => {
  it("supports back, forward and branch replacement", () => {
    const history = new NavigationHistory<string>();
    history.visit("chapter-1#source", "chapter-2#target");
    expect(history.state).toEqual({ canGoBack: true, canGoForward: false });
    expect(history.back()).toBe("chapter-1#source");
    expect(history.state).toEqual({ canGoBack: false, canGoForward: true });
    expect(history.forward()).toBe("chapter-2#target");

    expect(history.back()).toBe("chapter-1#source");
    history.visit("chapter-1#source", "chapter-3#target");
    expect(history.forward()).toBeNull();
    expect(history.back()).toBe("chapter-1#source");
  });

  it("deduplicates positions and caps the session history at fifty entries", () => {
    const history = new NavigationHistory<string>(50);
    history.visit("same", "same");
    expect(history.state).toEqual({ canGoBack: false, canGoForward: false });

    for (let index = 0; index < 80; index += 1) {
      history.visit(`source-${index}`, `target-${index}`);
    }

    let backCount = 0;
    while (history.back() !== null) backCount += 1;
    expect(backCount).toBeLessThanOrEqual(49);
  });

  it("intercepts only publication links and blocks external-link fallback", async () => {
    const source = await readFile("src/renderer/src/epub-runner/main.ts", "utf8");

    expect(source).toMatch(/view\.addEventListener\("link"[\s\S]*preventDefault/);
    expect(source).toMatch(/view\.addEventListener\("external-link"[\s\S]*preventDefault/);
    expect(source).toMatch(/command\.command === "navigate"[\s\S]*view\?\.goTo\(engineHref\(command\.href\)\)/);
  });
});
