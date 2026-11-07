import { z } from "zod";
import {
  EpubReadingLocationSchema,
  KeyBindingSchema,
  MAX_RENDERABLE_EPUB_BYTES,
  ReadingAppearanceSchema,
} from "../../../shared/contracts.js";

export const EPUB_RUNNER_ORIGIN = "reader-rendition://epub";
export const EPUB_RUNNER_VERSION = 1 as const;

export const EpubRunnerIdentitySchema = z.object({
  version: z.literal(EPUB_RUNNER_VERSION),
  bookId: z.string().regex(/^[A-Za-z0-9-]{1,128}$/),
  sourceRevision: z.string().regex(/^[A-Za-z0-9-]{1,128}$/),
  nonce: z.string().min(1).max(256),
}).strict();
export type EpubRunnerIdentity = z.infer<typeof EpubRunnerIdentitySchema>;

const IdentityFields = {
  version: z.literal(EPUB_RUNNER_VERSION),
  bookId: z.string().regex(/^[A-Za-z0-9-]{1,128}$/),
  sourceRevision: z.string().regex(/^[A-Za-z0-9-]{1,128}$/),
  nonce: z.string().min(1).max(256),
} as const;

const EpubBytesSchema = z.instanceof(ArrayBuffer)
  .refine((value) => value.byteLength > 0)
  .refine((value) => value.byteLength <= MAX_RENDERABLE_EPUB_BYTES);

const ReaderRectSchema = z.object({
  x: z.number().finite(), y: z.number().finite(),
  width: z.number().finite().nonnegative(), height: z.number().finite().nonnegative(),
}).strict();
const EpubSelectionSchema = z.object({
  text: z.string().min(1).max(100_000),
  location: EpubReadingLocationSchema,
  endLocation: EpubReadingLocationSchema.optional(),
  rect: ReaderRectSchema,
}).strict();
const EpubMarkSchema = z.object({
  id: z.string().min(1).max(128), location: EpubReadingLocationSchema,
  endLocation: EpubReadingLocationSchema.optional(),
  color: z.enum(["cyan", "yellow", "pink"]),
}).strict();
const EpubSearchResultSchema = z.object({
  id: z.string().min(1).max(128), text: z.string().max(512),
  location: EpubReadingLocationSchema,
  endLocation: EpubReadingLocationSchema.optional(),
}).strict();

export const EpubRunnerCommandSchema = z.discriminatedUnion("command", [
  z.object({
    channel: z.literal("reader-epub-command"),
    ...IdentityFields,
    command: z.literal("open"),
    bytes: EpubBytesSchema,
    appearance: ReadingAppearanceSchema,
    restoreLocation: EpubReadingLocationSchema.nullable(),
    spine: z.array(z.object({
      index: z.number().int().nonnegative(),
      href: z.string().min(1),
      linear: z.boolean(),
    }).strict()),
  }).strict(),
  z.object({ channel: z.literal("reader-epub-command"), ...IdentityFields, command: z.literal("navigate"), href: z.string().min(1).max(2048) }).strict(),
  z.object({ channel: z.literal("reader-epub-command"), ...IdentityFields, command: z.literal("next") }).strict(),
  z.object({ channel: z.literal("reader-epub-command"), ...IdentityFields, command: z.literal("previous") }).strict(),
  z.object({ channel: z.literal("reader-epub-command"), ...IdentityFields, command: z.literal("applyLayout"), appearance: ReadingAppearanceSchema, transactionId: z.number().int().positive() }).strict(),
  z.object({ channel: z.literal("reader-epub-command"), ...IdentityFields, command: z.literal("historyBack") }).strict(),
  z.object({ channel: z.literal("reader-epub-command"), ...IdentityFields, command: z.literal("historyForward") }).strict(),
  z.object({ channel: z.literal("reader-epub-command"), ...IdentityFields, command: z.literal("navigateLocation"), location: EpubReadingLocationSchema }).strict(),
  z.object({ channel: z.literal("reader-epub-command"), ...IdentityFields, command: z.literal("clearSelection") }).strict(),
  z.object({ channel: z.literal("reader-epub-command"), ...IdentityFields, command: z.literal("search"), query: z.string().min(1).max(500), requestId: z.number().int().positive() }).strict(),
  z.object({ channel: z.literal("reader-epub-command"), ...IdentityFields, command: z.literal("setMarks"), marks: z.array(EpubMarkSchema).max(2000) }).strict(),
  z.object({ channel: z.literal("reader-epub-command"), ...IdentityFields, command: z.literal("dispose") }).strict(),
]);
export type EpubRunnerCommand = z.infer<typeof EpubRunnerCommandSchema>;
type StripEnvelope<T> = T extends unknown ? Omit<T, "channel" | keyof EpubRunnerIdentity> : never;
export type EpubRunnerCommandPayload = StripEnvelope<EpubRunnerCommand>;

