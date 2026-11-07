// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ScanPage } from "../../src/renderer/src/features/scan/ScanPage.js";
import { emptyOverview } from "./scan-api-stub.js";
import type {
  LibraryScanSnapshot,
  ReaderApi,
  ScanFindingDetail,
  ScanImportProgress,
} from "../../src/shared/contracts.js";

type ScanApi = ReaderApi["scan"];

afterEach(() => cleanup());

function snapshot(overrides: Partial<LibraryScanSnapshot> = {}): LibraryScanSnapshot {
  return {
    jobId: "scan-1",
    rootName: "我的书库",
    state: "running",
    phase: "metadata",
    counters: {
      discovered: 120, supported: 120, cached: 0, queued: 120, processed: 120, skipped: 0,
      errors: 2, metadataTotal: 120, metadataProcessed: 60, metadataErrors: 1,
      resolutionTotal: 0, resolutionProcessed: 0, resolutionFindings: 0,
      resolutionRecycled: 0, agentTotal: 0, agentProcessed: 0, agentResolved: 0,
      agentPending: 0, seriesApplied: 0, seriesSkipped: 0,
    },
    startedAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:01.000Z",
    errorCode: null,
    ...overrides,
  };
}

function duplicateFinding(overrides: Partial<ScanFindingDetail> = {}): ScanFindingDetail {
  return {
    id: "finding-1",
    kind: "exact_duplicate",
    status: "new",
    summary: "内容完全相同的 2 个文件（18.0 MB）",
    candidateCount: 2,
    confidence: 1,
    createdAt: "2026-08-01T00:00:00.000Z",
    resolvedAt: null,
    evidence: {
      kind: "exact_duplicate",
      evidenceVersion: 1,
      algorithm: "sha256",
      fullContentHash: "a".repeat(64),
      survivorInventoryId: "inv-keep",
      volumeConflict: false,
      ruleCodes: ["exact_hash_match"],
    },
    candidates: [
      {
        inventoryId: "inv-keep", relativePath: "书/keep.txt", format: "txt",
        fileSize: 9 * 1024 * 1024, modifiedAt: "2026-08-01T00:00:00.000Z",
        title: "keep", author: null, bookId: "book-1",
      },
      {
        inventoryId: "inv-dup", relativePath: "书/dup.txt", format: "txt",
        fileSize: 9 * 1024 * 1024, modifiedAt: "2026-08-01T00:00:00.000Z",
        title: "dup", author: null, bookId: null,
      },
    ],
    proposedAction: {
      kind: "recycle_duplicates",
      survivorInventoryId: "inv-keep",
      victimInventoryIds: ["inv-dup"],
      reclaimableBytes: 9 * 1024 * 1024,
    },
    ...overrides,
  };
}

function seriesFinding(ready: boolean): ScanFindingDetail {
  const bookId = ready ? "book-v1" : null;
  return {
    id: "finding-2",
    kind: "series_volume",
    status: "needs_review",
    summary: "疑似系列「某系列」，共 2 个文件",
    candidateCount: 2,
    confidence: 0.85,
    createdAt: "2026-08-01T00:00:00.000Z",
    resolvedAt: null,
    evidence: {
      kind: "series_volume",
      evidenceVersion: 1,
      normalizedSeries: "某系列",
      volumeLabel: "第1卷、第2卷",
      volumeIndex: null,
      ruleCodes: ["series_pattern_match"],
    },
    candidates: [
      {
        inventoryId: "inv-v1", relativePath: "某系列 第1卷.txt", format: "txt",
        fileSize: 1024, modifiedAt: "2026-08-01T00:00:00.000Z",
        title: "某系列 第1卷", author: null, bookId,
      },
      {
        inventoryId: "inv-v2", relativePath: "某系列 第2卷.txt", format: "txt",
        fileSize: 1024, modifiedAt: "2026-08-01T00:00:00.000Z",
        title: "某系列 第2卷", author: null, bookId: ready ? "book-v2" : null,
      },
    ],
    proposedAction: ready
      ? { kind: "create_collection", name: "某系列", bookIds: ["book-v1", "book-v2"] }
      : { kind: "none", reason: "nothing_imported" },
  };
}

