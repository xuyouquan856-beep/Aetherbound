import { z } from "zod";
import { ReaderErrorCodes } from "./errors.js";
import type { ReadingRecordsApi } from "./reading-records.js";

export const BookPreparationStateSchema = z.enum([
  "queued",
  "preparing",
  "ready",
  "error",
]);
export type BookPreparationState = z.infer<typeof BookPreparationStateSchema>;

export const BookPreparationPrioritySchema = z.enum([
  "background",
  "interactive",
]);
export type BookPreparationPriority = z.infer<typeof BookPreparationPrioritySchema>;

export const BookPreparationJobSchema = z.object({
  bookId: z.string().min(1).max(128),
  sourceRevision: z.string().min(1).max(128),
  state: BookPreparationStateSchema,
  priority: BookPreparationPrioritySchema,
  attemptCount: z.number().int().nonnegative(),
  errorCode: z.enum(ReaderErrorCodes).nullable(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  startedAt: z.string().min(1).nullable(),
  completedAt: z.string().min(1).nullable(),
}).strict();
export type BookPreparationJob = z.infer<typeof BookPreparationJobSchema>;

export const PublicPreparationEventSchema = z.object({
  bookId: z.string().min(1).max(128),
  sourceRevision: z.string().min(1).max(128),
  state: BookPreparationStateSchema,
  errorCode: z.enum(ReaderErrorCodes).nullable(),
}).strict();
export type PublicPreparationEvent = z.infer<typeof PublicPreparationEventSchema>;

/**
 * Resource names the controlled publication cache may expose. Deliberately an
 * allowlist of file names rather than a pattern.
 *
 * `cover-thumb-v2` carries an encoder version: v1 was lossless PNG and averaged
 * 470 KB per cover, so the name changed to make stale caches regenerate. The
 * protocol handler in src/main/protocols/publication-protocol.ts maps exactly these
 * names, and a mismatch rejects the whole book list, so keep the two together.
 */
export const COVER_RESOURCE_FILE_NAMES = ["cover", "cover-thumb-v2"] as const;

/**
 * Cover URLs are opaque handles into the controlled publication cache. Only the
 * names above are accepted; anything else is rejected.
 */
export const ControlledCoverUrlSchema = z.string().refine((value) => {
  try {
    const url = new URL(value);
    const parts = url.pathname.split("/").filter(Boolean);
    return url.protocol === "reader-resource:"
      && url.hostname === "publication"
      && !url.username && !url.password && !url.port && !url.search && !url.hash
      && parts.length === 3
      && (COVER_RESOURCE_FILE_NAMES as readonly string[]).includes(parts[2]!)
      && parts.slice(0, 2).every((part) => /^[A-Za-z0-9-]{1,128}$/.test(part));
  } catch {
    return false;
  }
}, "Expected a controlled publication cover URL");

const BookSummaryFields = {
  id: z.string().min(1),
  title: z.string().min(1),
  author: z.string().nullable(),
  availabilityStatus: z.enum(["available", "unavailable"]),
  progress: z.number().min(0).max(1),
  addedAt: z.string().min(1),
  lastReadAt: z.string().min(1).nullable(),
  updatedAt: z.string().min(1),
  coverUrl: ControlledCoverUrlSchema.nullable(),
  preparationStatus: BookPreparationStateSchema.optional(),
  preparationErrorCode: z.enum(ReaderErrorCodes).nullable().optional(),
} as const;
export const TxtBookSummarySchema = z.object({ ...BookSummaryFields, format: z.literal("txt") }).strict();
export const EpubBookSummarySchema = z.object({ ...BookSummaryFields, format: z.literal("epub") }).strict();
export type TxtBookSummary = z.infer<typeof TxtBookSummarySchema>;
export type EpubBookSummary = z.infer<typeof EpubBookSummarySchema>;
export const BookSummarySchema = z.discriminatedUnion("format", [TxtBookSummarySchema, EpubBookSummarySchema]);
export type BookSummary = z.infer<typeof BookSummarySchema>;

export const ChapterSummarySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  index: z.number().int().nonnegative(),
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().nonnegative(),
}).strict();
export type ChapterSummary = z.infer<typeof ChapterSummarySchema>;

export const TextQuoteSchema = z.object({
  exact: z.string().max(256),
  prefix: z.string().max(256),
  suffix: z.string().max(256),
}).strict();

export const TxtReadingLocationSchema = z.object({
  locatorVersion: z.literal(1),
  sourceRevision: z.string().min(1),
  format: z.literal("txt"),
  primary: z.object({
    kind: z.literal("txt"),
    chapterId: z.string().min(1),
    characterOffset: z.number().int().nonnegative(),
    blockId: z.string().optional(),
  }).strict(),
  progression: z.object({
    resource: z.number().min(0).max(1),
    total: z.number().min(0).max(1).optional(),
  }).strict(),
  text: TextQuoteSchema,
}).strict();
export type TxtReadingLocationV1 = z.infer<typeof TxtReadingLocationSchema>;

