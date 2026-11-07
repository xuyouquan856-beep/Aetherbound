import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_EPUB_COVER_BYTES } from "../../src/formats/epub/cover.js";
import { COVER_RESOURCE_FILE_NAMES, MAX_RENDERABLE_EPUB_BYTES } from "../../src/shared/contracts.js";
import { createPublicationResponse, isPublicationResourceAllowed, parsePublicationRequest } from "../../src/main/protocols/publication-protocol.js";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("controlled publication protocol", () => {
  it("routes the custom resource protocol through the controlled resolver", async () => {
    const source = await readFile("src/main/index.ts", "utf8");
    expect(source).toContain("createPublicationResponse");
    // The resolver only ever hands back paths derived from opaque book identities.
    expect(source).toContain("getPreparedPublicationPath");
    expect(source).not.toContain("registerFileProtocol");
    expect(source).not.toContain("registerBufferProtocol");
  });

  it("accepts only opaque identities and known endpoints", () => {
    expect(parsePublicationRequest("reader-resource://publication/book-1/rev-1/book.epub"))
      .toEqual({ bookId: "book-1", sourceRevision: "rev-1", resource: "book" });
    expect(parsePublicationRequest("reader-resource://publication/book-1/rev-1/cover"))
      .toEqual({ bookId: "book-1", sourceRevision: "rev-1", resource: "cover" });
    expect(parsePublicationRequest(`reader-resource://publication/book-1/rev-1/${COVER_RESOURCE_FILE_NAMES[1]}`))
      .toEqual({ bookId: "book-1", sourceRevision: "rev-1", resource: "cover-thumb" });
    for (const url of [
      "reader-resource://other/book-1/rev-1/book.epub",
      "reader-resource://publication/book-1/rev-1/other.xhtml",
      "reader-resource://publication/book-1/rev-1/../secret",
      "reader-resource://publication/book-1/rev-1/%2e%2e%2fsecret",
      "reader-resource://publication/E:/private/book.epub/book.epub",
      // Unknown file names must not be resolved even if they exist on disk.
      "reader-resource://publication/book-1/rev-1/publication.json",
      `reader-resource://publication/book-1/rev-1/${COVER_RESOURCE_FILE_NAMES[1]}.png`,
    ]) expect(() => parsePublicationRequest(url)).toThrow();
  });

  it("serves a resolved safe cache with restrictive headers and no path disclosure", async () => {
    const root = await mkdtemp(join(tmpdir(), "reader-protocol-"));
    cleanup.push(root);
    const file = join(root, "book.epub");
    await writeFile(file, "safe bytes");
    const response = await createPublicationResponse(
      new Request("reader-resource://publication/book-1/rev-1/book.epub"),
      (bookId, revision) => bookId === "book-1" && revision === "rev-1" ? file : null,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/epub+zip");
    expect(response.headers.get("access-control-allow-origin")).toBe("reader-rendition://epub");
    expect(response.headers.get("content-security-policy")).toContain("script-src 'none'");
    // The EPUB body must never be stored: a re-prepared revision replaces it.
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("safe bytes");

    const missing = await createPublicationResponse(
      new Request("reader-resource://publication/book-1/stale/book.epub"), () => null,
    );
    expect(missing.status).toBe(404);
    expect(await missing.text()).not.toContain(root);
  });

  it("allows covers to be cached, because a revision's cover never changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "reader-cover-cache-"));
    cleanup.push(root);
    const file = join(root, "cover");
    await writeFile(file, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const response = await createPublicationResponse(
      new Request("reader-resource://publication/book-1/rev-1/cover"),
      () => file,
    );
    expect(response.status).toBe(200);
    // Regression guard: "no-store" here forced Chromium to re-read and re-decode
    // every cover on each visit, which made the collections view slow.
    expect(response.headers.get("cache-control")).toContain("immutable");
  });

  it("rejects an oversized EPUB body instead of buffering it into main", async () => {
    const root = await mkdtemp(join(tmpdir(), "reader-large-book-"));
    cleanup.push(root);
    const file = join(root, "book.epub");
    const handle = await open(file, "w");
    await handle.truncate(MAX_RENDERABLE_EPUB_BYTES + 1);
    await handle.close();

    expect(await isPublicationResourceAllowed(file, "book")).toBe(false);
    const response = await createPublicationResponse(
      new Request("reader-resource://publication/book-1/rev-1/book.epub"),
      () => file,
    );
    expect(response.status).toBe(404);
  });

  it("rejects an empty EPUB body", async () => {
    const root = await mkdtemp(join(tmpdir(), "reader-empty-book-"));
    cleanup.push(root);
    const file = join(root, "book.epub");
    await writeFile(file, "");
    expect(await isPublicationResourceAllowed(file, "book")).toBe(false);
  });

  it("serves a signature-verified raster cover with a safe MIME type", async () => {
    const root = await mkdtemp(join(tmpdir(), "reader-cover-protocol-"));
    cleanup.push(root);
    const file = join(root, "cover");
    await writeFile(file, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const response = await createPublicationResponse(
      new Request("reader-resource://publication/book-1/rev-1/cover"),
      (bookId, revision, resource) => bookId === "book-1" && revision === "rev-1" && resource === "cover" ? file : null,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });

  it("serves a downscaled cover thumbnail through its own endpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "reader-cover-thumb-"));
    cleanup.push(root);
    const file = join(root, COVER_RESOURCE_FILE_NAMES[1]);
    await writeFile(file, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const response = await createPublicationResponse(
      new Request(`reader-resource://publication/book-1/rev-1/${COVER_RESOURCE_FILE_NAMES[1]}`),
      (bookId, revision, resource) =>
        bookId === "book-1" && revision === "rev-1" && resource === "cover-thumb" ? file : null,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toContain("immutable");
  });

  it("still rejects a signature-spoofed thumbnail", async () => {
    const root = await mkdtemp(join(tmpdir(), "reader-fake-thumb-"));
    cleanup.push(root);
    const file = join(root, COVER_RESOURCE_FILE_NAMES[1]);
    await writeFile(file, new TextEncoder().encode("not a raster image"));
    const response = await createPublicationResponse(
      new Request(`reader-resource://publication/book-1/rev-1/${COVER_RESOURCE_FILE_NAMES[1]}`),
      () => file,
    );
    expect(response.status).toBe(404);
  });
  it("rejects a signature-spoofed cover", async () => {
    const root = await mkdtemp(join(tmpdir(), "reader-fake-cover-"));
    cleanup.push(root);
    const file = join(root, "cover");
    await writeFile(file, new TextEncoder().encode("not a raster image"));
    const response = await createPublicationResponse(
      new Request("reader-resource://publication/book-1/rev-1/cover"),
      () => file,
    );
    expect(response.status).toBe(404);
  });

  it("rejects an oversized cover before serving it", async () => {
    const root = await mkdtemp(join(tmpdir(), "reader-large-cover-"));
    cleanup.push(root);
    const file = join(root, "cover");
    const handle = await open(file, "w");
    await handle.truncate(MAX_EPUB_COVER_BYTES + 1);
    await handle.close();

    expect(await isPublicationResourceAllowed(file, "cover")).toBe(false);
    const response = await createPublicationResponse(
      new Request("reader-resource://publication/book-1/rev-1/cover"),
      () => file,
    );
    expect(response.status).toBe(404);
  });

});