function incomingFile(id: string, title: string, bookId: string | null = null) {
  return {
    inventoryId: id,
    relativePath: `${title}.txt`,
    format: "txt" as const,
    fileSize: 2048,
    modifiedAt: "2026-08-01T00:00:00.000Z",
    title,
    author: null,
    bookId,
  };
}

function makeApi(overrides: Partial<ScanApi> = {}) {
  let progressListener: ((value: LibraryScanSnapshot) => void) | null = null;
  let importListener: ((value: ScanImportProgress) => void) | null = null;
  const api: ScanApi = {
    chooseFolder: vi.fn(async () => ({ status: "selected" as const, displayName: "我的书库", alreadyAuthorized: false })),
    start: vi.fn(async () => snapshot()),
    active: vi.fn(async () => null),
    pause: vi.fn(async () => snapshot({ state: "paused" })),
    resume: vi.fn(async () => snapshot()),
    cancel: vi.fn(async () => snapshot({ state: "cancelled" })),
    overview: vi.fn(async () => emptyOverview({ present: 4, inLibrary: 1, unimported: 3, scannedAt: "2026-08-01T00:00:00.000Z" })),
    findings: vi.fn(async () => ({ rootName: "我的书库", findings: [], total: 0, awaitingReview: 0 })),
    decide: vi.fn(async (request) => ({
      findingId: request.findingId,
      status: request.decision === "accept" ? ("auto_applied" as const) : ("rejected" as const),
      applied: request.decision === "accept",
      summary: request.decision === "accept" ? "已移除 1 个重复文件。" : "已忽略。",
      affectedBookIds: [],
    })),
    decideBatch: vi.fn(async (request) => ({
      kind: request.kind,
      considered: 1,
      applied: 1,
      failed: 0,
      skipped: 0,
      summary: request.decision === "accept" ? "已处理 1 条重复文件。" : "已忽略 1 条重复文件。",
      affectedBookIds: [],
    })),
    files: vi.fn(async () => ({
      rootName: "我的书库",
      files: [incomingFile("inv-new", "新书"), incomingFile("inv-new-2", "新书二")],
      total: 2,
      present: 4,
      inLibrary: 1,
      missing: 0,
    })),
    importFiles: vi.fn(async () => ({
      phase: "completed" as const,
      processed: 3, total: 3, imported: 3, duplicates: 0, failed: 0,
      fileName: null, collectionName: null, summary: "已导入 3 本。",
    })),
    organize: vi.fn(async (request) => ({
      phase: "completed" as const,
      processed: 2, total: 2, imported: 2, duplicates: 0, failed: 0,
      fileName: null,
      collectionName: "collectionId" in request ? "已有珍藏" : request.newCollectionName,
      summary: "已导入 2 本，并归入珍藏。",
    })),
    cancelImport: vi.fn(async () => null),
    activeImport: vi.fn(async () => null),
    onProgress: vi.fn((listener) => {
      progressListener = listener;
      return () => { progressListener = null; };
    }),
    onImportProgress: vi.fn((listener) => {
      importListener = listener;
      return () => { importListener = null; };
    }),
    ...overrides,
  };
  return {
    api,
    emitProgress: (value: LibraryScanSnapshot) => progressListener?.(value),
    emitImport: (value: ScanImportProgress) => importListener?.(value),
  };
}

function renderPage(api: ScanApi, overrides: Partial<Parameters<typeof ScanPage>[0]> = {}) {
  return render(
    <ScanPage
      api={api}
      collections={[{ id: "col-1", name: "已有珍藏" }]}
      onLibraryChanged={vi.fn()}
      onCreateCollection={vi.fn(async (name: string) => ({ id: "new", name }))}
      {...overrides}
    />,
  );
}