const PublicationHrefSchema = z.string().min(1).max(2048).refine((value) => {
  const path = value.split(/[?#]/, 1)[0] ?? "";
  return !/^[a-z][a-z0-9+.-]*:/i.test(value)
    && !path.startsWith("/")
    && !path.includes("\\")
    && !path.split("/").some((segment) => segment === "." || segment === "..");
}, "Expected a normalized publication-relative href");

export const EpubReadingLocationSchema = z.object({
  locatorVersion: z.literal(1),
  sourceRevision: z.string().min(1),
  format: z.literal("epub"),
  primary: z.object({
    kind: z.literal("epub"),
    spineIndex: z.number().int().nonnegative(),
    spineHref: PublicationHrefSchema,
    engineLocator: z.object({
      kind: z.literal("epub-cfi"),
      value: z.string().min(1).startsWith("epubcfi("),
    }).strict(),
  }).strict(),
  progression: z.object({
    resource: z.number().min(0).max(1),
    total: z.number().min(0).max(1).optional(),
  }).strict(),
  text: TextQuoteSchema,
}).strict();
export type EpubReadingLocationV1 = z.infer<typeof EpubReadingLocationSchema>;

export const ReadingLocationSchema = z.discriminatedUnion("format", [
  TxtReadingLocationSchema,
  EpubReadingLocationSchema,
]);
export type ReadingLocationV1 = z.infer<typeof ReadingLocationSchema>;

export type TocNode = {
  id: string;
  label: string;
  href: string;
  children: TocNode[];
};

export const TocNodeSchema: z.ZodType<TocNode> = z.lazy(() => z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  href: PublicationHrefSchema,
  children: z.array(TocNodeSchema),
}).strict());

export const PublicationViewSchema = z.object({
  bookId: z.string().min(1),
  sourceRevision: z.string().min(1),
  metadata: z.object({
    title: z.string().min(1),
    author: z.string().nullable(),
    language: z.string().nullable(),
  }).strict(),
  toc: z.array(TocNodeSchema),
  spine: z.array(z.object({
    index: z.number().int().nonnegative(),
    href: PublicationHrefSchema,
    linear: z.boolean(),
  }).strict()),
}).strict();
export type PublicationView = z.infer<typeof PublicationViewSchema>;

export const MAX_RENDERABLE_EPUB_BYTES = 256 * 1024 * 1024;

const OpaquePublicationIdentitySchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9-]+$/);

export const EpubBinaryRequestSchema = z.object({
  bookId: OpaquePublicationIdentitySchema,
  sourceRevision: OpaquePublicationIdentitySchema,
}).strict();
export type EpubBinaryRequest = z.infer<typeof EpubBinaryRequestSchema>;

export const EpubBinaryResponseSchema = z.object({
  bookId: OpaquePublicationIdentitySchema,
  sourceRevision: OpaquePublicationIdentitySchema,
  mediaType: z.literal("application/epub+zip"),
  bytes: z.instanceof(Uint8Array)
    .refine((value) => value.byteLength > 0)
    .refine((value) => value.byteLength <= MAX_RENDERABLE_EPUB_BYTES),
}).strict();
export type EpubBinaryResponse = z.infer<typeof EpubBinaryResponseSchema>;

export const TxtBookDetailsSchema = z.object({
  book: TxtBookSummarySchema,
  sourceRevision: z.string().min(1),
  chapters: z.array(ChapterSummarySchema),
  savedLocation: TxtReadingLocationSchema.nullable(),
  sessionId: z.string().min(1),
}).strict();
export type TxtBookDetails = z.infer<typeof TxtBookDetailsSchema>;

export const EpubBookDetailsSchema = z.object({
  book: EpubBookSummarySchema,
  sourceRevision: z.string().min(1),
  publication: PublicationViewSchema,
  savedLocation: EpubReadingLocationSchema.nullable(),
  sessionId: z.string().min(1),
}).strict();
export type EpubBookDetails = z.infer<typeof EpubBookDetailsSchema>;

export const BookDetailsSchema = z.union([TxtBookDetailsSchema, EpubBookDetailsSchema]);
export type BookDetails = z.infer<typeof BookDetailsSchema>;

export function isTxtBookDetails(details: BookDetails): details is TxtBookDetails {
  return details.book.format === "txt";
}

export const ChapterContentSchema = z.object({
  bookId: z.string().min(1),
  sourceRevision: z.string().min(1),
  chapter: ChapterSummarySchema,
  text: z.string(),
  totalCharacters: z.number().int().nonnegative(),
}).strict();
export type ChapterContent = z.infer<typeof ChapterContentSchema>;

export const ReaderCommandIdSchema = z.enum([
  "reader.page.previous",
  "reader.page.next",
  "reader.brightness.increase",
  "reader.brightness.decrease",
  "reader.panel.toc.toggle",
  "reader.panel.appearance.toggle",
  "reader.panel.search.toggle",
]);
export type ReaderCommandId = z.infer<typeof ReaderCommandIdSchema>;

export const KeyBindingSchema = z.object({
  code: z.string().min(1).max(64),
  ctrl: z.boolean(),
  alt: z.boolean(),
  shift: z.boolean(),
  meta: z.boolean(),
}).strict();
export type KeyBinding = z.infer<typeof KeyBindingSchema>;

function bindingKey(binding: KeyBinding) {
  return `${binding.ctrl}:${binding.alt}:${binding.shift}:${binding.meta}:${binding.code}`;
}

const defaultSearchBinding: KeyBinding = {
  code: "KeyF",
  ctrl: true,
  alt: false,
  shift: false,
  meta: false,
};

const ReaderBindingsSchema = z.preprocess((input) => {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;
  if ("reader.panel.search.toggle" in record) return input;
  const existingKeys = new Set<string>();
  for (const list of Object.values(record)) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (item && typeof item === "object" && "code" in item) {
        existingKeys.add(bindingKey(item as KeyBinding));
      }
    }
  }
  return {
    ...record,
    "reader.panel.search.toggle": existingKeys.has(bindingKey(defaultSearchBinding))
      ? []
      : [defaultSearchBinding],
  };
}, z.record(
  ReaderCommandIdSchema,
  z.array(KeyBindingSchema).max(2),
));

