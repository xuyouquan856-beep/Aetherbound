import { readFile, stat } from "node:fs/promises";
import {
  EpubBinaryRequestSchema,
  EpubBinaryResponseSchema,
  MAX_RENDERABLE_EPUB_BYTES,
  type EpubBinaryRequest,
  type EpubBinaryResponse,
} from "../../shared/contracts.js";
import { ReaderError } from "../../shared/errors.js";

export type PreparedEpubPathResolver = (
  bookId: string,
  sourceRevision: string,
) => string | null;

export class PreparedEpubBinaryService {
  constructor(
    private readonly resolve: PreparedEpubPathResolver,
    private readonly maxBytes = MAX_RENDERABLE_EPUB_BYTES,
  ) {}

  async read(input: EpubBinaryRequest): Promise<EpubBinaryResponse> {
    const request = EpubBinaryRequestSchema.parse(input);
    const path = this.resolve(request.bookId, request.sourceRevision);
    if (!path) {
      throw new ReaderError(
        "SOURCE_CHANGED",
        "The prepared EPUB revision is stale.",
      );
    }
    const facts = await stat(path).catch(() => null);
    if (!facts?.isFile()) {
      throw new ReaderError(
        "SOURCE_UNAVAILABLE",
        "The prepared EPUB is unavailable.",
      );
    }
    if (facts.size <= 0 || facts.size > this.maxBytes) {
      throw new ReaderError(
        "ARCHIVE_LIMIT",
        "The EPUB exceeds the safe rendering limit.",
      );
    }
    const bytes = new Uint8Array(await readFile(path));
    return EpubBinaryResponseSchema.parse({
      ...request,
      mediaType: "application/epub+zip",
      bytes,
    });
  }
}
