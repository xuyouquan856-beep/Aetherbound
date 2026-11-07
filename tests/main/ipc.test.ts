import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { publicError } from "../../src/shared/errors.js";
import { validatedHandler } from "../../src/main/ipc/validated-handler.js";

describe("desktop capability boundary", () => {
  it("rejects an invalid payload before calling a service", async () => {
    const service = vi.fn(async (value: { id: string }) => ({ id: value.id }));
    const handler = validatedHandler(z.object({ id: z.string() }).strict(), z.object({ id: z.string() }).strict(), service);
    await expect(handler({ id: "b1", path: "E:\\secret.txt" })).rejects.toThrow();
    expect(service).not.toHaveBeenCalled();
  });

  it("removes absolute paths from public errors", () => {
    expect(JSON.stringify(publicError(new Error("failed E:\\private\\book.txt")))).not.toMatch(/[A-Z]:\\/i);
  });

  it("exposes named preload methods without generic IPC", async () => {
    const source = await readFile("src/preload/index.ts", "utf8");
    expect(source).toContain("readerApi");
    expect(source).toContain("channels.readerEpubBinary");
    expect(source).not.toMatch(/invoke\s*:\s*|send\s*:\s*|ipcRenderer\s*[,}]/);
    expect(source).not.toMatch(/readFile\s*:|sourcePath|absolutePath/);
  });
});