export const ReaderShortcutProfileSchema = z.object({
  shortcutVersion: z.literal(1),
  bindings: ReaderBindingsSchema,
}).strict().superRefine((profile, context) => {
  for (const required of [
    "reader.page.previous",
    "reader.page.next",
    "reader.panel.appearance.toggle",
  ] as const) {
    if (!profile.bindings[required]?.length) {
      context.addIssue({
        code: "custom",
        path: ["bindings", required],
        message: "Core command requires a binding",
      });
    }
  }

  const seen = new Map<string, ReaderCommandId>();
  for (const [command, bindings] of Object.entries(profile.bindings) as Array<[ReaderCommandId, KeyBinding[]]>) {
    for (const binding of bindings) {
      if (["Escape", "F11"].includes(binding.code)) {
        context.addIssue({
          code: "custom",
          path: ["bindings", command],
          message: `${binding.code} is reserved`,
        });
      }
      const key = bindingKey(binding);
      const existing = seen.get(key);
      if (existing) {
        context.addIssue({
          code: "custom",
          path: ["bindings", command],
          message: `Binding conflicts with ${existing}`,
        });
      }
      seen.set(key, command);
    }
  }
});
export type ReaderShortcutProfileV1 = z.infer<typeof ReaderShortcutProfileSchema>;

const key = (code: string): KeyBinding => ({
  code,
  ctrl: false,
  alt: false,
  shift: false,
  meta: false,
});

export const DefaultReaderShortcutProfile: ReaderShortcutProfileV1 = {
  shortcutVersion: 1,
  bindings: {
    "reader.page.previous": [key("KeyA"), key("ArrowLeft")],
    "reader.page.next": [key("KeyD"), key("ArrowRight")],
    "reader.brightness.increase": [key("KeyW")],
    "reader.brightness.decrease": [key("KeyS")],
    "reader.panel.toc.toggle": [key("KeyC")],
    "reader.panel.appearance.toggle": [key("KeyV")],
    "reader.panel.search.toggle": [{ ...defaultSearchBinding }],
  },
};

export const ReadingAppearanceSchema = z.object({
  theme: z.enum(["paper", "night"]),
  fontFamily: z.enum(["serif", "sans"]),
  fontSize: z.number().min(14).max(36),
  lineHeight: z.number().min(1.4).max(2.4),
  measure: z.number().min(520).max(920),
  brightness: z.number().min(30).max(100).default(100),
  epubFlow: z.enum(["paginated", "scrolled"]).default("paginated"),
  epubColumns: z.enum(["single", "double"]).default("double"),
  txtFlow: z.enum(["paginated", "scrolled"]).optional(),
  txtColumns: z.enum(["single", "double"]).optional(),
  paragraphSpacing: z.number().min(0).max(1.5).default(0),
  firstLineIndent: z.enum(["none", "two-em"]).default("two-em"),
  letterSpacing: z.number().min(0).max(0.2).default(0),
}).strict();
export type ReadingAppearance = z.infer<typeof ReadingAppearanceSchema>;

export const DefaultReadingAppearance: ReadingAppearance = {
  theme: "paper",
  fontFamily: "serif",
  fontSize: 20,
  lineHeight: 1.85,
  measure: 720,
  brightness: 100,
  epubFlow: "paginated",
  epubColumns: "double",
  paragraphSpacing: 0,
  firstLineIndent: "two-em",
  letterSpacing: 0,
};

export const ImportTxtResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("cancelled") }).strict(),
  z.object({ status: z.literal("imported"), book: BookSummarySchema }).strict(),
]);
export type ImportTxtResult = z.infer<typeof ImportTxtResultSchema>;

export const ImportEpubResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("cancelled") }).strict(),
  z.object({ status: z.literal("imported"), book: EpubBookSummarySchema }).strict(),
]);
export type ImportEpubResult = z.infer<typeof ImportEpubResultSchema>;

export const LibraryImportFormatSchema = z.enum(["txt", "epub"]);
export type LibraryImportFormat = z.infer<typeof LibraryImportFormatSchema>;

const ImportFileNameSchema = z.string().min(1).max(255)
  .refine((value) => !/[\\/]/.test(value), "Expected a file name, not a path");

export const LibraryImportItemResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("imported"),
    fileName: ImportFileNameSchema,
    book: BookSummarySchema,
  }).strict(),
  z.object({
    status: z.literal("duplicate"),
    fileName: ImportFileNameSchema,
    book: BookSummarySchema,
  }).strict(),
  z.object({
    status: z.literal("unsupported"),
    fileName: ImportFileNameSchema,
    errorCode: z.literal("FORMAT_NOT_SUPPORTED"),
  }).strict(),
  z.object({
    status: z.literal("failed"),
    fileName: ImportFileNameSchema,
    errorCode: z.enum(ReaderErrorCodes),
    message: z.string().min(1).max(500),
  }).strict(),
]);
export type LibraryImportItemResult = z.infer<typeof LibraryImportItemResultSchema>;

export const LibraryImportBatchResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("cancelled") }).strict(),
  z.object({
    status: z.literal("completed"),
    items: z.array(LibraryImportItemResultSchema).max(10000),
  }).strict(),
]);
export type LibraryImportBatchResult = z.infer<typeof LibraryImportBatchResultSchema>;

export const OpaqueBookIdSchema = z.string().min(1).max(128)
  .refine((value) => !/[\\/:]/.test(value), "Expected an opaque book id");

export const RetainedReaderRequestSchema = z.object({
  bookId: OpaqueBookIdSchema,
  sourceRevision: z.string().min(1).max(128),
}).strict();

