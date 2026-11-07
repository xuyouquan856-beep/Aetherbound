import { readFile } from "node:fs/promises";
import Database from "better-sqlite3";
import { EpubBookFormatAdapter } from "../../formats/epub/adapter.js";
import { openTxt } from "../../formats/txt/adapter.js";
import { ReaderError } from "../../shared/errors.js";
import type { TextUnit } from "../indexing/text-indexer.js";

const SEGMENT_SIZE = 8192;

/** Split text into consecutive segments ≤ SEGMENT_SIZE, charCount === content.length */
function* splitText(startIdx: number, text: string): Generator<TextUnit> {
  let idx = startIdx;
  let offset = 0;
  while (offset < text.length) {
    const chunk = text.slice(offset, offset + SEGMENT_SIZE);
    yield { unitIndex: idx++, content: chunk, charCount: chunk.length };
    offset += SEGMENT_SIZE;
  }
}

export function createBookTextExtractor(
  db: Database.Database,
  resolvePreparedPath: (bookId: string, sourceRevision: string) => string | null = () => null,
): (bookId: string) => AsyncIterable<TextUnit> {
  return async function* (bookId: string): AsyncIterable<TextUnit> {
    const sources = db.prepare(
      "SELECT bs.source_path, b.format, bs.source_revision FROM book_sources bs JOIN books b ON b.id = bs.book_id WHERE bs.book_id = ? AND bs.availability_status = 'available' ORDER BY bs.source_path"
    ).all(bookId) as { source_path: string; format: string; source_revision: string }[];

    if (sources.length === 0) {
      throw new ReaderError("FILE_NOT_READABLE", "No available source for indexing");
    }

    const source = sources[0];
    const { source_path: path, format, source_revision: sourceRevision } = source;

    if (format === "txt") {
      const document = await openTxt(path, sourceRevision);
      let idx = 0;
      for (const para of document.text.split(/\n{2,}/)) {
        const trimmed = para.trim();
        if (!trimmed) continue;
        yield* splitText(idx, trimmed);
        // Advance by actual chunks produced
        idx += Math.ceil(trimmed.length / SEGMENT_SIZE);
      }
      return;
    }

    if (format === "epub") {
      const preparedPath = resolvePreparedPath(bookId, sourceRevision);
      if (!preparedPath) {
        throw new ReaderError(
          "SOURCE_UNAVAILABLE",
          "Prepared publication unavailable for indexing",
        );
      }
      const adapter = new EpubBookFormatAdapter(
        async () => new Uint8Array(await readFile(preparedPath)),
      );
      try {
        const opened = await adapter.openSource({ bookId, sourceRevision });
        if (!opened.ok) {
          throw new ReaderError("INVALID_PACKAGE", "EPUB could not be opened for indexing");
        }

        let idx = 0;
        for await (const unit of adapter.extractTextUnits()) {
          const text = unit.text.trim();
          if (!text) continue;
          yield* splitText(idx, text);
          idx += Math.ceil(text.length / SEGMENT_SIZE);
        }
      } finally {
        await adapter.close();
      }
    }
  };
}
