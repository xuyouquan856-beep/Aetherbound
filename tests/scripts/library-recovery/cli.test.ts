import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runLibraryRecoveryCli } from "../../../scripts/library-recovery/cli.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("library recovery CLI", () => {
  it("has no implicit command and requires a root", async () => {
    await expect(runLibraryRecoveryCli([])).rejects.toThrow(/command/i);
    await expect(runLibraryRecoveryCli(["baseline"])).rejects.toThrow(/root/i);
  });

  it("rejects an audit directory inside the corpus", async () => {
    const root = await mkdtemp(join(tmpdir(), "recovery-cli-"));
    roots.push(root);
    await expect(runLibraryRecoveryCli([
      "baseline",
      "--root", root,
      "--audit-root", join(root, "audit"),
    ])).rejects.toThrow(/outside/i);
  });

  it("requires frozen apply inputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "recovery-cli-"));
    roots.push(root);
    await expect(runLibraryRecoveryCli(["apply", "--root", root]))
      .rejects.toThrow(/preview/i);
  });

  it("rejects unknown commands and flags", async () => {
    await expect(runLibraryRecoveryCli(["destroy", "--root", "E:\\epub"]))
      .rejects.toThrow(/unknown command/i);
    await expect(runLibraryRecoveryCli(["verify", "--root", "E:\\epub", "--unknown", "x"]))
      .rejects.toThrow(/unknown option/i);
  });
});