export const LibraryRemoveRequestSchema = z.object({
  bookIds: z.array(OpaqueBookIdSchema).min(1).max(1000)
    .refine((ids) => new Set(ids).size === ids.length, "Book ids must be unique"),
  deleteOriginal: z.boolean().optional(),
}).strict();

export const LibraryRemoveResultSchema = z.object({
  removed: z.number().int().nonnegative(),
  failedToDelete: z.number().int().nonnegative().optional(),
}).strict();
export type LibraryRemoveResult = z.infer<typeof LibraryRemoveResultSchema>;

export const LibraryUpdateBookRequestSchema = z.object({
  bookId: OpaqueBookIdSchema,
  title: z.string().trim().min(1).max(200),
  author: z.string().trim().max(150).nullable(),
}).strict();
export type LibraryUpdateBookRequest = z.infer<typeof LibraryUpdateBookRequestSchema>;

export const LibrarySetReadingStateRequestSchema = z.object({
  bookId: OpaqueBookIdSchema,
  state: z.enum(["unread", "finished"]),
}).strict();
export type LibrarySetReadingStateRequest = z.infer<typeof LibrarySetReadingStateRequestSchema>;

export const LibraryImportPathsRequestSchema = z.object({
  paths: z.array(z.string().min(1).max(2048)).min(1).max(500),
}).strict();
export type LibraryImportPathsRequest = z.infer<typeof LibraryImportPathsRequestSchema>;

export const CollectionNameSchema = z.string().trim().min(1).max(80);
export const CollectionIdSchema = z.string().min(1).max(128)
  .refine((value) => !/[\\/:]/.test(value), "Expected an opaque collection id");
export const CollectionBookIdsSchema = z.array(OpaqueBookIdSchema).min(1).max(2000)
  .refine((ids) => new Set(ids).size === ids.length, "Book ids must be unique");

export const CollectionSummarySchema = z.object({
  id: CollectionIdSchema,
  name: CollectionNameSchema,
  bookCount: z.number().int().nonnegative(),
  previewBooks: z.array(BookSummarySchema).max(3),
  updatedAt: z.string().min(1),
}).strict();
export type CollectionSummary = z.infer<typeof CollectionSummarySchema>;

export const CollectionDetailsSchema = z.object({
  id: CollectionIdSchema,
  name: CollectionNameSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  books: z.array(BookSummarySchema).max(10000),
}).strict();
export type CollectionDetails = z.infer<typeof CollectionDetailsSchema>;

export const CollectionMembershipSchema = z.object({
  collectionId: CollectionIdSchema,
  bookIds: CollectionBookIdsSchema,
}).strict();
export type CollectionMembership = z.infer<typeof CollectionMembershipSchema>;

export const CollectionIdRequestSchema = z.object({
  id: CollectionIdSchema,
}).strict();
export const CollectionCreateRequestSchema = z.object({
  name: CollectionNameSchema,
}).strict();
export const CollectionRenameRequestSchema = z.object({
  id: CollectionIdSchema,
  name: CollectionNameSchema,
}).strict();
export const CollectionBookIdsRequestSchema = z.object({
  id: CollectionIdSchema,
  bookIds: CollectionBookIdsSchema,
}).strict();
export const CollectionMembershipsRequestSchema = z.object({
  bookIds: CollectionBookIdsSchema,
}).strict();

const FolderNameSchema = z.string().min(1).max(255)
  .refine((value) => !/[\\/:]/.test(value), "Expected a folder basename");

export const FolderCollectionImportProgressSchema = z.object({
  processed: z.number().int().min(0).max(10000),
  total: z.number().int().min(0).max(10000),
  fileName: ImportFileNameSchema.nullable(),
}).strict().refine(
  ({ processed, total }) => processed <= total,
  { message: "Processed count cannot exceed total", path: ["processed"] },
);
export type FolderCollectionImportProgress = z.infer<typeof FolderCollectionImportProgressSchema>;
export const LibraryImportProgressSchema = FolderCollectionImportProgressSchema;
export type LibraryImportProgress = FolderCollectionImportProgress;

export const FolderCollectionImportResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("cancelled") }).strict(),
  z.object({
    status: z.literal("empty"),
    folderName: FolderNameSchema,
  }).strict(),
  z.object({
    status: z.literal("failed"),
    folderName: FolderNameSchema,
    items: z.array(LibraryImportItemResultSchema).min(1).max(10000),
    ignoredEntries: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    status: z.literal("organized"),
    folderName: FolderNameSchema,
    collections: z.array(CollectionSummarySchema).max(10000),
    rootFiles: z.number().int().nonnegative(),
    items: z.array(LibraryImportItemResultSchema).max(10000),
    ignoredEntries: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    status: z.literal("completed"),
    folderName: FolderNameSchema,
    collection: CollectionSummarySchema,
    items: z.array(LibraryImportItemResultSchema).max(10000),
    ignoredEntries: z.number().int().nonnegative(),
  }).strict(),
]);
export type FolderCollectionImportResult = z.infer<typeof FolderCollectionImportResultSchema>;

// --- Library scan contracts -------------------------------------------------
// These were removed by 7cfce8a ("refactor: isolate and stabilize Reader Core")
// while the implementation in src/backend/library-scan/** stayed behind. The
// subsystem has therefore not compiled or tested since; restoring the original
// declarations is what makes it verifiable again.

export const OpaqueScanJobIdSchema = z.string().min(1).max(128)
  .refine((value) => !/[\\/:]/.test(value), "Expected an opaque scan job id");

