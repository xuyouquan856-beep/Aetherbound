import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBundleResponse } from "../../src/main/protocols/bundle-protocol.js";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("trusted bundle protocol", () => {
  it("allows controlled publication covers in both the response and renderer meta policies", async () => {
    const root = await mkdtemp(join(tmpdir(), "reader-bundle-"));
    cleanup.push(root);
    await writeFile(join(root, "index.html"), "<html></html>");
    const response = await createBundleResponse(new Request("reader-app://bundle/index.html"), root, "reader-app");
    const responseCsp = response.headers.get("content-security-policy") ?? "";
    const rendererHtml = await readFile(join(process.cwd(), "src/renderer/index.html"), "utf8");
    const metaCsp = rendererHtml.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1] ?? "";

    expect(responseCsp).toMatch(/img-src[^;]*reader-resource:/);
    expect(metaCsp).toMatch(/img-src[^;]*reader-resource:/);
    expect(responseCsp).toMatch(/img-src[^;]*blob:/);
    expect(metaCsp).toMatch(/img-src[^;]*blob:/);
    expect(metaCsp).not.toMatch(/img-src[^;]*(?:https?:|file:)/);
  });

  it("allows sanitized blob styles in the EPUB runner without allowing blob scripts", async () => {
    const root = await mkdtemp(join(tmpdir(), "reader-bundle-"));
    cleanup.push(root);
    await writeFile(join(root, "epub-runner.html"), "<html></html>");
    const response = await createBundleResponse(new Request("reader-rendition://epub/epub-runner.html"), root, "reader-rendition");
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/style-src[^;]*blob:/);
    expect(csp).not.toMatch(/script-src[^;]*blob:/);
  });
});
