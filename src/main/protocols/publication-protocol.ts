import { readFile, stat } from "node:fs/promises";
import {
  COVER_RESOURCE_FILE_NAMES,
  MAX_RENDERABLE_EPUB_BYTES,
} from "../../shared/contracts.js";
import { MAX_EPUB_COVER_BYTES, detectRasterCoverMediaType } from "../../formats/epub/cover.js";

export type PublicationResource = "book" | "cover" | "cover-thumb";
export type PublicationResolver = (bookId: string, sourceRevision: string, resource: PublicationResource) => string | null;

/**
 * Served file names. The downscaled cover is `cover-thumb-v2`; older names are not
 * served, which makes stale caches regenerate. Kept in sync with
 * COVER_RESOURCE_FILE_NAMES in src/shared/contracts.ts — a mismatch there rejects
 * the entire book list, so both derive from that constant.
 */
const RESOURCE_BY_FILE_NAME: Record<string, PublicationResource> = {
  "book.epub": "book",
  [COVER_RESOURCE_FILE_NAMES[0]]: "cover",
  [COVER_RESOURCE_FILE_NAMES[1]]: "cover-thumb",
};

export function parsePublicationRequest(input: string) {
  const url = new URL(input);
  if (url.protocol !== "reader-resource:" || url.hostname !== "publication" || url.username || url.password || url.port || url.search || url.hash) {
    throw new Error("Invalid publication resource URL");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  const resource = parts[2] ? RESOURCE_BY_FILE_NAME[parts[2]] : undefined;
  if (parts.length !== 3 || !resource || !parts.slice(0, 2).every((part) => /^[A-Za-z0-9-]{1,128}$/.test(part))) {
    throw new Error("Invalid publication resource identity");
  }
  return { bookId: parts[0]!, sourceRevision: parts[1]!, resource };
}

const PUBLICATION_CSP = "default-src 'none'; script-src 'none'; connect-src 'none'; img-src reader-resource: data:; style-src reader-resource: 'unsafe-inline'; font-src reader-resource: data:; object-src 'none'; child-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";

function publicationHeaders(resource: PublicationResource) {
  // Publication bytes are keyed by an immutable (bookId, sourceRevision) identity,
  // so every non-book response can be cached for the life of that revision. Without
  // this, Chromium re-fetched and re-decoded every cover on each visit, which is what
  // made the collections view slow.
  const cacheable = resource !== "book";
  return {
    "Content-Security-Policy": PUBLICATION_CSP,
    "Access-Control-Allow-Origin": resource === "book" ? "reader-rendition://epub" : "reader-app://bundle",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": cacheable ? "private, max-age=31536000, immutable" : "no-store",
  };
}

export async function isPublicationResourceAllowed(path: string, resource: PublicationResource) {
  try {
    const facts = await stat(path);
    if (!facts.isFile()) return false;
    if (resource === "book") return facts.size > 0 && facts.size <= MAX_RENDERABLE_EPUB_BYTES;
    return facts.size > 0 && facts.size <= MAX_EPUB_COVER_BYTES;
  } catch {
    return false;
  }
}

export async function createPublicationResponse(request: Request, resolve: PublicationResolver) {
  try {
    const identity = parsePublicationRequest(request.url);
    const path = resolve(identity.bookId, identity.sourceRevision, identity.resource);
    if (!path) return new Response("Publication not found", { status: 404 });
    if (!await isPublicationResourceAllowed(path, identity.resource)) {
      return new Response("Publication not found", { status: 404 });
    }

    const bytes = await readFile(path);
    const contentType = identity.resource === "book"
      ? "application/epub+zip"
      : detectRasterCoverMediaType(bytes);
    if (!contentType) return new Response("Publication not found", { status: 404 });
    return new Response(bytes, { status: 200, headers: {
      "Content-Type": contentType,
      ...publicationHeaders(identity.resource),
    } });
  } catch {
    return new Response("Publication not found", { status: 404 });
  }
}
