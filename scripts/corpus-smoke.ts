import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, opendir, readFile, stat } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { EpubBookFormatAdapter } from "../src/formats/epub/adapter.js";
import { decodeTxt } from "../src/formats/txt/decode.js";
import { ReaderError } from "../src/shared/errors.js";

const SUPPORTED_EXTENSIONS = new Set([".txt", ".epub"]);
const HASH_CONCURRENCY = 4;

export type ReaderCorpusFact = {
  relativePath: string;
  extension: ".txt" | ".epub";
  fileSize: number;
  modifiedAt: string;
  sha256: string;
};

export type ReaderCorpusValidationError = {
  relativePath: string;
  code: string;
};

async function* walkSupportedFiles(root: string, directory = root): AsyncGenerator<string> {
  const handle = await opendir(directory);
  for await (const entry of handle) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      yield* walkSupportedFiles(root, path);
      continue;
    }
    if (entry.isFile() && SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      yield path;
    }
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolveStream, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolveStream);
  });
  return hash.digest("hex");
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await operation(values[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export async function captureReaderCorpus(corpusRoot: string): Promise<ReaderCorpusFact[]> {
  const absoluteRoot = resolve(corpusRoot);
  const paths: string[] = [];
  for await (const path of walkSupportedFiles(absoluteRoot)) paths.push(path);
  paths.sort((left, right) => left.localeCompare(right, "zh-CN"));

  return mapWithConcurrency(paths, HASH_CONCURRENCY, async (path) => {
    const facts = await stat(path);
    if (!facts.isFile()) throw new Error("Corpus entry stopped being a regular file.");
    const extension = extname(path).toLowerCase() as ".txt" | ".epub";
    return {
      relativePath: relative(absoluteRoot, path).replaceAll("\\", "/"),
      extension,
      fileSize: facts.size,
      modifiedAt: facts.mtime.toISOString(),
      sha256: await sha256File(path),
    };
  });
}

export function diffCorpusManifests(
  before: readonly ReaderCorpusFact[],
  after: readonly ReaderCorpusFact[],
): string[] {
  const beforeByPath = new Map(before.map((fact) => [fact.relativePath, fact]));
  const afterByPath = new Map(after.map((fact) => [fact.relativePath, fact]));
  const allPaths = new Set([...beforeByPath.keys(), ...afterByPath.keys()]);
  return [...allPaths]
    .filter((path) => {
      const left = beforeByPath.get(path);
      const right = afterByPath.get(path);
      return !left || !right
        || left.extension !== right.extension
        || left.fileSize !== right.fileSize
        || left.modifiedAt !== right.modifiedAt
        || left.sha256 !== right.sha256;
    })
    .sort((left, right) => left.localeCompare(right, "zh-CN"));
}

async function validateTxt(path: string, fileSize: number) {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(Math.min(fileSize, 64 * 1024));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    let lastError: unknown;
    for (let trim = 0; trim <= 3 && trim <= bytesRead; trim += 1) {
      try {
        decodeTxt(buffer.subarray(0, bytesRead - trim));
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  } finally {
    await handle.close();
  }
}

async function validateEpub(path: string, sourceRevision: string) {
  const adapter = new EpubBookFormatAdapter(async () => new Uint8Array(await readFile(path)));
  try {
    const result = await adapter.openSource({
      bookId: "reader-core-corpus-smoke",
      sourceRevision,
    });
    if (!result.ok) throw new ReaderError(result.code, result.detail ?? result.code);
  } finally {
    await adapter.close();
  }
}

function publicValidationCode(error: unknown): string {
  if (error instanceof ReaderError) return error.code;
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.message)) {
    return error.message;
  }
  return "VALIDATION_FAILED";
}

export async function runReaderCoreSmoke(corpusRoot: string) {
  const absoluteRoot = resolve(corpusRoot);
  const startedAt = performance.now();
  const before = await captureReaderCorpus(absoluteRoot);
  const validationErrors: ReaderCorpusValidationError[] = [];
  let validated = 0;

  for (const fact of before) {
    const path = join(absoluteRoot, ...fact.relativePath.split("/"));
    try {
      if (fact.extension === ".txt") await validateTxt(path, fact.fileSize);
      else await validateEpub(path, fact.sha256);
      validated += 1;
    } catch (error) {
      validationErrors.push({
        relativePath: fact.relativePath,
        code: publicValidationCode(error),
      });
    }
  }

  const after = await captureReaderCorpus(absoluteRoot);
  const mutated = diffCorpusManifests(before, after);
  return {
    before,
    after,
    supported: before.length,
    validated,
    validationErrors,
    mutated,
    elapsedMs: Math.round(performance.now() - startedAt),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf("--root");
  const corpusRoot = rootIndex >= 0 ? args[rootIndex + 1] : process.env.READER_TEST_CORPUS;
  if (!args.includes("--reader-core") || !args.includes("--dry-run")) {
    throw new Error("Reader Core corpus smoke requires --reader-core --dry-run.");
  }
  if (!corpusRoot) {
    throw new Error("Pass --root or set READER_TEST_CORPUS.");
  }

  const result = await runReaderCoreSmoke(corpusRoot);
  console.log(JSON.stringify({
    mode: "reader-core-read-only",
    supported: result.supported,
    validated: result.validated,
    validationErrors: result.validationErrors,
    mutated: result.mutated,
    elapsedMs: result.elapsedMs,
  }, null, 2));
  if (result.mutated.length > 0) process.exitCode = 1;
}
