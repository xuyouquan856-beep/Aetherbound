import { describe, expect, it } from "vitest";
import {
  LibraryScanCountersSchema,
  LibraryScanJobRequestSchema,
  LibraryScanPhaseSchema,
  LibraryScanSnapshotSchema,
  LibraryScanStateSchema,
  OpaqueScanJobIdSchema,
} from "../../src/shared/contracts.js";

describe("library scan contracts", () => {
  it("accepts a valid scan snapshot", () => {
    const valid = {
      jobId: "scan-1",
      rootName: "my-library",
      state: "running",
      phase: "inventory",
      counters: {
        discovered: 10,
        supported: 8,
        cached: 2,
        queued: 6,
        processed: 8,
        skipped: 0,
        errors: 0,
        metadataTotal: 0,
        metadataProcessed: 0,
        metadataErrors: 0,
        resolutionTotal: 0,
        resolutionProcessed: 0,
        resolutionFindings: 0,
        resolutionRecycled: 0,
        agentTotal: 0,
        agentProcessed: 0,
        agentResolved: 0,
        agentPending: 0,
        seriesApplied: 0,
        seriesSkipped: 0,
      },
      startedAt: "2026-07-23T00:00:00.000Z",
      updatedAt: "2026-07-23T00:00:00.100Z",
      errorCode: null,
    };
    const parsed = LibraryScanSnapshotSchema.parse(valid);
    expect(parsed).toEqual(valid);
  });

  it("does not allow an absolute root path in a public scan snapshot", () => {
    const parsed = LibraryScanSnapshotSchema.safeParse({
      jobId: "scan-1",
      rootName: "E:\\epub",
      state: "running",
      phase: "inventory",
      counters: {
        discovered: 1,
        supported: 1,
        cached: 0,
        queued: 1,
        processed: 1,
        skipped: 0,
        errors: 0,
      },
      startedAt: "2026-07-23T00:00:00.000Z",
      updatedAt: "2026-07-23T00:00:00.100Z",
      errorCode: null,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects negative counters", () => {
    const parsed = LibraryScanCountersSchema.safeParse({
      discovered: -1,
      supported: 1,
      cached: 0,
      queued: 1,
      processed: 1,
      skipped: 0,
      errors: 0,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects unknown states and phases", () => {
    expect(LibraryScanStateSchema.safeParse("unknown_state").success).toBe(false);
    expect(LibraryScanPhaseSchema.safeParse("unknown_phase").success).toBe(false);
  });

  it("rejects scan IDs containing slash, backslash or colon", () => {
    expect(OpaqueScanJobIdSchema.safeParse("job/1").success).toBe(false);
    expect(OpaqueScanJobIdSchema.safeParse("job\\1").success).toBe(false);
    expect(OpaqueScanJobIdSchema.safeParse("job:1").success).toBe(false);
    expect(OpaqueScanJobIdSchema.safeParse("job-1").success).toBe(true);
  });

  it("validates scan job request schema", () => {
    expect(LibraryScanJobRequestSchema.safeParse({ jobId: "job-123" }).success).toBe(true);
    expect(LibraryScanJobRequestSchema.safeParse({ jobId: "job/123" }).success).toBe(false);
  });
});
