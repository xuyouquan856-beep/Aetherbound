import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { channels } from "../../src/shared/ipc.js";
import { LibraryScanSnapshotSchema } from "../../src/shared/contracts.js";

/**
 * The scan subsystem's IPC surface.
 *
 * A scan reaches the user's filesystem on their behalf, so the wiring here gets its
 * own focused tests rather than being covered incidentally by the contract tests. What
 * is asserted:
 *
 *  - every channel is registered;
 *  - every handler runs behind `assertTrustedSender`;
 *  - no handler accepts or returns a filesystem path (the root name check lives in the
 *    contracts, and this proves the handlers feed it the right thing);
 *  - progress events reach only the trusted top frame.
 */

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>(),
  trustedUrl: "reader-app://bundle/index.html",
  sent: [] as Array<{ channel: string; payload: unknown }>,
  showOpenDialog: vi.fn(),
  scanListener: null as ((snapshot: unknown) => void) | null,
  importListener: null as ((progress: unknown) => void) | null,
}));

const completedImport = {
  phase: "completed" as const,
  processed: 2,
  total: 2,
  imported: 2,
  duplicates: 0,
  failed: 0,
  fileName: null,
  collectionName: null,
  summary: "已导入 2 本。",
};

const cleanupDirs: string[] = [];
afterAll(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

vi.mock("electron", () => {
  const trusted = {
    getURL: () => electron.trustedUrl,
    send: (channel: string, payload: unknown) => electron.sent.push({ channel, payload }),
  };
  const untrusted = {
    getURL: () => "reader-rendition://epub/epub-runner.html",
    send: (channel: string, payload: unknown) => electron.sent.push({ channel, payload }),
  };
  return {
    app: { isPackaged: true, getVersion: () => "0.4.1" },
    BrowserWindow: { getAllWindows: () => [{ webContents: trusted }, { webContents: untrusted }] },
    dialog: { showOpenDialog: electron.showOpenDialog },
    ipcMain: {
      handle: (channel: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) =>
        electron.handlers.set(channel, handler),
    },
  };
});

import { registerIpc } from "../../src/main/ipc/register-ipc.js";
import { emptyOverview } from "../renderer/scan-api-stub.js";

const counters = {
  discovered: 10, supported: 10, cached: 0, queued: 10, processed: 10, skipped: 0,
  errors: 0, metadataTotal: 10, metadataProcessed: 0, metadataErrors: 0,
  resolutionTotal: 0, resolutionProcessed: 0, resolutionFindings: 0,
  resolutionRecycled: 0, agentTotal: 0, agentProcessed: 0, agentResolved: 0,
  agentPending: 0, seriesApplied: 0, seriesSkipped: 0,
};

const snapshot = {
  jobId: "scan-1",
  rootName: "我的书库",
  state: "running" as const,
  phase: "inventory" as const,
  counters,
  startedAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:01.000Z",
  errorCode: null,
};

function trustedEvent() {
  const frame = { url: electron.trustedUrl };
  return { senderFrame: frame, sender: { mainFrame: frame, send: vi.fn() } };
}

function untrustedEvent() {
  const frame = { url: "https://evil.example/" };
  return { senderFrame: frame, sender: { mainFrame: frame, send: vi.fn() } };
}

function makeServices() {
  const ensureRoot = vi.fn();
  return {
    preparations: { subscribe: vi.fn(() => () => undefined) },
    scan: {
      roots: {
        countForPath: vi.fn(() => 0),
        ensureRoot,
        getMostRecent: vi.fn(() => null),
      },
      inventory: {},
      findings: {},
      operations: {},
      jobs: {
        subscribe: vi.fn((listener: (value: unknown) => void) => {
          electron.scanListener = listener;
          return () => undefined;
        }),
        start: vi.fn(async () => snapshot),
        getActive: vi.fn(() => null),
        pause: vi.fn(() => ({ ...snapshot, state: "paused" as const })),
        resume: vi.fn(async () => snapshot),
        cancel: vi.fn(() => ({ ...snapshot, state: "cancelled" as const })),
      },
      review: {
        requireActiveRoot: vi.fn(() => ({ id: "root-1", rootPath: "E:\\books", displayName: "我的书库" })),
        overview: vi.fn(() => emptyOverview({ rootName: "我的书库" })),
        listFindings: vi.fn(() => ({ rootName: "我的书库", findings: [], total: 0, awaitingReview: 0 })),
        listFiles: vi.fn(() => ({ rootName: "我的书库", files: [], total: 0, present: 0, inLibrary: 0, missing: 0 })),
        decide: vi.fn(async () => ({
          findingId: "f1", status: "auto_applied", applied: true, summary: "done", affectedBookIds: [],
        })),
        decideBatch: vi.fn(async (_rootId: string, _rootPath: string, kind: string, decision: string) => ({
          kind, considered: 2, applied: 2, failed: 0, skipped: 0,
          summary: `${decision} done`, affectedBookIds: [],
        })),
        prepareCollection: vi.fn(async () => ({ id: "col-1", name: "某系列" })),
      },
      imports: {
        subscribe: vi.fn((listener: (value: unknown) => void) => {
          electron.importListener = listener;
          return () => undefined;
        }),
        start: vi.fn(async () => completedImport),
        active: vi.fn(() => null),
        cancel: vi.fn(() => null),
      },
    },
  };
}

function handler(channel: string) {
  const found = electron.handlers.get(channel);
  if (!found) throw new Error(`channel not registered: ${channel}`);
  return found;
}

beforeEach(() => {
  electron.handlers.clear();
  electron.sent.length = 0;
  electron.showOpenDialog.mockReset();
  electron.scanListener = null;
  electron.importListener = null;
});

describe("scan IPC wiring", () => {
  it("registers every scan channel", () => {
    registerIpc(makeServices() as never);
    for (const channel of [
      channels.scanChooseFolder,
      channels.scanStart,
      channels.scanActive,
      channels.scanPause,
      channels.scanResume,
      channels.scanCancel,
      channels.scanFindings,
      channels.scanDecide,
      channels.scanDecideBatch,
      channels.scanOverview,
      channels.scanFiles,
      channels.scanImport,
      channels.scanOrganize,
      channels.scanImportCancel,
      channels.scanImportActive,
    ]) {
      expect(electron.handlers.has(channel), channel).toBe(true);
    }
  });

  it("refuses every scan channel from an untrusted sender", async () => {
    const services = makeServices();
    registerIpc(services as never);
    const event = untrustedEvent();

    for (const channel of [
      channels.scanChooseFolder,
      channels.scanStart,
      channels.scanActive,
      channels.scanPause,
      channels.scanResume,
      channels.scanCancel,
      channels.scanFindings,
      channels.scanDecide,
      channels.scanDecideBatch,
      channels.scanOverview,
      channels.scanFiles,
      channels.scanImport,
      channels.scanOrganize,
      channels.scanImportCancel,
      channels.scanImportActive,
    ]) {
      await expect(handler(channel)(event, { jobId: "scan-1" }), channel).rejects.toThrow();
    }

    // Nothing reached the backend on behalf of the untrusted caller.
    expect(services.scan.jobs.start).not.toHaveBeenCalled();
    expect(services.scan.review.decide).not.toHaveBeenCalled();
    expect(electron.showOpenDialog).not.toHaveBeenCalled();
  });

  it("never returns a filesystem path from the folder picker", async () => {
    // The picker canonicalizes what the dialog returned, so the fixture has to be a
    // real directory — which is also what makes the assertion below meaningful.
    const parent = await mkdtemp(join(tmpdir(), "scan-picker-"));
    cleanupDirs.push(parent);
    const chosen = join(parent, "书籍");
    await mkdir(chosen);
    electron.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [chosen] });
    registerIpc(makeServices() as never);

    const result = await handler(channels.scanChooseFolder)(trustedEvent(), undefined);

    expect(electron.showOpenDialog).toHaveBeenCalledWith(
      expect.objectContaining({ properties: ["openDirectory"] }),
    );
    expect(result).toEqual({ status: "selected", displayName: "书籍", alreadyAuthorized: false });
    // The location stays in the main process: only the folder's name crosses over.
    expect(JSON.stringify(result)).not.toContain(parent.replace(/\\/gu, "\\\\"));
    expect(JSON.stringify(result)).not.toContain("scan-picker-");
  });

  it("reports a previously scanned folder as already authorized", async () => {
    const parent = await mkdtemp(join(tmpdir(), "scan-picker-"));
    cleanupDirs.push(parent);
    electron.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [parent] });
    const services = makeServices();
    services.scan.roots.countForPath = vi.fn(() => 1);
    registerIpc(services as never);

    const result = await handler(channels.scanChooseFolder)(trustedEvent(), undefined);

    expect(result).toMatchObject({ status: "selected", alreadyAuthorized: true });
  });

  it("returns cancelled when the picker is dismissed", async () => {
    electron.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    const services = makeServices();
    registerIpc(services as never);

    const result = await handler(channels.scanChooseFolder)(trustedEvent(), undefined);

    expect(result).toEqual({ status: "cancelled" });
    expect(services.scan.roots.ensureRoot).not.toHaveBeenCalled();
  });

  it("rejects a folder path that is not a directory", async () => {
    const parent = await mkdtemp(join(tmpdir(), "scan-picker-"));
    cleanupDirs.push(parent);
    const file = join(parent, "not-a-folder.txt");
    await writeFile(file, "x");
    electron.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [file] });
    registerIpc(makeServices() as never);

    await expect(handler(channels.scanChooseFolder)(trustedEvent(), undefined))
      .rejects.toThrow();
  });

  it("starts a scan and validates the returned snapshot", async () => {
    const services = makeServices();
    registerIpc(services as never);

    const result = await handler(channels.scanStart)(trustedEvent(), undefined);

    expect(LibraryScanSnapshotSchema.safeParse(result).success).toBe(true);
    expect(services.scan.jobs.start).toHaveBeenCalledOnce();
  });

  it("requires an opaque job id for pause, resume and cancel", async () => {
    const services = makeServices();
    registerIpc(services as never);
    const event = trustedEvent();

    for (const channel of [channels.scanPause, channels.scanResume, channels.scanCancel]) {
      for (const jobId of ["E:\\books", "a/b", "a:b", ""]) {
        await expect(handler(channel)(event, { jobId }), `${channel} ${jobId}`).rejects.toThrow();
      }
    }
    await handler(channels.scanPause)(event, { jobId: "scan-1" });
    await handler(channels.scanResume)(event, { jobId: "scan-1" });
    await handler(channels.scanCancel)(event, { jobId: "scan-1" });
    expect(services.scan.jobs.pause).toHaveBeenCalledWith("scan-1");
    expect(services.scan.jobs.resume).toHaveBeenCalledWith("scan-1");
    expect(services.scan.jobs.cancel).toHaveBeenCalledWith("scan-1");
  });

  it("validates decision payloads strictly", async () => {
    const services = makeServices();
    registerIpc(services as never);
    const event = trustedEvent();

    await expect(handler(channels.scanDecide)(event, { findingId: "f1", decision: "maybe" })).rejects.toThrow();
    await expect(handler(channels.scanDecide)(event, { findingId: "f1", decision: "accept", path: "E:\\x" })).rejects.toThrow();
    expect(services.scan.review.decide).not.toHaveBeenCalled();

    await handler(channels.scanDecide)(event, { findingId: "f1", decision: "accept" });
    expect(services.scan.review.decide).toHaveBeenCalledWith("root-1", "E:\\books", "f1", "accept");
  });

  it("validates import payloads and requires unique ids", async () => {
    const services = makeServices();
    registerIpc(services as never);
    const event = trustedEvent();

    await expect(handler(channels.scanImport)(event, { scope: "selected", inventoryIds: [] })).rejects.toThrow();
    await expect(handler(channels.scanImport)(event, { scope: "selected", inventoryIds: ["a", "a"] })).rejects.toThrow();
    await expect(handler(channels.scanImport)(event, { scope: "selected", inventoryIds: ["a"], rootPath: "E:\\x" })).rejects.toThrow();
    // A scope is required: main resolves "everything new" itself rather than trusting a
    // list the renderer assembled.
    await expect(handler(channels.scanImport)(event, { inventoryIds: ["a"] })).rejects.toThrow();
    expect(services.scan.imports.start).not.toHaveBeenCalled();

    await handler(channels.scanImport)(event, { scope: "all-unimported" });
    expect(services.scan.imports.start).toHaveBeenCalledWith({ inventoryIds: null });

    await handler(channels.scanImport)(event, { scope: "selected", inventoryIds: ["a", "b"] });
    expect(services.scan.imports.start).toHaveBeenLastCalledWith({ inventoryIds: ["a", "b"] });
  });

  it("resolves the collection before starting an organize run", async () => {
    const services = makeServices();
    registerIpc(services as never);
    const event = trustedEvent();

    await expect(handler(channels.scanOrganize)(event, { inventoryIds: ["a"] })).rejects.toThrow();
    await expect(handler(channels.scanOrganize)(event, {
      inventoryIds: ["a"], collectionId: "c", newCollectionName: "x",
    })).rejects.toThrow();
    expect(services.scan.imports.start).not.toHaveBeenCalled();

    await handler(channels.scanOrganize)(event, {
      inventoryIds: ["a", "b"],
      newCollectionName: "某系列",
    });

    expect(services.scan.review.prepareCollection).toHaveBeenCalledWith("某系列", undefined);
    expect(services.scan.imports.start).toHaveBeenCalledWith({
      inventoryIds: ["a", "b"],
      collection: { id: "col-1", name: "某系列" },
    });
  });

  it("validates a batch decision against the finding kinds it knows", async () => {
    const services = makeServices();
    registerIpc(services as never);
    const event = trustedEvent();

    await expect(handler(channels.scanDecideBatch)(event, { kind: "guessing", decision: "accept" })).rejects.toThrow();
    await expect(handler(channels.scanDecideBatch)(event, { kind: "exact_duplicate", decision: "maybe" })).rejects.toThrow();
    expect(services.scan.review.decideBatch).not.toHaveBeenCalled();

    await handler(channels.scanDecideBatch)(event, { kind: "exact_duplicate", decision: "accept" });
    expect(services.scan.review.decideBatch).toHaveBeenCalledWith("root-1", "E:\\books", "exact_duplicate", "accept");
  });

  it("broadcasts progress only to the trusted top frame", () => {
    registerIpc(makeServices() as never);

    electron.scanListener?.(snapshot);

    expect(electron.sent).toEqual([{ channel: channels.scanProgress, payload: snapshot }]);
  });

  it("broadcasts import progress only to the trusted top frame", () => {
    registerIpc(makeServices() as never);

    electron.importListener?.(completedImport);

    expect(electron.sent).toEqual([{ channel: channels.scanImportProgress, payload: completedImport }]);
  });

  it("drops a malformed progress snapshot rather than forwarding it", () => {
    registerIpc(makeServices() as never);

    electron.scanListener?.({ ...snapshot, rootName: "E:\\private\\books" });
    electron.importListener?.({ ...completedImport, fileName: "E:\\private\\books\\a.epub" });

    expect(electron.sent).toEqual([]);
  });
});

describe("library scan contracts", () => {
  it("accepts a well-formed scan snapshot", () => {
    expect(LibraryScanSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it("rejects a root name that is really a path", () => {
    // The renderer must never be handed a real filesystem path.
    for (const rootName of ["E:\\private\\books", "/home/user/books", "\\\\server\\share"]) {
      expect(() => LibraryScanSnapshotSchema.parse({ ...snapshot, rootName })).toThrow();
    }
  });

  it("rejects an unknown scan phase or state", () => {
    expect(() => LibraryScanSnapshotSchema.parse({ ...snapshot, phase: "guessing" })).toThrow();
    expect(() => LibraryScanSnapshotSchema.parse({ ...snapshot, state: "pondering" })).toThrow();
  });
});