export const LibraryScanStateSchema = z.enum([
  "queued", "running", "paused", "completed", "cancelled", "failed", "recoverable",
]);
export type LibraryScanState = z.infer<typeof LibraryScanStateSchema>;

export const LibraryScanPhaseSchema = z.enum([
  "inventory", "metadata", "local_resolution", "agent_resolution", "apply", "completed",
]);
export type LibraryScanPhase = z.infer<typeof LibraryScanPhaseSchema>;

export const LibraryScanCountersSchema = z.object({
  discovered: z.number().int().nonnegative(),
  supported: z.number().int().nonnegative(),
  cached: z.number().int().nonnegative(),
  queued: z.number().int().nonnegative(),
  processed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative().default(0),
  errors: z.number().int().nonnegative(),
  metadataTotal: z.number().int().nonnegative().default(0),
  metadataProcessed: z.number().int().nonnegative().default(0),
  metadataErrors: z.number().int().nonnegative().default(0),
  resolutionTotal: z.number().int().nonnegative().default(0),
  resolutionProcessed: z.number().int().nonnegative().default(0),
  resolutionFindings: z.number().int().nonnegative().default(0),
  resolutionRecycled: z.number().int().nonnegative().default(0),
  agentTotal: z.number().int().nonnegative().default(0),
  agentProcessed: z.number().int().nonnegative().default(0),
  agentResolved: z.number().int().nonnegative().default(0),
  agentPending: z.number().int().nonnegative().default(0),
  seriesApplied: z.number().int().nonnegative().default(0),
  seriesSkipped: z.number().int().nonnegative().default(0),
}).strict();
export type LibraryScanCounters = z.infer<typeof LibraryScanCountersSchema>;

export const InventoryMetadataSchema = z.object({
  metadataVersion: z.literal(1),
  title: z.string().trim().min(1).max(500).refine((val) => !/[a-z]:[\\/]/i.test(val), "Title must not contain absolute paths"),
  author: z.string().trim().max(300).nullable(),
  language: z.string().trim().max(64).nullable(),
  identifier: z.string().trim().max(500).nullable(),
  source: z.enum(["txt-head", "epub-opf"]),
}).strict();
export type InventoryMetadata = z.infer<typeof InventoryMetadataSchema>;

export const ScanFindingKindSchema = z.enum(["exact_duplicate", "series_volume", "edition_variant"]);
export type ScanFindingKind = z.infer<typeof ScanFindingKindSchema>;

export const ScanFindingStatusSchema = z.enum(["new", "auto_applied", "needs_review", "accepted", "rejected", "stale"]);
export type ScanFindingStatus = z.infer<typeof ScanFindingStatusSchema>;

export const ExactDuplicateEvidenceSchema = z.object({
  kind: z.literal("exact_duplicate"),
  evidenceVersion: z.literal(1),
  algorithm: z.literal("sha256"),
  fullContentHash: z.string().length(64),
  survivorInventoryId: z.string().min(1),
  volumeConflict: z.boolean(),
  ruleCodes: z.array(z.string()),
}).strict();

export const SeriesVolumeEvidenceSchema = z.object({
  kind: z.literal("series_volume"),
  evidenceVersion: z.literal(1),
  normalizedSeries: z.string().min(1),
  volumeLabel: z.string().nullable(),
  volumeIndex: z.number().int().nullable(),
  ruleCodes: z.array(z.string()),
}).strict();

export const EditionVariantEvidenceSchema = z.object({
  kind: z.literal("edition_variant"),
  evidenceVersion: z.literal(1),
  normalizedTitle: z.string().min(1),
  variantSignals: z.array(z.string()),
  ruleCodes: z.array(z.string()),
}).strict();

export const ScanFindingEvidenceSchema = z.discriminatedUnion("kind", [
  ExactDuplicateEvidenceSchema,
  SeriesVolumeEvidenceSchema,
  EditionVariantEvidenceSchema,
]);
export type ScanFindingEvidence = z.infer<typeof ScanFindingEvidenceSchema>;

export const ScanFindingCandidateIdsSchema = z.array(
  z.string().min(1).refine((val) => !/[a-z]:[\\/]/i.test(val), "Candidate ID must not contain absolute paths")
).min(1);
export type ScanFindingCandidateIds = z.infer<typeof ScanFindingCandidateIdsSchema>;

const PublicRootNameSchema = z.string().min(1).max(255).refine((value) => {
  return !/^[a-z]:[\\/]/i.test(value)
    && !value.startsWith("/")
    && !value.startsWith("\\")
    && !value.includes("\\\\");
}, "Expected a root display name, not a path");

export const LibraryScanSnapshotSchema = z.object({
  jobId: OpaqueScanJobIdSchema,
  rootName: PublicRootNameSchema,
  state: LibraryScanStateSchema,
  phase: LibraryScanPhaseSchema,
  counters: LibraryScanCountersSchema,
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  errorCode: z.string().min(1).max(128).nullable(),
}).strict();
export type LibraryScanSnapshot = z.infer<typeof LibraryScanSnapshotSchema>;

export const FindingSummarySchema = z.object({
  id: z.string().min(1),
  kind: ScanFindingKindSchema,
  status: ScanFindingStatusSchema,
  summary: z.string().max(500),
  candidateCount: z.number().int().nonnegative().default(1),
}).strict();
export type FindingSummary = z.infer<typeof FindingSummarySchema>;

export const LibraryScanJobRequestSchema = z.object({
  jobId: OpaqueScanJobIdSchema,
}).strict();

