import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { prepareEpub } from "../../src/formats/epub/prepare.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) =>
    rm(path, { recursive: true, force: true }),
  ));
});

describe("prepareEpub source digest", () => {
  it("returns the SHA-256 of the source bytes read for secure preparation", async () => {
    const root = await mkdtemp(join(tmpdir(), "reader-epub-prepare-hash-"));
    cleanup.push(root);
    const sourcePath = join(root, "source.epub");
    const destinationPath = join(root, "prepared.epub");
    const zip = new JSZip();
    zip.file("mimetype", "application/epub+zip");
    zip.file("chapter.xhtml", "<html><body>safe</body></html>");
    const source = await zip.generateAsync({ type: "uint8array" });
    await writeFile(sourcePath, source);

    const result = await prepareEpub(sourcePath, destinationPath);

    expect(result.fullContentHash).toBe(
      createHash("sha256").update(source).digest("hex"),
    );
    await expect(readFile(destinationPath)).resolves.not.toHaveLength(0);
  });
});
