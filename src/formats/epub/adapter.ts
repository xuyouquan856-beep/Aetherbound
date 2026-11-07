import type { PublicationView, TocNode } from "../../shared/contracts.js";
import { adapterFailure, type AdapterResult } from "./errors.js";
import { parseEpub, type EpubCover, type EpubTextUnit, type ParsedEpub } from "./parser.js";

export type SourceHandle = { bookId: string; sourceRevision: string };
export type TextUnit = EpubTextUnit;
export type PublicationResource = { href: string; mediaType: string };
export type { EpubCover };

export class EpubBookFormatAdapter {
  private parsed: ParsedEpub | null = null;
  private publication: PublicationView | null = null;

  constructor(private readonly load: (source: SourceHandle, signal?: AbortSignal) => Promise<Uint8Array | null>) {}

  async openSource(source: SourceHandle, signal?: AbortSignal): Promise<AdapterResult<PublicationView>> {
    try {
      if (signal?.aborted) return { ok: false, code: "CANCELLED" };
      const bytes = await this.load(source, signal);
      if (!bytes) return { ok: false, code: "SOURCE_CHANGED" };
      const parsed = await parseEpub(bytes);
      this.parsed = parsed;
      this.publication = { bookId: source.bookId, sourceRevision: source.sourceRevision, metadata: parsed.metadata, toc: parsed.toc, spine: parsed.spine };
      return { ok: true, value: this.publication };
    } catch (error) { return adapterFailure(error); }
  }

  async readMetadata(): Promise<AdapterResult<PublicationView["metadata"]>> {
    return this.parsed ? { ok: true, value: this.parsed.metadata } : { ok: false, code: "INVALID_PACKAGE" };
  }

  async readToc(): Promise<AdapterResult<TocNode[]>> {
    return this.parsed ? { ok: true, value: this.parsed.toc } : { ok: false, code: "INVALID_PACKAGE" };
  }

  async listResources(): Promise<AdapterResult<PublicationResource[]>> {
    return this.parsed ? { ok: true, value: this.parsed.resources } : { ok: false, code: "INVALID_PACKAGE" };
  }

  async readCover(): Promise<AdapterResult<EpubCover | null>> {
    try {
      return this.parsed
        ? { ok: true, value: await this.parsed.readCover() }
        : { ok: false, code: "INVALID_PACKAGE" };
    } catch (error) { return adapterFailure(error); }
  }

  async *extractTextUnits(signal?: AbortSignal): AsyncIterable<TextUnit> {
    if (!this.parsed) return;
    yield* this.parsed.extractTextUnits(signal);
  }

  async close() {
    this.parsed = null;
    this.publication = null;
  }
}