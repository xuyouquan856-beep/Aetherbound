import { z } from "zod";
import { ReadingLocationSchema } from "./contracts.js";

export const ReadingRecordKindSchema = z.enum(["bookmark", "highlight", "note", "quote"]);
export const ReadingRecordColorSchema = z.enum(["cyan", "yellow", "pink"]);

export const SaveReadingRecordSchema = z.object({
  id: z.string().uuid().optional(),
  kind: ReadingRecordKindSchema,
  bookId: z.string().min(1).max(128).nullable(),
  bookTitle: z.string().max(500),
  author: z.string().max(500).nullable(),
  text: z.string().max(100_000),
  excerpt: z.string().max(220).optional(),
  sourceUrl: z.string().max(2048).refine((value) => {
    if (!value) return true;
    try { return ["http:", "https:"].includes(new URL(value).protocol); }
    catch { return false; }
  }, "Expected an HTTP(S) URL or empty string").optional(),
  note: z.string().max(100_000),
  color: ReadingRecordColorSchema,
  location: ReadingLocationSchema.nullable(),
  endLocation: ReadingLocationSchema.nullable().optional(),
  enabled: z.boolean(),
  pinned: z.boolean(),
}).strict();
export type SaveReadingRecord = z.input<typeof SaveReadingRecordSchema>;

export const ReadingRecordSchema = SaveReadingRecordSchema.extend({
  excerpt: SaveReadingRecordSchema.shape.excerpt.unwrap().default(""),
  sourceUrl: SaveReadingRecordSchema.shape.sourceUrl.unwrap().default(""),
  id: z.string().uuid(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
}).strict();
export type ReadingRecord = z.infer<typeof ReadingRecordSchema>;

export const ListReadingRecordsSchema = z.object({
  bookId: z.string().min(1).max(128).optional(),
  kind: ReadingRecordKindSchema.optional(),
}).strict();
export type ListReadingRecords = z.infer<typeof ListReadingRecordsSchema>;
export const RemoveReadingRecordSchema = z.object({ id: z.string().uuid() }).strict();

export type ReadingRecordsApi = {
  list(filter?: ListReadingRecords): Promise<ReadingRecord[]>;
  save(input: SaveReadingRecord): Promise<ReadingRecord>;
  remove(request: { id: string }): Promise<void>;
};
