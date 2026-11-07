import { z } from "zod";

const SafeRelativePathSchema = z.string().min(1).superRefine((value, context) => {
  if (value.includes("\\")) {
    context.addIssue({ code: "custom", message: "Relative paths must use forward slashes." });
  }
  if (/^(?:[a-z]:|\/)/i.test(value)) {
    context.addIssue({ code: "custom", message: "Absolute paths are forbidden." });
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    context.addIssue({ code: "custom", message: "Unsafe relative path segment." });
  }
});

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const IsoDateSchema = z.iso.datetime({ offset: true });

export const ClassificationStatusSchema = z.enum([
  "confirmed",
  "probable",
  "ambiguous",
  "unclassified",
  "misplaced",
]);
export type ClassificationStatus = z.infer<typeof ClassificationStatusSchema>;

export const EvidenceCodeSchema = z.enum([
  "OPF_SERIES_EXACT",
  "OPF_GROUP_POSITION",
  "TITLE_BASE_EXACT",
  "TITLE_PAGE_EXACT",
  "REVIEWED_ALIAS",
  "AUTHOR_MATCH",
  "PUBLISHER_MATCH",
  "VOLUME_SEQUENCE",
  "EDITION_LABEL",
  "EXISTING_FOLDER_ONLY",
]);
export type EvidenceCode = z.infer<typeof EvidenceCodeSchema>;

export const ManifestEntrySchema = z.object({
  inventoryVersion: z.literal(1),
  relativePath: SafeRelativePathSchema,
  extension: z.enum([".epub", ".txt"]),
  fileSize: z.number().int().nonnegative(),
  modifiedAt: IsoDateSchema,
  sha256: Sha256Schema,
  parentFolder: z.string(),
}).strict();
export type ManifestEntry = z.infer<typeof ManifestEntrySchema>;

export const EpubMetadataSchema = z.object({
  metadataVersion: z.literal(1),
  relativePath: SafeRelativePathSchema,
  title: z.string().min(1),
  creator: z.string().min(1).nullable(),
  language: z.string().min(1).nullable(),
  identifier: z.string().min(1).nullable(),
  publisher: z.string().min(1).nullable(),
  publishedAt: z.string().min(1).nullable(),
  series: z.string().min(1).nullable(),
  groupPosition: z.number().finite().nonnegative().nullable(),
  source: z.literal("epub-opf"),
}).strict();
export type EpubMetadata = z.infer<typeof EpubMetadataSchema>;

export const AliasRecordSchema = z.object({
  aliasVersion: z.literal(1),
  canonicalSeriesName: z.string().min(1),
  aliases: z.array(z.string().min(1)).min(1),
  evidence: z.array(z.object({
    kind: z.enum(["opf", "title-page", "publisher-page", "bibliographic-source"]),
    source: z.string().min(1),
    verifiedAt: IsoDateSchema,
  }).strict()).min(1),
  reviewed: z.literal(true),
}).strict();
export type AliasRecord = z.infer<typeof AliasRecordSchema>;

export const ClassificationRecordSchema = z.object({
  relativePath: SafeRelativePathSchema,
  status: ClassificationStatusSchema,
  canonicalSeriesName: z.string().min(1).nullable(),
  evidenceCodes: z.array(EvidenceCodeSchema),
  evidenceSummary: z.string().min(1),
  conflictingSeries: z.array(z.string().min(1)).default([]),
}).strict();
export type ClassificationRecord = z.infer<typeof ClassificationRecordSchema>;

export const PreviewActionSchema = z.object({
  actionId: z.string().min(1),
  kind: z.literal("move"),
  status: z.literal("confirmed"),
  sourceRelativePath: SafeRelativePathSchema,
  proposedRelativePath: SafeRelativePathSchema,
  seriesCanonicalName: z.string().min(1),
  editionLabels: z.array(z.string().min(1)),
  volumeLabel: z.string().min(1).nullable(),
  title: z.string().min(1),
  creator: z.string().min(1).nullable(),
  evidenceCodes: z.array(EvidenceCodeSchema).min(1),
  evidenceSummary: z.string().min(1),
  fileSize: z.number().int().nonnegative(),
  modifiedAt: IsoDateSchema,
  sha256: Sha256Schema,
}).strict().superRefine((action, context) => {
  if (action.sourceRelativePath === action.proposedRelativePath) {
    context.addIssue({ code: "custom", message: "Move source and destination must differ." });
  }
  if (action.proposedRelativePath.split("/").length !== 2) {
    context.addIssue({ code: "custom", message: "Destination must contain one series folder." });
  }
});
export type PreviewAction = z.infer<typeof PreviewActionSchema>;

export const PreviewBundleSchema = z.object({
  previewVersion: z.literal(1),
  baselineDigest: Sha256Schema,
  createdAt: IsoDateSchema,
  actions: z.array(PreviewActionSchema),
}).strict().superRefine((bundle, context) => {
  const actionIds = new Set<string>();
  const sources = new Set<string>();
  const destinations = new Set<string>();
  bundle.actions.forEach((action, index) => {
    if (actionIds.has(action.actionId)) {
      context.addIssue({ code: "custom", path: ["actions", index], message: "Duplicate action ID." });
    }
    if (sources.has(action.sourceRelativePath)) {
      context.addIssue({ code: "custom", path: ["actions", index], message: "Duplicate source path." });
    }
    if (destinations.has(action.proposedRelativePath)) {
      context.addIssue({ code: "custom", path: ["actions", index], message: "Duplicate destination path." });
    }
    actionIds.add(action.actionId);
    sources.add(action.sourceRelativePath);
    destinations.add(action.proposedRelativePath);
  });
});
export type PreviewBundle = z.infer<typeof PreviewBundleSchema>;

export const JournalRecordSchema = z.object({
  journalVersion: z.literal(1),
  actionId: z.string().min(1),
  batchId: z.string().min(1),
  phase: z.enum(["started", "completed", "rolled-back"]),
  recordedAt: IsoDateSchema,
  sourceAbsolutePath: z.string().min(1),
  destinationAbsolutePath: z.string().min(1),
  fileSize: z.number().int().nonnegative(),
  modifiedAt: IsoDateSchema,
  sha256Before: Sha256Schema,
  sha256After: Sha256Schema.nullable(),
}).strict();
export type JournalRecord = z.infer<typeof JournalRecordSchema>;