/**
 * Result of choosing a folder to scan.
 *
 * Deliberately carries no path. The main process owns the folder location; the
 * renderer receives only a display name, so a renderer compromise cannot learn or
 * exfiltrate where the user keeps their books.
 */
export const ScanFolderSelectionSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("cancelled") }).strict(),
  z.object({
    status: z.literal("selected"),
    displayName: PublicRootNameSchema,
    /** True when this folder was scanned before, so the UI can say so. */
    alreadyAuthorized: z.boolean(),
  }).strict(),
]);
export type ScanFolderSelection = z.infer<typeof ScanFolderSelectionSchema>;

/**
 * A path relative to the scanned folder, which is the only filesystem shape the
 * renderer is ever shown. Absolute paths, drive letters and UNC prefixes are refused
 * so a review list can never become a way to read the user's directory layout.
 */
const ScanRelativePathSchema = z.string().min(1).max(1024).refine((value) => {
  return !/^[a-z]:[\\/]/i.test(value)
    && !value.startsWith("/")
    && !value.startsWith("\\")
    && !value.includes("\\\\")
    && !value.split(/[\\/]/).some((part) => part === ".." || part === "");
}, "Expected a relative path inside the scanned folder");

/**
 * One file behind a finding, enriched with what the library already knows about it.
 *
 * `bookId` is null for a file that has never been imported; those are the rows the
 * "未入库" list offers to import. Keeping the two facts on one object is what lets the
 * UI say "this duplicate's other copy is already in your library" instead of asking
 * the user to compare paths by eye.
 */
export const ScanFindingCandidateSchema = z.object({
  inventoryId: z.string().min(1).max(128),
  relativePath: ScanRelativePathSchema,
  format: LibraryImportFormatSchema,
  fileSize: z.number().int().nonnegative(),
  modifiedAt: z.string().min(1),
  title: z.string().max(500).nullable(),
  author: z.string().max(300).nullable(),
  bookId: z.string().min(1).max(128).nullable(),
}).strict();
export type ScanFindingCandidate = z.infer<typeof ScanFindingCandidateSchema>;

/**
 * What accepting a finding would do, resolved before the user is asked.
 *
 * The confirmation step has to state the concrete consequence — how many files, how
 * much space, which book survives — rather than a generic "apply". `none` is a real
 * answer: a series whose volumes were never imported has nothing to add to a
 * collection yet, and saying so is better than an empty confirm button.
 */
export const ScanProposedActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("recycle_duplicates"),
    survivorInventoryId: z.string().min(1).max(128),
    victimInventoryIds: z.array(z.string().min(1).max(128)).min(1),
    reclaimableBytes: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    kind: z.literal("create_collection"),
    name: z.string().min(1).max(200),
    bookIds: z.array(z.string().min(1).max(128)).min(1),
  }).strict(),
  z.object({
    kind: z.literal("none"),
    reason: z.enum(["nothing_imported", "already_decided", "evidence_stale"]),
  }).strict(),
]);
export type ScanProposedAction = z.infer<typeof ScanProposedActionSchema>;

export const ScanFindingDetailSchema = FindingSummarySchema.extend({
  confidence: z.number().min(0).max(1),
  createdAt: z.string().min(1),
  resolvedAt: z.string().min(1).nullable(),
  evidence: ScanFindingEvidenceSchema,
  candidates: z.array(ScanFindingCandidateSchema).max(500),
  proposedAction: ScanProposedActionSchema,
}).strict();
export type ScanFindingDetail = z.infer<typeof ScanFindingDetailSchema>;

export const ScanFindingListRequestSchema = z.object({
  limit: z.number().int().min(1).max(100).default(30),
  offset: z.number().int().min(0).default(0),
  includeResolved: z.boolean().default(false),
  /** Restrict to one kind, so each review tab asks for its own queue. */
  kind: ScanFindingKindSchema.optional(),
}).strict();
export type ScanFindingListRequest = z.infer<typeof ScanFindingListRequestSchema>;

export const ScanFindingListSchema = z.object({
  rootName: PublicRootNameSchema.nullable(),
  findings: z.array(ScanFindingDetailSchema).max(100),
  total: z.number().int().nonnegative(),
  awaitingReview: z.number().int().nonnegative(),
}).strict();
export type ScanFindingList = z.infer<typeof ScanFindingListSchema>;

/**
 * What a finished scan amounts to.
 *
 * The review screen used to open on two flat lists with no statement of what had
 * happened, so the user had to reconstruct the situation from counters and badges. This
 * is that statement, and it is also what the action labels are built from ("导入全部
 * 780 本" has to know the number is 780).
 */
export const ScanOverviewSchema = z.object({
  rootName: PublicRootNameSchema.nullable(),
  /** Present, non-missing book files in the folder. */
  present: z.number().int().nonnegative(),
  inLibrary: z.number().int().nonnegative(),
  /** Present files the library does not have yet — the import queue. */
  unimported: z.number().int().nonnegative(),
  /** Files a previous scan saw that are no longer on disk. */
  missing: z.number().int().nonnegative(),
  duplicateGroups: z.number().int().nonnegative(),
  /** Duplicate groups that can be cleared without a judgement call. */
  clearableDuplicateGroups: z.number().int().nonnegative(),
  reclaimableBytes: z.number().int().nonnegative(),
  /** Duplicate groups whose filenames disagree about the volume; always manual. */
  conflictedDuplicateGroups: z.number().int().nonnegative(),
  seriesGroups: z.number().int().nonnegative(),
  /** Series whose volumes are all in the library, so a collection can be built now. */
  seriesReadyToCollect: z.number().int().nonnegative(),
  seriesPendingImport: z.number().int().nonnegative(),
  scannedAt: z.string().min(1).nullable(),
}).strict();
export type ScanOverview = z.infer<typeof ScanOverviewSchema>;

