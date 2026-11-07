import { vi } from "vitest";
import type { ReaderApi, ScanImportProgress, ScanOverview } from "../../src/shared/contracts.js";

/**
 * An inert `ReaderApi.scan` for renderer tests that are not about scanning.
 *
 * Declared once so adding a scan method does not mean editing every renderer test
 * that happens to build a full API mock. The stubs are deliberately empty rather than
 * throwing: a test that accidentally triggers a scan should see nothing happen, not
 * fail inside an unrelated assertion.
 */
export function createScanApiStub(): ReaderApi["scan"] {
  const idleImport: ScanImportProgress = {
    phase: "completed",
    processed: 0,
    total: 0,
    imported: 0,
    duplicates: 0,
    failed: 0,
    fileName: null,
    collectionName: null,
    summary: "没有需要导入的文件。",
  };
  return {
    chooseFolder: vi.fn(async () => ({ status: "cancelled" as const })),
    start: vi.fn(async () => {
      throw new Error("scan.start is not stubbed in this test");
    }),
    active: vi.fn(async () => null),
    pause: vi.fn(async () => {
      throw new Error("scan.pause is not stubbed in this test");
    }),
    resume: vi.fn(async () => {
      throw new Error("scan.resume is not stubbed in this test");
    }),
    cancel: vi.fn(async () => {
      throw new Error("scan.cancel is not stubbed in this test");
    }),
    overview: vi.fn(async () => emptyOverview()),
    findings: vi.fn(async () => ({ rootName: null, findings: [], total: 0, awaitingReview: 0 })),
    decide: vi.fn(async () => {
      throw new Error("scan.decide is not stubbed in this test");
    }),
    decideBatch: vi.fn(async () => ({
      kind: "exact_duplicate" as const,
      considered: 0,
      applied: 0,
      failed: 0,
      skipped: 0,
      summary: "没有待处理的条目。",
      affectedBookIds: [],
    })),
    files: vi.fn(async () => ({ rootName: null, files: [], total: 0, present: 0, inLibrary: 0, missing: 0 })),
    importFiles: vi.fn(async () => idleImport),
    organize: vi.fn(async () => idleImport),
    cancelImport: vi.fn(async () => null),
    activeImport: vi.fn(async () => null),
    onProgress: vi.fn(() => () => undefined),
    onImportProgress: vi.fn(() => () => undefined),
  };
}

/** An overview for a folder that has been chosen but not scanned. */
export function emptyOverview(overrides: Partial<ScanOverview> = {}): ScanOverview {
  return {
    rootName: "我的书库",
    present: 0,
    inLibrary: 0,
    unimported: 0,
    missing: 0,
    duplicateGroups: 0,
    clearableDuplicateGroups: 0,
    reclaimableBytes: 0,
    conflictedDuplicateGroups: 0,
    seriesGroups: 0,
    seriesReadyToCollect: 0,
    seriesPendingImport: 0,
    scannedAt: null,
    ...overrides,
  };
}
