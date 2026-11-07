import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";

export async function quickFingerprint(path: string) {
  const facts = await stat(path);
  const sampleSize = 64 * 1024;
  const handle = await open(path, "r");
  try {
    const first = Buffer.alloc(Math.min(sampleSize, facts.size));
    await handle.read(first, 0, first.length, 0);
    const tailLength = Math.min(sampleSize, Math.max(0, facts.size - first.length));
    const tail = Buffer.alloc(tailLength);
    if (tailLength) await handle.read(tail, 0, tailLength, facts.size - tailLength);
    const fingerprint = createHash("sha256").update("quick-v1\0").update(String(facts.size)).update("\0").update(first).update(tail).digest("hex");
    return { version: 1, fingerprint, fileSize: facts.size, modifiedAt: facts.mtime.toISOString(), isFile: facts.isFile() };
  } finally {
    await handle.close();
  }
}

export function fullContentHash(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}
