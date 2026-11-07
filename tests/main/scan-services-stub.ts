import { vi } from "vitest";

/**
 * A `services.scan` stand-in for IPC tests that are not about scanning.
 *
 * `registerIpc` subscribes to the scan job snapshots on startup so progress can be
 * broadcast to the renderer. Tests that build a partial services object to exercise a
 * different channel therefore still need this shape to exist. It is intentionally inert
 * — nothing here reaches a filesystem — so a test that accidentally triggers a scan
 * observes nothing rather than failing somewhere unrelated.
 */
export function createScanServicesStub() {
  return {
    roots: {
      getMostRecent: vi.fn(() => null),
      getById: vi.fn(() => null),
      getByPath: vi.fn(() => null),
      listEnabled: vi.fn(() => []),
      countForPath: vi.fn(() => 0),
      ensureRoot: vi.fn(),
    },
    inventory: {},
    findings: {},
    operations: {},
    jobs: {
      subscribe: vi.fn(() => () => undefined),
      start: vi.fn(),
      getActive: vi.fn(() => null),
      pause: vi.fn(),
      resume: vi.fn(),
      cancel: vi.fn(),
      recoverInterruptedJobs: vi.fn(() => 0),
    },
    imports: {
      subscribe: vi.fn(() => () => undefined),
      start: vi.fn(),
      active: vi.fn(() => null),
      cancel: vi.fn(() => null),
      isRunning: vi.fn(() => false),
    },
    review: {
      requireActiveRoot: vi.fn(() => {
        throw new Error("No scan root is configured in this test");
      }),
      getActiveRoot: vi.fn(() => null),
      overview: vi.fn(),
      listFindings: vi.fn(),
      listFiles: vi.fn(),
      decide: vi.fn(),
      decideBatch: vi.fn(),
      prepareCollection: vi.fn(),
      listCollections: vi.fn(),
      resolveImportFiles: vi.fn(),
      addBooksToCollection: vi.fn(),
    },
  };
}