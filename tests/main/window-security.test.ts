import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("main window navigation boundary", () => {
  it("never uses a development URL in packaged builds and blocks navigation escapes", async () => {
    const source = await readFile(new URL("../../src/main/index.ts", import.meta.url), "utf8");
    expect(source).toContain("!app.isPackaged");
    expect(source).toContain("will-navigate");
    expect(source).toContain("setWindowOpenHandler");
    expect(source).toContain("reader-app://bundle/index.html");
    expect(source).toContain("reader-rendition");
    expect(source).toContain("onBeforeRequest");
    expect(source).toContain("cancel: !isAllowedNetworkRequest(details.url, devUrl)");
    expect(source).not.toContain("callback({ cancel: false })");
    expect(source).toContain('nodeIntegrationInSubFrames: false');
  });

  it("builds the cross-origin runner before starting the development server", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
    expect(packageJson.scripts.predev).toBe("electron-vite build");
  });
});
