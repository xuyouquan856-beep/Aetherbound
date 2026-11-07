import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// import { DuplicateResolver } from "../../src/backend/library-scan/duplicate-resolver.js";

function makeCandidate(overrides: Partial<{
  inventoryId: string; format: "txt" | "epub"; relativePath: string;
  absolutePath: string; fileSize: number; modifiedAt: string;
  quickFingerprintVersion: number; quickFingerprint: string;
  imported: boolean; importedAvailable: boolean;
}> & { inventoryId: string; absolutePath: string }) {
  return {
    format: "txt" as const,
    relativePath: "file.txt",
    fileSize: 100,
    modifiedAt: "2026-01-01T00:00:00.000Z",
    quickFingerprintVersion: 1,
    quickFingerprint: "abc123",
    imported: false,
    importedAvailable: false,
    ...overrides,
  };
}

describe("DuplicateResolver", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "reader-dup-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("skips full hash when quick fingerprints differ", async () => {
    const { quickFingerprint, fullContentHash } = await import(
      "../../src/backend/library/fingerprint.js"
    );
    const { DuplicateResolver } = await import(
      "../../src/backend/library-scan/duplicate-resolver.js"
    );

    const pathA = join(tempDir, "a.txt");
    const pathB = join(tempDir, "b.txt");
    await writeFile(pathA, "Content for file A that is different");
    await writeFile(pathB, "Completely different content for file B here");

    const fpA = await quickFingerprint(pathA);
    const fpB = await quickFingerprint(pathB);
    expect(fpA.fingerprint).not.toBe(fpB.fingerprint);

    const resolver = new DuplicateResolver();
    const groups = await resolver.findExactDuplicates({
      candidates: [
        makeCandidate({ inventoryId: "inv-a", absolutePath: pathA, fileSize: fpA.fileSize, modifiedAt: fpA.modifiedAt, quickFingerprintVersion: fpA.version, quickFingerprint: fpA.fingerprint }),
        makeCandidate({ inventoryId: "inv-b", absolutePath: pathB, fileSize: fpB.fileSize, modifiedAt: fpB.modifiedAt, quickFingerprintVersion: fpB.version, quickFingerprint: fpB.fingerprint }),
      ],
      computeFullHash: fullContentHash,
    });

    expect(groups).toHaveLength(0);
  });

  it("identifies exact duplicates with matching quick fingerprints and full hash", async () => {
    const { quickFingerprint, fullContentHash } = await import(
      "../../src/backend/library/fingerprint.js"
    );
    const { DuplicateResolver } = await import(
      "../../src/backend/library-scan/duplicate-resolver.js"
    );

    const content = "Same content in both files";
    const pathA = join(tempDir, "dup-a.txt");
    const pathB = join(tempDir, "dup-b.txt");
    await writeFile(pathA, content);
    await writeFile(pathB, content);

    const fpA = await quickFingerprint(pathA);
    expect(fpA.fingerprint).toBe((await quickFingerprint(pathB)).fingerprint);

    const resolver = new DuplicateResolver();
    const groups = await resolver.findExactDuplicates({
      candidates: [
        makeCandidate({ inventoryId: "inv-a", absolutePath: pathA, relativePath: "a.txt", fileSize: fpA.fileSize, modifiedAt: fpA.modifiedAt, quickFingerprintVersion: fpA.version, quickFingerprint: fpA.fingerprint }),
        makeCandidate({ inventoryId: "inv-b", absolutePath: pathB, relativePath: "b.txt", fileSize: fpA.fileSize, modifiedAt: fpA.modifiedAt, quickFingerprintVersion: fpA.version, quickFingerprint: fpA.fingerprint }),
      ],
      computeFullHash: fullContentHash,
    });

    expect(groups).toHaveLength(1);
    expect(groups[0].candidateIds).toContain("inv-a");
    expect(groups[0].candidateIds).toContain("inv-b");
  });

  it("does not group files with different formats", async () => {
    const { fullContentHash } = await import("../../src/backend/library/fingerprint.js");
    const { DuplicateResolver } = await import(
      "../../src/backend/library-scan/duplicate-resolver.js"
    );

    const pathTxt = join(tempDir, "file.txt");
    const pathEpub = join(tempDir, "file.epub");
    await writeFile(pathTxt, "content");
    await writeFile(pathEpub, "content");

    const resolver = new DuplicateResolver();
    const groups = await resolver.findExactDuplicates({
      candidates: [
        makeCandidate({ inventoryId: "inv-txt", absolutePath: pathTxt, format: "txt", quickFingerprint: "abc" }),
        makeCandidate({ inventoryId: "inv-epub", absolutePath: pathEpub, format: "epub", quickFingerprint: "abc" }),
      ],
      computeFullHash: fullContentHash,
    });

    expect(groups).toHaveLength(0);
  });

  it("does not group files with different sizes", async () => {
    const { fullContentHash } = await import("../../src/backend/library/fingerprint.js");
    const { DuplicateResolver } = await import(
      "../../src/backend/library-scan/duplicate-resolver.js"
    );

    const path1 = join(tempDir, "small.txt");
    const path2 = join(tempDir, "large.txt");
    await writeFile(path1, "A");
    await writeFile(path2, "AA");

    const resolver = new DuplicateResolver();
    const groups = await resolver.findExactDuplicates({
      candidates: [
        makeCandidate({ inventoryId: "inv-1", absolutePath: path1, fileSize: 1, quickFingerprint: "abc" }),
        makeCandidate({ inventoryId: "inv-2", absolutePath: path2, fileSize: 2, quickFingerprint: "abc" }),
      ],
      computeFullHash: fullContentHash,
    });

    expect(groups).toHaveLength(0);
  });

  it("selects survivor by stable ordering: imported+available first", async () => {
    const { quickFingerprint, fullContentHash } = await import(
      "../../src/backend/library/fingerprint.js"
    );
    const { DuplicateResolver } = await import(
      "../../src/backend/library-scan/duplicate-resolver.js"
    );

    const content = "Same content";
    const pathA = join(tempDir, "a.txt");
    const pathB = join(tempDir, "b.txt");
    await writeFile(pathA, content);
    await writeFile(pathB, content);

    const fp = await quickFingerprint(pathA);
    const mt = "2026-07-24T00:00:00.000Z";

    const resolver = new DuplicateResolver();
    const groups = await resolver.findExactDuplicates({
      candidates: [
        makeCandidate({ inventoryId: "inv-a", absolutePath: pathA, relativePath: "a.txt", fileSize: fp.fileSize, modifiedAt: mt, quickFingerprintVersion: fp.version, quickFingerprint: fp.fingerprint }),
        makeCandidate({ inventoryId: "inv-b", absolutePath: pathB, relativePath: "b.txt", fileSize: fp.fileSize, modifiedAt: mt, quickFingerprintVersion: fp.version, quickFingerprint: fp.fingerprint, imported: true, importedAvailable: true }),
      ],
      computeFullHash: fullContentHash,
    });

    expect(groups).toHaveLength(1);
    expect(groups[0].survivorId).toBe("inv-b");
  });

  it("skips full hash for single candidate", async () => {
    const { fullContentHash } = await import("../../src/backend/library/fingerprint.js");
    const { DuplicateResolver } = await import(
      "../../src/backend/library-scan/duplicate-resolver.js"
    );

    const path = join(tempDir, "solo.txt");
    await writeFile(path, "solo");

    const resolver = new DuplicateResolver();
    const groups = await resolver.findExactDuplicates({
      candidates: [
        makeCandidate({ inventoryId: "inv-solo", absolutePath: path }),
      ],
      computeFullHash: fullContentHash,
    });

    expect(groups).toHaveLength(0);
  });

  it("produces no group when full hashes differ despite matching quick fingerprint", async () => {
    const { quickFingerprint, fullContentHash } = await import(
      "../../src/backend/library/fingerprint.js"
    );
    const { DuplicateResolver } = await import(
      "../../src/backend/library-scan/duplicate-resolver.js"
    );

    const pathA = join(tempDir, "a.txt");
    const pathB = join(tempDir, "b.txt");
    await writeFile(pathA, "AAAA".repeat(100));
    await writeFile(pathB, "BBBB".repeat(100));

    const fpA = await quickFingerprint(pathA);
    const fpB = await quickFingerprint(pathB);

    const resolver = new DuplicateResolver();
    const groups = await resolver.findExactDuplicates({
      candidates: [
        makeCandidate({ inventoryId: "inv-a", absolutePath: pathA, fileSize: fpA.fileSize, modifiedAt: fpA.modifiedAt, quickFingerprintVersion: fpA.version, quickFingerprint: fpA.fingerprint }),
        makeCandidate({ inventoryId: "inv-b", absolutePath: pathB, fileSize: fpB.fileSize, modifiedAt: fpB.modifiedAt, quickFingerprintVersion: fpB.version, quickFingerprint: fpB.fingerprint }),
      ],
      computeFullHash: fullContentHash,
    });

    expect(groups.filter((g) => g.candidateIds.length >= 2)).toHaveLength(0);
  });
});