export const EpubRunnerPhaseSchema = z.enum([
  "publication-opened",
  "restore-complete",
  "stable-paint",
]);
export type EpubRunnerPhase = z.infer<typeof EpubRunnerPhaseSchema>;

export const EpubRunnerEventSchema = z.discriminatedUnion("event", [
  z.object({ channel: z.literal("reader-epub-event"), ...IdentityFields, event: z.literal("ready") }).strict(),
  z.object({ channel: z.literal("reader-epub-event"), ...IdentityFields, event: z.literal("phase"), phase: EpubRunnerPhaseSchema }).strict(),
  z.object({ channel: z.literal("reader-epub-event"), ...IdentityFields, event: z.literal("relocated"), location: EpubReadingLocationSchema }).strict(),
  z.object({ channel: z.literal("reader-epub-event"), ...IdentityFields, event: z.literal("layout-started"), transactionId: z.number().int().positive() }).strict(),
  z.object({ channel: z.literal("reader-epub-event"), ...IdentityFields, event: z.literal("layout-settled"), transactionId: z.number().int().positive(), location: EpubReadingLocationSchema }).strict(),
  z.object({ channel: z.literal("reader-epub-event"), ...IdentityFields, event: z.literal("history-state"), canGoBack: z.boolean(), canGoForward: z.boolean() }).strict(),
  z.object({ channel: z.literal("reader-epub-event"), ...IdentityFields, event: z.literal("keystroke"), binding: KeyBindingSchema }).strict(),
  z.object({ channel: z.literal("reader-epub-event"), ...IdentityFields, event: z.literal("selection"), selection: EpubSelectionSchema.nullable() }).strict(),
  z.object({ channel: z.literal("reader-epub-event"), ...IdentityFields, event: z.literal("content-click") }).strict(),
  z.object({ channel: z.literal("reader-epub-event"), ...IdentityFields, event: z.literal("mark-click"), id: z.string().min(1).max(128) }).strict(),
  z.object({ channel: z.literal("reader-epub-event"), ...IdentityFields, event: z.literal("search-results"), requestId: z.number().int().positive(), results: z.array(EpubSearchResultSchema).max(2000) }).strict(),
  z.object({ channel: z.literal("reader-epub-event"), ...IdentityFields, event: z.literal("error"), code: z.enum(["INVALID_PACKAGE", "RESOURCE_BLOCKED", "SOURCE_CHANGED"]), message: z.string().max(240) }).strict(),
]);
export type EpubRunnerEvent = z.infer<typeof EpubRunnerEventSchema>;
export type EpubRunnerEventPayload = StripEnvelope<EpubRunnerEvent>;

function sameIdentity(value: EpubRunnerIdentity, expected: EpubRunnerIdentity) {
  return value.version === expected.version && value.bookId === expected.bookId
    && value.sourceRevision === expected.sourceRevision && value.nonce === expected.nonce;
}

export function parseEpubRunnerCommand(value: unknown, expected: EpubRunnerIdentity) {
  const parsed = EpubRunnerCommandSchema.safeParse(value);
  return parsed.success && sameIdentity(parsed.data, expected) ? parsed.data : null;
}

export function parseEpubRunnerEvent(value: unknown, expected: EpubRunnerIdentity) {
  const parsed = EpubRunnerEventSchema.safeParse(value);
  return parsed.success && sameIdentity(parsed.data, expected) ? parsed.data : null;
}

export function isEpubRunnerEvent(value: unknown, expected: EpubRunnerIdentity) {
  return parseEpubRunnerEvent(value, expected) !== null;
}