describe("ScanPage", () => {
  it("offers the direct folder import and subfolder organization workflows", async () => {
    const { api } = makeApi();
    const onImportFolder = vi.fn();
    const onImportOrganizedFolder = vi.fn();
    renderPage(api, { onImportFolder, onImportOrganizedFolder });

    fireEvent.click(screen.getByRole("button", { name: "导入整个文件夹到珍藏" }));
    fireEvent.click(screen.getByRole("button", { name: "按子文件夹自动整理" }));
    expect(onImportFolder).toHaveBeenCalledOnce();
    expect(onImportOrganizedFolder).toHaveBeenCalledOnce();
  });
  it("asks for a folder before showing anything else", async () => {
    const { api } = makeApi({
      overview: vi.fn(async () => { throw new Error('{"code":"INVALID_REQUEST","message":"MANAGED_FOLDER_REQUIRED"}'); }),
      files: vi.fn(async () => { throw new Error('{"code":"INVALID_REQUEST","message":"MANAGED_FOLDER_REQUIRED"}'); }),
      findings: vi.fn(async () => { throw new Error('{"code":"INVALID_REQUEST","message":"MANAGED_FOLDER_REQUIRED"}'); }),
    });
    renderPage(api);

    expect(await screen.findByRole("heading", { name: "先选择一个文件夹" })).toBeInTheDocument();
    expect(screen.getByText(/不会移动或删除任何文件/u)).toBeInTheDocument();
  });

  it("opens on a summary of what the scan found, not on a raw list", async () => {
    const { api } = makeApi({
      overview: vi.fn(async () => emptyOverview({
        present: 1053, inLibrary: 273, unimported: 780,
        duplicateGroups: 12, clearableDuplicateGroups: 10, conflictedDuplicateGroups: 2,
        reclaimableBytes: 1_200_000_000, seriesGroups: 8, seriesReadyToCollect: 3, seriesPendingImport: 5,
        scannedAt: "2026-08-01T00:00:00.000Z",
      })),
    });
    renderPage(api);

    const summary = await screen.findByLabelText("扫描结果概览");
    expect(within(summary).getByText("1,053")).toBeInTheDocument();
    expect(within(summary).getByText("780")).toBeInTheDocument();
    expect(within(summary).getByText("可释放 1.1 GB")).toBeInTheDocument();
    // And the first step is one click, not a paging exercise.
    expect(screen.getByRole("button", { name: /导入全部 780 本/u })).toBeInTheDocument();
  });

  it("imports every unimported file with one click", async () => {
    const { api } = makeApi();
    renderPage(api);

    fireEvent.click(await screen.findByRole("button", { name: /导入全部 3 本/u }));

    await waitFor(() => expect(api.importFiles).toHaveBeenCalledWith({ scope: "all-unimported" }));
  });

  it("shows import progress and offers to stop it", async () => {
    const { api, emitImport } = makeApi();
    renderPage(api);
    await screen.findByLabelText("扫描结果概览");

    emitImport({
      phase: "importing", processed: 120, total: 780, imported: 118, duplicates: 1, failed: 1,
      fileName: "第120卷.epub", collectionName: null, summary: null,
    });

    const card = await screen.findByLabelText("导入进度");
    expect(within(card).getByText(/120 \/ 780/u)).toBeInTheDocument();
    expect(within(card).getByText(/第120卷\.epub/u)).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: /停止导入/u }));
    await waitFor(() => expect(api.cancelImport).toHaveBeenCalled());
  });

  it("keeps a finding's files as detail, not as the thing you read first", async () => {
    const { api } = makeApi({
      findings: vi.fn(async (request) => ({
        rootName: "我的书库",
        findings: request.kind === "exact_duplicate" ? [duplicateFinding()] : [],
        total: request.kind === "exact_duplicate" ? 1 : 0,
        awaitingReview: 1,
      })),
      overview: vi.fn(async () => emptyOverview({
        present: 4, inLibrary: 1, unimported: 0,
        duplicateGroups: 1, clearableDuplicateGroups: 1, reclaimableBytes: 9_000_000,
        scannedAt: "2026-08-01T00:00:00.000Z",
      })),
    });
    renderPage(api);

    fireEvent.click(await screen.findByRole("button", { name: /重复文件/u }));
    const title = await screen.findByText("内容相同的 2 个文件");
    expect(title).toBeInTheDocument();
    // The paths are behind the detail toggle until asked for.
    expect(screen.queryByText("书/dup.txt")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "文件" }));
    expect(await screen.findByText("书/dup.txt")).toBeInTheDocument();
  });

  it("requires a second, explicit confirmation before removing duplicates", async () => {
    const { api } = makeApi({
      findings: vi.fn(async (request) => ({
        rootName: "我的书库",
        findings: request.kind === "exact_duplicate" ? [duplicateFinding()] : [],
        total: 1,
        awaitingReview: 1,
      })),
      overview: vi.fn(async () => emptyOverview({
        present: 4, inLibrary: 1, unimported: 0,
        duplicateGroups: 1, clearableDuplicateGroups: 1, reclaimableBytes: 9_000_000,
        scannedAt: "2026-08-01T00:00:00.000Z",
      })),
    });
    renderPage(api);

    fireEvent.click(await screen.findByRole("button", { name: /重复文件/u }));
    fireEvent.click(await screen.findByRole("button", { name: "移入回收站" }));
    expect(api.decide).not.toHaveBeenCalled();

    const confirmation = await screen.findByRole("alert");
    expect(confirmation.textContent).toContain("书/keep.txt");
    fireEvent.click(within(confirmation).getByRole("button", { name: /确认移入回收站/u }));

    await waitFor(() => expect(api.decide).toHaveBeenCalledWith({ findingId: "finding-1", decision: "accept" }));
  });

  it("clears the whole duplicate queue behind one confirmation that states the stakes", async () => {
    const { api } = makeApi({
      findings: vi.fn(async (request) => ({
        rootName: "我的书库",
        findings: request.kind === "exact_duplicate" ? [duplicateFinding()] : [],
        total: 1,
        awaitingReview: 1,
      })),
      overview: vi.fn(async () => emptyOverview({
        present: 4, inLibrary: 1, unimported: 0,
        duplicateGroups: 12, clearableDuplicateGroups: 10, conflictedDuplicateGroups: 2,
        reclaimableBytes: 1_200_000_000, scannedAt: "2026-08-01T00:00:00.000Z",
      })),
    });
    renderPage(api);

    fireEvent.click(await screen.findByRole("button", { name: /重复文件/u }));
    fireEvent.click(await screen.findByRole("button", { name: /全部移入回收站（10 组）/u }));
    expect(api.decideBatch).not.toHaveBeenCalled();

    const confirmation = await screen.findByRole("alert");
    // The confirmation has to say both what will happen and what will not.
    expect(confirmation.textContent).toContain("10 组");
    expect(confirmation.textContent).toContain("1.1 GB");
    expect(confirmation.textContent).toContain("重新计算");
    expect(confirmation.textContent).toContain("2 组文件名冲突");

    fireEvent.click(within(confirmation).getByRole("button", { name: /确认清理 10 组/u }));
    await waitFor(() => expect(api.decideBatch).toHaveBeenCalledWith({
      kind: "exact_duplicate",
      decision: "accept",
    }));
  });

  it("turns a series with nothing imported into a way forward, not a dead end", async () => {
    const { api } = makeApi({
      findings: vi.fn(async (request) => ({
        rootName: "我的书库",
        findings: request.kind === "series_volume" ? [seriesFinding(false)] : [],
        total: 1,
        awaitingReview: 1,
      })),
      overview: vi.fn(async () => emptyOverview({
        present: 4, inLibrary: 0, unimported: 4, seriesGroups: 1, seriesPendingImport: 1,
        scannedAt: "2026-08-01T00:00:00.000Z",
      })),
    });
    renderPage(api);

    fireEvent.click(await screen.findByRole("button", { name: /疑似系列/u }));

    // The old version only explained the problem. Now the finding can be acted on.
    const importFirst = await screen.findByRole("button", { name: /先导入这 2 个文件/u });
    fireEvent.click(importFirst);
    await waitFor(() => expect(api.importFiles).toHaveBeenCalledWith({
      scope: "selected",
      inventoryIds: ["inv-v1", "inv-v2"],
    }));
  });

  it("imports and files into a collection in one action", async () => {
    const { api } = makeApi({
      findings: vi.fn(async (request) => ({
        rootName: "我的书库",
        findings: request.kind === "series_volume" ? [seriesFinding(false)] : [],
        total: 1,
        awaitingReview: 1,
      })),
      overview: vi.fn(async () => emptyOverview({
        present: 4, inLibrary: 0, unimported: 4, seriesGroups: 1, seriesPendingImport: 1,
        scannedAt: "2026-08-01T00:00:00.000Z",
      })),
    });
    renderPage(api);

    fireEvent.click(await screen.findByRole("button", { name: /疑似系列/u }));
    fireEvent.click(await screen.findByRole("button", { name: /导入并归入珍藏…/u }));

    const dialog = await screen.findByRole("dialog", { name: "导入并归入珍藏" });
    // The series name is prefilled, so the common case is one more click.
    expect(within(dialog).getByLabelText("新建珍藏")).toHaveValue("某系列");
    fireEvent.change(within(dialog).getByLabelText("新建珍藏"), { target: { value: "" } });
    expect(within(dialog).getByLabelText("新建珍藏")).toHaveValue("");
    fireEvent.change(within(dialog).getByLabelText("新建珍藏"), { target: { value: "某系列" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "导入并归入" }));

    await waitFor(() => expect(api.organize).toHaveBeenCalledWith({
      inventoryIds: ["inv-v1", "inv-v2"],
      newCollectionName: "某系列",
    }));
  });

  it("can file into an existing collection without typing a name", async () => {
    const { api } = makeApi();
    renderPage(api);

    fireEvent.click(await screen.findByRole("checkbox", { name: /选择 新书\.txt$/u }));
    fireEvent.click(screen.getByRole("button", { name: /导入并归入珍藏…/u }));

    const dialog = await screen.findByRole("dialog", { name: "导入并归入珍藏" });
    fireEvent.click(within(dialog).getByRole("button", { name: "导入到已有珍藏" }));

    await waitFor(() => expect(api.organize).toHaveBeenCalledWith({
      inventoryIds: ["inv-new"],
      collectionId: "col-1",
    }));
  });

  it("can find and choose a collection beyond the first twelve", async () => {
    const { api } = makeApi();
    const collections = Array.from({ length: 14 }, (_, index) => ({
      id: `col-${index + 1}`,
      name: index === 13 ? "目标系列" : `其他珍藏 ${index + 1}`,
    }));
    renderPage(api, { collections });

    fireEvent.click(await screen.findByRole("checkbox", { name: /选择 新书\.txt$/u }));
    fireEvent.click(screen.getByRole("button", { name: /导入并归入珍藏…/u }));
    const dialog = await screen.findByRole("dialog", { name: "导入并归入珍藏" });
    fireEvent.change(within(dialog).getByRole("searchbox", { name: "搜索已有珍藏" }), {
      target: { value: "目标系列" },
    });
    expect(within(dialog).getByRole("option", { name: "目标系列" })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "导入到已有珍藏" }));

    await waitFor(() => expect(api.organize).toHaveBeenCalledWith({
      inventoryIds: ["inv-new"],
      collectionId: "col-14",
    }));
  });

  it("keeps the filing dialog open when an import fails so the target can be corrected", async () => {
    const { api } = makeApi({ organize: vi.fn(async () => { throw new Error("写入失败"); }) });
    renderPage(api);
    fireEvent.click(await screen.findByRole("checkbox", { name: /选择 新书\.txt$/u }));
    fireEvent.click(screen.getByRole("button", { name: /导入并归入珍藏…/u }));
    const dialog = await screen.findByRole("dialog", { name: "导入并归入珍藏" });
    fireEvent.click(within(dialog).getByRole("button", { name: "导入到已有珍藏" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("写入失败");
    expect(dialog).toBeInTheDocument();
  });

  it("labels a file row by its file name, not by a guessed title", async () => {
    // A TXT's extracted "title" is often just its first line, so a list of files to pick
    // from has to lead with the name the user recognizes.
    const { api } = makeApi({
      files: vi.fn(async () => ({
        rootName: "我的书库",
        files: [{
          inventoryId: "inv-1",
          relativePath: "轻小说/作品 1.txt",
          format: "txt" as const,
          fileSize: 2048,
          modifiedAt: "2026-08-01T00:00:00.000Z",
          title: "第 1 本的正文",
          author: null,
          bookId: null,
        }],
        total: 1, present: 1, inLibrary: 0, missing: 0,
      })),
    });
    renderPage(api);

    expect(await screen.findByText("作品 1.txt")).toBeInTheDocument();
    expect(screen.getByText("轻小说")).toBeInTheDocument();
    expect(screen.queryByText("第 1 本的正文")).not.toBeInTheDocument();
  });

  it("can show the files already in the library when asked", async () => {
    const { api } = makeApi();
    renderPage(api);

    // The default view is the import queue, which by definition hides them.
    expect(await screen.findByRole("checkbox", { name: "本页全选" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "显示已在书库的文件" }));

    await waitFor(() => expect(api.files).toHaveBeenLastCalledWith(
      expect.objectContaining({ onlyUnimported: false }),
    ));
  });

  it("selects a whole page at once instead of one row at a time", async () => {
    const { api } = makeApi();
    renderPage(api);

    fireEvent.click(await screen.findByRole("checkbox", { name: "本页全选" }));
    expect(await screen.findByRole("button", { name: /导入所选（2）/u })).toBeInTheDocument();
    expect(screen.getByText(/已选 2/u)).toBeInTheDocument();
  });

  it("cannot select a file the library already has", async () => {
    const { api } = makeApi({
      files: vi.fn(async () => ({
        rootName: "我的书库",
        files: [incomingFile("inv-have", "已有", "book-9"), incomingFile("inv-new", "新书")],
        total: 2, present: 2, inLibrary: 1, missing: 0,
      })),
    });
    renderPage(api);

    expect(await screen.findByRole("checkbox", { name: /选择 已有/u })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /选择 新书/u })).toBeEnabled();
  });

  it("renders live scan progress and offers pause while running", async () => {
    const { api, emitProgress } = makeApi();
    renderPage(api);
    await screen.findByLabelText("扫描结果概览");

    emitProgress(snapshot());
    expect(await screen.findByText("进行中")).toBeInTheDocument();
    expect(screen.getByText("正在读取书名与作者")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /暂停/u }));
    await waitFor(() => expect(api.pause).toHaveBeenCalledWith("scan-1"));
  });

  it("offers to continue, not restart, an interrupted scan", async () => {
    const recovered = snapshot({ state: "recoverable" });
    const { api, emitProgress } = makeApi({ active: vi.fn(async () => recovered) });
    renderPage(api);
    await screen.findByLabelText("扫描结果概览");

    emitProgress(recovered);
    const resume = await screen.findByRole("button", { name: /继续未完成的扫描/u });
    expect(screen.queryByRole("button", { name: /重新扫描/u })).not.toBeInTheDocument();

    fireEvent.click(resume);
    await waitFor(() => expect(api.resume).toHaveBeenCalledWith("scan-1"));
  });

  it("says the folder is done when there is nothing left to do", async () => {
    const { api } = makeApi({
      overview: vi.fn(async () => emptyOverview({
        present: 281, inLibrary: 281, unimported: 0, scannedAt: "2026-08-01T00:00:00.000Z",
      })),
    });
    renderPage(api);

    expect(await screen.findByText("这个文件夹已经整理完了")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /导入全部/u })).not.toBeInTheDocument();
  });

  it("surfaces a backend failure instead of pretending it worked", async () => {
    const { api } = makeApi({
      overview: vi.fn(async () => emptyOverview({
        present: 4, inLibrary: 1, unimported: 0,
        duplicateGroups: 1, clearableDuplicateGroups: 1, reclaimableBytes: 100,
        scannedAt: "2026-08-01T00:00:00.000Z",
      })),
      findings: vi.fn(async (request) => ({
        rootName: "我的书库",
        findings: request.kind === "exact_duplicate" ? [duplicateFinding()] : [],
        total: 1,
        awaitingReview: 1,
      })),
      decide: vi.fn(async () => { throw new Error("文件在扫描后发生了变化"); }),
    });
    renderPage(api);

    fireEvent.click(await screen.findByRole("button", { name: /重复文件/u }));
    fireEvent.click(await screen.findByRole("button", { name: "忽略" }));

    expect(await screen.findByText(/文件在扫描后发生了变化/u)).toBeInTheDocument();
  });
});
