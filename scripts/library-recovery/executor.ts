import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
} from "node:fs/promises";
import { dirname, relative, sep } from "node:path";
import {
  JournalRecordSchema,
  PreviewBundleSchema,
  type JournalRecord,
} from "./contracts.js";
import { fullContentHash } from "../../src/backend/library/fingerprint.js";
import { resolveInsideRoot } from "./safe-paths.js";

export type BatchResult = { batchId: string; moved: number };
export type RollbackResult = { batchId: string; rolledBack: number };

function relativeFromRoot(root: string, absolutePath: string): string {
  return relative(root, absolutePath).split(sep).join("/");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function appendJournal(path: string, record: JournalRecord): Promise<void> {
  const handle = await open(path, "a");
  try {
    await handle.writeFile(`${JSON.stringify(JournalRecordSchema.parse(record))}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readJournal(path: string): Promise<JournalRecord[]> {
  try {
    const text = await readFile(path, "utf8");
    return text.split(/\r?\n/).filter(Boolean).map((line) => JournalRecordSchema.parse(JSON.parse(line)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function applyMoveBatch(input: {
  root: string;
  previewPath: string;
  expectedPreviewDigest: string;
  journalPath: string;
  limit: number;
  firstBatch: boolean;
}): Promise<BatchResult> {
  if (!Number.isInteger(input.limit) || input.limit < 1) {
    throw new Error("Batch limit must be a positive integer.");
  }
  if (input.firstBatch && input.limit > 5) {
    throw new Error("The first batch is limited to 5 files.");
  }
  if (!input.firstBatch && input.limit > 20) {
    throw new Error("Later batches are limited to 20 files.");
  }
  const previewText = await readFile(input.previewPath, "utf8");
  const digest = createHash("sha256").update(previewText).digest("hex");
  if (digest !== input.expectedPreviewDigest) {
    throw new Error("Preview digest does not match the approved digest.");
  }
  const preview = PreviewBundleSchema.parse(JSON.parse(previewText));
  const existingJournal = await readJournal(input.journalPath);
  const completedActionIds = new Set(
    existingJournal.filter((record) => record.phase === "completed").map((record) => record.actionId),
  );
  const actions = preview.actions.filter((action) => !completedActionIds.has(action.actionId)).slice(0, input.limit);
  const batchId = `batch-${new Date().toISOString()}-${randomUUID()}`;
  let moved = 0;

  for (const action of actions) {
    const source = await resolveInsideRoot(input.root, action.sourceRelativePath);
    const destination = await resolveInsideRoot(input.root, action.proposedRelativePath);
    const sourceFacts = await stat(source).catch(() => null);
    if (!sourceFacts?.isFile()) throw new Error(`Source is missing: ${action.sourceRelativePath}`);
    if (
      sourceFacts.size !== action.fileSize
      || sourceFacts.mtime.toISOString() !== action.modifiedAt
      || await fullContentHash(source) !== action.sha256
    ) {
      throw new Error(`Source changed since preview: ${action.sourceRelativePath}`);
    }
    if (await exists(destination)) {
      throw new Error(`Destination already exists: ${action.proposedRelativePath}`);
    }
    const started = JournalRecordSchema.parse({
      journalVersion: 1,
      actionId: action.actionId,
      batchId,
      phase: "started",
      recordedAt: new Date().toISOString(),
      sourceAbsolutePath: source,
      destinationAbsolutePath: destination,
      fileSize: action.fileSize,
      modifiedAt: action.modifiedAt,
      sha256Before: action.sha256,
      sha256After: null,
    });
    await appendJournal(input.journalPath, started);
    await mkdir(dirname(destination), { recursive: true });
    await rename(source, destination);
    const sha256After = await fullContentHash(destination);
    if (sha256After !== action.sha256) {
      throw new Error(`Destination hash mismatch after move: ${action.proposedRelativePath}`);
    }
    await appendJournal(input.journalPath, {
      ...started,
      phase: "completed",
      recordedAt: new Date().toISOString(),
      sha256After,
    });
    moved += 1;
  }
  return { batchId, moved };
}

export async function rollbackBatch(input: {
  root: string;
  journalPath: string;
  batchId: string;
}): Promise<RollbackResult> {
  const journal = await readJournal(input.journalPath);
  const rolledActionIds = new Set(
    journal.filter((record) => record.phase === "rolled-back").map((record) => record.actionId),
  );
  const completed = journal
    .filter((record) =>
      record.batchId === input.batchId
      && record.phase === "completed"
      && !rolledActionIds.has(record.actionId))
    .reverse();
  let rolledBack = 0;
  for (const record of completed) {
    const sourceRelative = relativeFromRoot(input.root, record.sourceAbsolutePath);
    const destinationRelative = relativeFromRoot(input.root, record.destinationAbsolutePath);
    const source = await resolveInsideRoot(input.root, sourceRelative);
    const destination = await resolveInsideRoot(input.root, destinationRelative);
    if (await exists(source)) throw new Error(`Original source path is occupied: ${sourceRelative}`);
    if (!await exists(destination) || await fullContentHash(destination) !== record.sha256Before) {
      throw new Error(`Moved content changed; rollback stopped: ${destinationRelative}`);
    }
    await rename(destination, source);
    await appendJournal(input.journalPath, {
      ...record,
      phase: "rolled-back",
      recordedAt: new Date().toISOString(),
      sha256After: record.sha256Before,
    });
    rolledBack += 1;
  }
  return { batchId: input.batchId, rolledBack };
}

export async function recoverInterruptedMoves(input: {
  root: string;
  journalPath: string;
}): Promise<{ recovered: number; untouched: number }> {
  const journal = await readJournal(input.journalPath);
  const terminalActionIds = new Set(
    journal.filter((record) => record.phase !== "started").map((record) => record.actionId),
  );
  const pending = journal.filter((record) =>
    record.phase === "started" && !terminalActionIds.has(record.actionId));
  let recovered = 0;
  let untouched = 0;
  for (const record of pending) {
    const sourceRelative = relativeFromRoot(input.root, record.sourceAbsolutePath);
    const destinationRelative = relativeFromRoot(input.root, record.destinationAbsolutePath);
    const source = await resolveInsideRoot(input.root, sourceRelative);
    const destination = await resolveInsideRoot(input.root, destinationRelative);
    const sourceExists = await exists(source);
    const destinationExists = await exists(destination);
    if (sourceExists && !destinationExists) {
      untouched += 1;
      continue;
    }
    if (!sourceExists && destinationExists) {
      const hash = await fullContentHash(destination);
      if (hash !== record.sha256Before) {
        throw new Error(`Interrupted destination changed: ${destinationRelative}`);
      }
      await appendJournal(input.journalPath, {
        ...record,
        phase: "completed",
        recordedAt: new Date().toISOString(),
        sha256After: hash,
      });
      recovered += 1;
      continue;
    }
    throw new Error(`Interrupted move has an indeterminate state: ${record.actionId}`);
  }
  return { recovered, untouched };
}