export const ScanDecisionRequestSchema = z.object({
  findingId: z.string().min(1).max(128),
  decision: z.enum(["accept", "reject"]),
}).strict();
export type ScanDecisionRequest = z.infer<typeof ScanDecisionRequestSchema>;

export const ScanDecisionResultSchema = z.object({
  findingId: z.string().min(1).max(128),
  status: ScanFindingStatusSchema,
  /** False when the decision was recorded but no action was needed or possible. */
  applied: z.boolean(),
  summary: z.string().min(1).max(500),
  /** Books whose state changed, so the caller knows to refresh the library. */
  affectedBookIds: z.array(z.string().min(1).max(128)).max(500),
}).strict();
export type ScanDecisionResult = z.infer<typeof ScanDecisionResultSchema>;

export const ScanBatchDecisionRequestSchema = z.object({
  kind: ScanFindingKindSchema,
  decision: z.enum(["accept", "reject"]),
}).strict();
export type ScanBatchDecisionRequest = z.infer<typeof ScanBatchDecisionRequestSchema>;

/**
 * The result of clearing a whole queue at once.
 *
 * `skipped` is the important field. A batch accept deliberately leaves behind the
 * findings that need a human — duplicates whose filenames disagree about the volume,
 * series with no imported volume — and an aggregate that only reported successes would
 * make those look handled.
 */
export const ScanBatchDecisionResultSchema = z.object({
  kind: ScanFindingKindSchema,
  considered: z.number().int().nonnegative(),
  applied: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  summary: z.string().min(1).max(500),
  affectedBookIds: z.array(z.string().min(1).max(128)).max(2000),
}).strict();
export type ScanBatchDecisionResult = z.infer<typeof ScanBatchDecisionResultSchema>;

export const ScanFileListRequestSchema = z.object({
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
  /** Restrict to files the library does not have yet — the "未入库" list. */
  onlyUnimported: z.boolean().default(false),
}).strict();
export type ScanFileListRequest = z.infer<typeof ScanFileListRequestSchema>;

export const ScanFileListSchema = z.object({
  rootName: PublicRootNameSchema.nullable(),
  /** Present, non-missing files in the scanned folder, newest first. */
  files: z.array(ScanFindingCandidateSchema).max(200),
  /**
   * Files matching the current filter, which is what `files` is a page of.
   *
   * Distinct from `present` on purpose: with "只看未入库" on, `total` is the number of
   * files still to import while `present` is how many the folder holds. Reporting one
   * number for both produced a header that read "1 个文件 · 已入库 3".
   */
  total: z.number().int().nonnegative(),
  /** Every present file, regardless of filter. */
  present: z.number().int().nonnegative(),
  inLibrary: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
}).strict();
export type ScanFileList = z.infer<typeof ScanFileListSchema>;

/**
 * Bringing scanned files into the library.
 *
 * `scope` exists because "import everything new" is the common case and the renderer
 * cannot name every file for it: the folder can hold thousands, and listing them all
 * just to send the ids back would mean paging through the whole inventory first. Main
 * resolves the scope itself.
 */
export const ScanImportRequestSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("all-unimported") }).strict(),
  z.object({
    scope: z.literal("selected"),
    inventoryIds: z.array(z.string().min(1).max(128)).min(1).max(2000)
      .refine((ids) => new Set(ids).size === ids.length, "Inventory ids must be unique"),
  }).strict(),
]);
export type ScanImportRequest = z.infer<typeof ScanImportRequestSchema>;

/**
 * Importing and filing in one step.
 *
 * "Import these, then put them in a collection" is what organizing a folder actually
 * looks like, and doing it as two separate errands — import, then go find the books
 * again in 全部书籍 — is what made the first version tedious.
 */
export const ScanOrganizeRequestSchema = z.object({
  inventoryIds: z.array(z.string().min(1).max(128)).min(1).max(2000)
    .refine((ids) => new Set(ids).size === ids.length, "Inventory ids must be unique"),
  /** Target an existing collection... */
  collectionId: z.string().min(1).max(128).optional(),
  /** ...or name a new one. Exactly one of the two is required. */
  newCollectionName: CollectionNameSchema.optional(),
}).strict().refine(
  (value) => (value.collectionId === undefined) !== (value.newCollectionName === undefined),
  "Provide either collectionId or newCollectionName",
);
export type ScanOrganizeRequest = z.infer<typeof ScanOrganizeRequestSchema>;

/**
 * Live progress for a library mutation the scan screen started.
 *
 * Importing a thousand files is not instant, and the first version reported nothing
 * until it finished. The counts are cumulative so a dropped event costs nothing.
 */
export const ScanImportProgressSchema = z.object({
  phase: z.enum(["importing", "filing", "completed", "cancelled", "failed"]),
  processed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  imported: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  /**
   * Last file touched, so the run is visibly moving. A *name*, not a path: the
   * refinement is what makes that true rather than merely intended, because this is the
   * one event that carries something derived from a real location.
   */
  fileName: z.string().min(1).max(255)
    .refine((value) => !/[\\/:]/.test(value), "Expected a file name, not a path")
    .nullable(),
  collectionName: z.string().max(200).nullable(),
  summary: z.string().max(500).nullable(),
}).strict();
export type ScanImportProgress = z.infer<typeof ScanImportProgressSchema>;

export const AppInfoSchema = z.object({ name: z.string(), version: z.string(), platform: z.string() }).strict();
export type AppInfo = z.infer<typeof AppInfoSchema>;

export type FulltextSearchResult = {
  bookId: string;
  title: string;
  matchSnippet: string;
  unitIndex: number;
};

export type FulltextSearchRequest = z.infer<typeof FulltextSearchRequestSchema>;

export const FulltextSearchResultSchema = z.object({
  bookId: z.string(),
  title: z.string(),
  matchSnippet: z.string(),
  unitIndex: z.number(),
}).strict();

export const FulltextSearchResponseSchema = z.array(FulltextSearchResultSchema);

export const FulltextSearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(200),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
}).strict();

export type ReaderApi = {
  records?: ReadingRecordsApi;
  app: { getInfo(): Promise<AppInfo>; openExternalUrl?(url: string): Promise<void> };
  library: {
    list(): Promise<BookSummary[]>;
    importTxt(): Promise<LibraryImportBatchResult>;
    importEpub(): Promise<LibraryImportBatchResult>;
    importFiles(): Promise<LibraryImportBatchResult>;
    onImportProgress(listener: (value: LibraryImportProgress) => void): () => void;
    remove(bookIds: string[], deleteOriginal?: boolean): Promise<LibraryRemoveResult>;
    relocate?(bookId: string): Promise<BookSummary | null>;
    updateBook?(input: LibraryUpdateBookRequest): Promise<BookSummary>;
    setReadingState?(input: LibrarySetReadingStateRequest): Promise<BookSummary>;
    revealInFolder?(bookId: string): Promise<boolean>;
    importPaths?(paths: string[]): Promise<LibraryImportBatchResult>;
    getFilePath?(file: File): string | null;
    retryPreparation(bookId: string): Promise<void>;
    onPreparationChanged(
      listener: (event: PublicPreparationEvent) => void,
    ): () => void;
  };
  collections: {
    list(): Promise<CollectionSummary[]>;
    get(id: string): Promise<CollectionDetails>;
    create(name: string): Promise<CollectionDetails>;
    rename(id: string, name: string): Promise<CollectionDetails>;
    delete(id: string): Promise<void>;
    addBooks(id: string, bookIds: string[]): Promise<CollectionDetails>;
    removeBooks(id: string, bookIds: string[]): Promise<CollectionDetails>;
    reorder(id: string, bookIds: string[]): Promise<CollectionDetails>;
    getMemberships(bookIds: string[]): Promise<CollectionMembership[]>;
    listUnorganized(): Promise<BookSummary[]>;
    importFolder(targetCollectionId?: string): Promise<FolderCollectionImportResult>;
    importOrganizedFolder(): Promise<FolderCollectionImportResult>;
    importFiles(id: string): Promise<LibraryImportBatchResult>;
    onFolderImportProgress(
      listener: (value: FolderCollectionImportProgress) => void,
    ): () => void;
  };
  reader: {
    open(bookId: string): Promise<BookDetails>;
    getEpubBinary(
      bookId: string,
      sourceRevision: string,
    ): Promise<EpubBinaryResponse>;
    canResume(bookId: string, sourceRevision: string): Promise<boolean>;
    getChapter(bookId: string, chapterId: string): Promise<ChapterContent>;
    saveProgress(bookId: string, sessionId: string, location: ReadingLocationV1): Promise<void>;
    closeSession(bookId: string, sessionId: string, location: ReadingLocationV1 | null): Promise<void>;
  };
  settings: {
    getAppearance(): Promise<ReadingAppearance>;
    updateAppearance(value: ReadingAppearance): Promise<ReadingAppearance>;
    getShortcuts(): Promise<ReaderShortcutProfileV1>;
    updateShortcuts(value: ReaderShortcutProfileV1): Promise<ReaderShortcutProfileV1>;
  };
  search: { fulltext(request: FulltextSearchRequest): Promise<FulltextSearchResult[]> };
  /**
   * The folder-scan subsystem.
   *
   * Every method here is deliberately path-free. The renderer opens a folder through a
   * main-process dialog and afterwards refers to it only by an opaque root, so a
   * compromised renderer cannot name a location and ask main to scan it.
   */
  scan: {
    chooseFolder(): Promise<ScanFolderSelection>;
    start(): Promise<LibraryScanSnapshot>;
    active(): Promise<LibraryScanSnapshot | null>;
    pause(jobId: string): Promise<LibraryScanSnapshot>;
    resume(jobId: string): Promise<LibraryScanSnapshot>;
    cancel(jobId: string): Promise<LibraryScanSnapshot>;
    /** What the scan found, as counts — the screen's headline. */
    overview(): Promise<ScanOverview>;
    findings(request: ScanFindingListRequest): Promise<ScanFindingList>;
    decide(request: ScanDecisionRequest): Promise<ScanDecisionResult>;
    /** Clear a whole queue, leaving behind whatever needs a human. */
    decideBatch(request: ScanBatchDecisionRequest): Promise<ScanBatchDecisionResult>;
    files(request: ScanFileListRequest): Promise<ScanFileList>;
    importFiles(request: ScanImportRequest): Promise<ScanImportProgress>;
    /** Import whatever is missing, then file the result into a collection. */
    organize(request: ScanOrganizeRequest): Promise<ScanImportProgress>;
    /** Stop the running import between files; what is already in stays in. */
    cancelImport(): Promise<ScanImportProgress | null>;
    /** True while an import or organize run is in flight. */
    activeImport(): Promise<ScanImportProgress | null>;
    onProgress(listener: (snapshot: LibraryScanSnapshot) => void): () => void;
    onImportProgress(listener: (progress: ScanImportProgress) => void): () => void;
  };
}
