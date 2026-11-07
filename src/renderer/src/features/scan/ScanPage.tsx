import {
  ArrowClockwise,
  ArrowRight,
  ArrowsClockwise,
  Check,
  CheckCircle,
  Copy,
  FolderOpen,
  MagnifyingGlass,
  Pause,
  Prohibit,
  Stack,
  Warning,
  X,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  LibraryScanPhase,
  LibraryScanSnapshot,
  ReaderApi,
  ScanBatchDecisionResult,
  ScanFindingCandidate,
  ScanFindingDetail,
  ScanFindingKind,
  ScanImportProgress,
  ScanOverview,
} from "../../../../shared/contracts.js";

type ScanApi = ReaderApi["scan"];

type Props = {
  api: ScanApi;
  /** Collections to file into, so organizing does not mean leaving the page. */
  collections: Array<{ id: string; name: string }>;
  /** Called after anything that could change the library, so 书房 refreshes. */
  onLibraryChanged(): void;
  onCreateCollection(name: string): Promise<{ id: string; name: string }>;
  onImportFolder?(): void;
  onImportOrganizedFolder?(): void;
  onNavigateUnorganized?(): void;
};

type TabKey = "incoming" | "duplicates" | "series" | "done";

const PHASE_LABELS: Record<LibraryScanPhase, string> = {
  inventory: "正在盘点文件夹",
  metadata: "正在读取书名与作者",
  local_resolution: "正在比对重复与系列",
  agent_resolution: "正在复核疑难条目",
  apply: "正在应用结果",
  completed: "已完成",
};

const STATE_LABELS: Record<LibraryScanSnapshot["state"], string> = {
  queued: "排队中",
  running: "进行中",
  paused: "已暂停",
  completed: "已完成",
  cancelled: "已取消",
  failed: "已失败",
  recoverable: "上次未完成",
};

const FILE_PAGE_SIZE = 100;

function isActive(snapshot: LibraryScanSnapshot | null): boolean {
  return snapshot?.state === "running" || snapshot?.state === "queued";
}

function isTerminal(snapshot: LibraryScanSnapshot | null): boolean {
  return snapshot !== null && ["completed", "cancelled", "failed"].includes(snapshot.state);
}

/**
 * Whether the existing job can be picked up rather than replaced.
 *
 * `recoverable` counts: the app was interrupted mid-scan, so the job still holds the
 * work already done. Starting a new scan would return this same job rather than run
 * anything — the button would look broken — so the UI offers to continue instead.
 */
function canContinue(snapshot: LibraryScanSnapshot | null): boolean {
  return snapshot?.state === "paused" || snapshot?.state === "recoverable";
}

/** Done/total for the current phase, or null when the phase cannot be measured. */
function progressFor(snapshot: LibraryScanSnapshot): { done: number; total: number } | null {
  const c = snapshot.counters;
  switch (snapshot.phase) {
    case "metadata":
      return c.metadataTotal > 0 ? { done: c.metadataProcessed, total: c.metadataTotal } : null;
    case "local_resolution":
      return c.resolutionTotal > 1 ? { done: c.resolutionProcessed, total: c.resolutionTotal } : null;
    case "agent_resolution":
      return c.agentTotal > 0 ? { done: c.agentProcessed, total: c.agentTotal } : null;
    case "completed":
      return { done: 1, total: 1 };
    default:
      // Inventory has no known total until the walk finishes; a fake denominator here
      // would make the bar jump backwards, so the UI shows an indeterminate state.
      return null;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

export function ScanPage({ api, collections, onLibraryChanged, onCreateCollection, onImportFolder, onImportOrganizedFolder, onNavigateUnorganized }: Props) {
  const [snapshot, setSnapshot] = useState<LibraryScanSnapshot | null>(null);
  const [overview, setOverview] = useState<ScanOverview | null>(null);
  const [tab, setTab] = useState<TabKey>("incoming");
  const [duplicates, setDuplicates] = useState<ScanFindingDetail[]>([]);
  const [series, setSeries] = useState<ScanFindingDetail[]>([]);
  const [findings, setFindings] = useState<ScanFindingDetail[]>([]);
  const [files, setFiles] = useState<ScanFindingCandidate[]>([]);
  const [filesTotal, setFilesTotal] = useState(0);
  const [onlyUnimported, setOnlyUnimported] = useState(true);
  const [filePage, setFilePage] = useState(0);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [importing, setImporting] = useState<ScanImportProgress | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [hasRoot, setHasRoot] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [filing, setFiling] = useState<{ ids: string[]; seriesName?: string } | null>(null);
  const [newCollectionName, setNewCollectionName] = useState<string | null>(null);
  const [collectionQuery, setCollectionQuery] = useState("");
  const [existingCollectionId, setExistingCollectionId] = useState("");
  const matchingCollections = useMemo(() => {
    const needle = collectionQuery.normalize("NFKC").trim().toLocaleLowerCase();
    return needle
      ? collections.filter((collection) => collection.name.normalize("NFKC").toLocaleLowerCase().includes(needle))
      : collections;
  }, [collectionQuery, collections]);
  const selectedExistingCollectionId = matchingCollections.some((collection) => collection.id === existingCollectionId)
    ? existingCollectionId
    : matchingCollections[0]?.id ?? "";

  const rootName = overview?.rootName ?? null;

  const refresh = useCallback(async (options: { page?: number; keepSelection?: boolean } = {}) => {
    const page = options.page ?? filePage;
    try {
      const [nextOverview, incoming, duplicateList, seriesList] = await Promise.all([
        api.overview(),
        api.files({ limit: FILE_PAGE_SIZE, offset: page * FILE_PAGE_SIZE, onlyUnimported }),
        api.findings({ limit: 50, offset: 0, includeResolved: false, kind: "exact_duplicate" }),
        api.findings({ limit: 50, offset: 0, includeResolved: false, kind: "series_volume" }),
      ]);
      setOverview(nextOverview);
      setFiles(incoming.files);
      setFilesTotal(incoming.total);
      setDuplicates(duplicateList.findings);
      setSeries(seriesList.findings);
      setHasRoot(true);
      setScanned(nextOverview.scannedAt !== null);
      setError(null);
      if (!options.keepSelection) setSelected(new Set());
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (/MANAGED_FOLDER_REQUIRED|未授权|No scan root/u.test(message)) {
        setHasRoot(false);
        setOverview(null);
        setFiles([]);
        setDuplicates([]);
        setSeries([]);
        setError(null);
        return;
      }
      setError(message);
    }
  }, [api, filePage, onlyUnimported]);

  useEffect(() => {
    void api.active().then((active) => { if (active) setSnapshot(active); }).catch(() => undefined);
    void api.activeImport().then((active) => { if (active) setImporting(active); }).catch(() => undefined);
  }, [api]);

  useEffect(() => {
    setFindings([...duplicates, ...series]);
  }, [duplicates, series]);

  const terminalRef = useRef<string | null>(null);
  useEffect(() => api.onProgress((next) => {
    setSnapshot(next);
    if (!isTerminal(next)) return;
    // Refresh once per terminal snapshot; the stream repeats the final state on every
    // re-render otherwise, and each refresh walks the inventory.
    const key = `${next.jobId}:${next.state}`;
    if (terminalRef.current === key) return;
    terminalRef.current = key;
    void refresh({ page: 0 });
    setFilePage(0);
  }), [api, refresh]);

  useEffect(() => api.onImportProgress((next) => {
    setImporting(next.phase === "importing" || next.phase === "filing" ? next : null);
    if (next.phase === "completed" || next.phase === "cancelled" || next.phase === "failed") {
      setNotice(next.summary);
      void refresh({ page: 0 }).then(() => onLibraryChanged());
      setFilePage(0);
    }
  }), [api, refresh, onLibraryChanged]);

  useEffect(() => {
    void refresh({ page: 0 });
    // Runs once per api instance: everything after this is driven by the progress
    // streams or by an explicit user action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  async function chooseFolder() {
    setBusy(true);
    setError(null);
    try {
      const selection = await api.chooseFolder();
      if (selection.status === "selected") await refresh({ page: 0 });
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  async function startScan() {
    setBusy(true);
    setError(null);
    setNotice(null);
    terminalRef.current = null;
    try {
      setSnapshot(await api.start());
      setTab("incoming");
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  async function control(action: "pause" | "resume" | "cancel") {
    if (!snapshot) return;
    setBusy(true);
    try {
      setSnapshot(action === "pause"
        ? await api.pause(snapshot.jobId)
        : action === "resume"
          ? await api.resume(snapshot.jobId)
          : await api.cancel(snapshot.jobId));
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  async function decide(finding: ScanFindingDetail, decision: "accept" | "reject") {
    setBusy(true);
    setError(null);
    try {
      const result = await api.decide({ findingId: finding.id, decision });
      setConfirming(null);
      setNotice(result.summary);
      await refresh({ keepSelection: true });
      onLibraryChanged();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  async function decideAll(kind: ScanFindingKind, decision: "accept" | "reject") {
    setBusy(true);
    setError(null);
    try {
      const result: ScanBatchDecisionResult = await api.decideBatch({ kind, decision });
      setNotice(result.summary);
      setConfirming(null);
      await refresh({ keepSelection: true });
      onLibraryChanged();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  async function runImport(request: { scope: "all-unimported" } | { scope: "selected"; inventoryIds: string[] }) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.importFiles(request);
      if (result.phase !== "importing") setNotice(result.summary);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  /** Import whatever is missing and file it, in one action. */
  async function organize(ids: string[], target: { collectionId?: string; newName?: string }) {
    setBusy(true);
    setError(null);
    try {
      const request = target.collectionId
        ? { inventoryIds: ids, collectionId: target.collectionId }
        : { inventoryIds: ids, newCollectionName: target.newName ?? "" };
      const result = await api.organize(request);
      setFiling(null);
      if (result.phase !== "importing" && result.phase !== "filing") setNotice(result.summary);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  function toggleSelected(inventoryId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(inventoryId)) next.delete(inventoryId);
      else next.add(inventoryId);
      return next;
    });
  }

  async function setFilter(nextOnlyUnimported: boolean) {
    setOnlyUnimported(nextOnlyUnimported);
    setFilePage(0);
    setSelected(new Set());
    // The dependency has not re-rendered yet, so the page is fetched explicitly rather
    // than through the memoised refresh.
    try {
      const list = await api.files({
        limit: FILE_PAGE_SIZE,
        offset: 0,
        onlyUnimported: nextOnlyUnimported,
      });
      setFiles(list.files);
      setFilesTotal(list.total);
    } catch (cause) {
      setError(message(cause));
    }
  }

  const unimportedOnPage = useMemo(
    () => files.filter((file) => file.bookId === null),
    [files],
  );
  const allPageSelected = unimportedOnPage.length > 0
    && unimportedOnPage.every((file) => selected.has(file.inventoryId));
  const progress = snapshot ? progressFor(snapshot) : null;
  const unimported = overview?.unimported ?? 0;
  const clearable = overview?.clearableDuplicateGroups ?? 0;
  const conflicted = overview?.conflictedDuplicateGroups ?? 0;
  const seriesReady = overview?.seriesReadyToCollect ?? 0;
  const seriesPending = overview?.seriesPendingImport ?? 0;
  const workLeft = unimported + clearable + conflicted + seriesReady + seriesPending;
  const importRunning = importing?.phase === "importing" || importing?.phase === "filing";

  function openFiling(ids: string[], seriesName?: string) {
    setError(null);
    setNewCollectionName(null);
    setCollectionQuery("");
    setExistingCollectionId("");
    setFiling({ ids, seriesName });
  }

  return (
    <main className="page scan-page">
      <header className="scan-head">
        <div>
          <div className="library-page-title"><span className="library-page-index">05</span><h1>扫描书库</h1><span className="library-page-rule" /></div>
          <p className="scan-head__sub">
            {rootName ? <>文件夹 <strong>{rootName}</strong></> : "还没有选择文件夹"}
            {overview?.scannedAt && <> · 上次扫描 {formatWhen(overview.scannedAt)}</>}
          </p>
        </div>
        <div className="scan-head__actions">
          <button className="button button--small" type="button" onClick={() => void chooseFolder()} disabled={busy || importRunning}>
            <FolderOpen size={16} />
            {hasRoot ? "更换文件夹" : "选择文件夹"}
          </button>
          {!isActive(snapshot) && !canContinue(snapshot) && (
            <button
              className="button button--small button--primary"
              type="button"
              onClick={() => void startScan()}
              disabled={busy || !hasRoot || importRunning}
            >
              <ArrowsClockwise size={16} />
              {scanned ? "重新扫描" : "开始扫描"}
            </button>
          )}
          {canContinue(snapshot) && (
            <button className="button button--small button--primary" type="button" disabled={busy} onClick={() => void control("resume")}>
              <ArrowsClockwise size={16} />
              {snapshot?.state === "recoverable" ? "继续未完成的扫描" : "继续"}
            </button>
          )}
          {canContinue(snapshot) && (
            <button className="button button--small button--danger-outline" type="button" disabled={busy} onClick={() => void control("cancel")}>
              <Prohibit size={16} />
              放弃
            </button>
          )}
          {isActive(snapshot) && (
            <>
              <button className="button button--small" type="button" disabled={busy} onClick={() => void control("pause")}>
                <Pause size={16} />
                暂停
              </button>
              <button className="button button--small button--danger-outline" type="button" disabled={busy} onClick={() => void control("cancel")}>
                <Prohibit size={16} />
                取消
              </button>
            </>
          )}
        </div>
      </header>

      {(onImportFolder || onImportOrganizedFolder) && (
        <section className="scan-quick-import" aria-label="快速导入与整理">
          <div>
            <strong>批量导入书籍</strong>
            <p>选父文件夹，按子文件夹建立或追加珍藏。再次选择同一文件夹可补入新书。</p>
          </div>
          <div className="scan-quick-import__actions">
            {onImportOrganizedFolder && <button className="button button--primary" type="button" disabled={busy || importRunning} onClick={onImportOrganizedFolder}>按子文件夹自动整理</button>}
            {onImportFolder && <button className="button" type="button" disabled={busy || importRunning} onClick={onImportFolder}>导入整个文件夹到珍藏</button>}
          </div>
        </section>
      )}

      {onNavigateUnorganized && <section className="scan-library-organize" aria-label="整理已入库书籍">
        <div><strong>整理已经入库的书</strong><p>检查系列建议、剔除误判，再归入已有或新珍藏。</p></div>
        <button className="button" type="button" onClick={onNavigateUnorganized}>去整理已入库书籍 <ArrowRight size={16} /></button>
      </section>}

      {error && <div className="notice notice--error">{error}</div>}
      {notice && (
        <div className="notice scan-notice">
          <CheckCircle size={16} />
          <span>{notice}</span>
          <button className="button button--subtle" type="button" aria-label="关闭提示" onClick={() => setNotice(null)}>
            <X size={14} />
          </button>
        </div>
      )}

      {!hasRoot && (
        <section className="scan-empty">
          <MagnifyingGlass size={28} />
          <h2>先选择一个文件夹</h2>
          <p>
            扫描只读取文件夹、列出发现的问题，不会移动或删除任何文件。
            每一项处理都需要你确认。
          </p>
          <button className="button button--primary" type="button" onClick={() => void chooseFolder()} disabled={busy}>
            <FolderOpen size={16} />
            选择文件夹
          </button>
        </section>
      )}

      {hasRoot && snapshot && !isTerminal(snapshot) && (
        <section className="scan-progress-card" data-state={snapshot.state}>
          <div className="scan-progress-card__line">
            <strong>{STATE_LABELS[snapshot.state]}</strong>
            <span>{PHASE_LABELS[snapshot.phase]}</span>
            <span className="scan-progress-card__counters">
              发现 {snapshot.counters.discovered} · 已读信息 {snapshot.counters.metadataProcessed}
              {snapshot.counters.errors > 0 ? ` · 失败 ${snapshot.counters.errors}` : ""}
            </span>
          </div>
          <div
            className={`scan-progress__bar ${progress ? "" : "scan-progress__bar--indeterminate"}`}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress ? percent(progress) : undefined}
          >
            <div className="scan-progress__fill" style={progress ? { width: `${percent(progress)}%` } : undefined} />
          </div>
          {snapshot.errorCode && <span className="scan-progress__error">错误代码：{snapshot.errorCode}</span>}
        </section>
      )}

      {hasRoot && importRunning && importing && (
        <section className="scan-progress-card" data-state="importing" aria-label="导入进度">
          <div className="scan-progress-card__line">
            <strong>{importing.phase === "filing" ? "正在归入珍藏" : "正在导入"}</strong>
            <span className="scan-progress-card__counters">
              {importing.processed} / {importing.total}
              {importing.fileName ? ` · ${importing.fileName}` : ""}
            </span>
          </div>
          <div
            className="scan-progress__bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round((importing.processed / Math.max(1, importing.total)) * 100)}
          >
            <div
              className="scan-progress__fill"
              style={{ width: `${Math.round((importing.processed / Math.max(1, importing.total)) * 100)}%` }}
            />
          </div>
          <div className="scan-progress-card__foot">
            <span>新增 {importing.imported} · 重复 {importing.duplicates} · 失败 {importing.failed}</span>
            <button className="button button--small button--danger-outline" type="button" onClick={() => void api.cancelImport()}>
              停止导入
            </button>
          </div>
        </section>
      )}

      {hasRoot && overview && (
        <>
          <section className="scan-summary" aria-label="扫描结果概览">
            <Stat label="文件夹里" value={overview.present} hint="个书籍文件" />
            <Stat label="已入库" value={overview.inLibrary} hint="本" tone="ok" />
            <Stat label="待导入" value={overview.unimported} hint="本" tone={overview.unimported > 0 ? "attention" : undefined} />
            <Stat
              label="重复"
              value={overview.duplicateGroups}
              hint={overview.reclaimableBytes > 0 ? `可释放 ${formatBytes(overview.reclaimableBytes)}` : "组"}
              tone={overview.duplicateGroups > 0 ? "warn" : undefined}
            />
            <Stat label="疑似系列" value={overview.seriesGroups} hint="组" tone={overview.seriesGroups > 0 ? "attention" : undefined} />
            {overview.missing > 0 && <Stat label="已不在文件夹" value={overview.missing} hint="本" tone="muted" />}
          </section>

          {workLeft === 0 ? (
            <section className="scan-done">
              <Check size={22} weight="bold" />
              <div>
                <h2>{scanned ? "这个文件夹已经整理完了" : "还没有扫描过"}</h2>
                <p>
                  {scanned
                    ? "没有待导入的书，也没有需要处理的重复或系列。"
                    : "开始扫描后，这里会列出可以导入的书、重复文件和疑似系列。"}
                </p>
              </div>
            </section>
          ) : (
            <section className="scan-next" aria-label="建议的下一步">
              <h2>接下来</h2>
              <ol className="scan-next__steps">
                {unimported > 0 && (
                  <li>
                    <span className="scan-next__index">1</span>
                    <div className="scan-next__body">
                      <strong>把这些书加进书库</strong>
                      <span>文件夹里有 {unimported} 本还没入库，导入后才能阅读和整理。</span>
                    </div>
                    <button
                      className="button button--primary"
                      type="button"
                      disabled={busy || importRunning}
                      onClick={() => void runImport({ scope: "all-unimported" })}
                    >
                      导入全部 {unimported} 本
                    </button>
                  </li>
                )}
                {clearable > 0 && (
                  <li>
                    <span className="scan-next__index">{unimported > 0 ? 2 : 1}</span>
                    <div className="scan-next__body">
                      <strong>清理重复文件</strong>
                      <span>
                        {clearable} 组内容完全相同的文件，可以释放 {formatBytes(overview.reclaimableBytes)}。
                        移入系统回收站前会逐个重新校验。
                      </span>
                    </div>
                    <button className="button" type="button" disabled={busy} onClick={() => setTab("duplicates")}>
                      去处理
                      <ArrowRight size={14} />
                    </button>
                  </li>
                )}
                {(seriesReady > 0 || seriesPending > 0) && (
                  <li>
                    <span className="scan-next__index">{stepIndex(unimported, clearable)}</span>
                    <div className="scan-next__body">
                      <strong>整理疑似系列</strong>
                      <span>
                        {seriesReady > 0 && <>{seriesReady} 组可以直接归入珍藏</>}
                        {seriesReady > 0 && seriesPending > 0 && "；"}
                        {seriesPending > 0 && <>{seriesPending} 组需要先导入</>}。
                      </span>
                    </div>
                    <button className="button" type="button" disabled={busy} onClick={() => setTab("series")}>
                      去处理
                      <ArrowRight size={14} />
                    </button>
                  </li>
                )}
              </ol>
            </section>
          )}

          <nav className="scan-tabs" aria-label="扫描结果分类">
            <TabButton active={tab === "incoming"} onClick={() => setTab("incoming")} count={unimported} label="待导入" />
            <TabButton active={tab === "duplicates"} onClick={() => setTab("duplicates")} count={overview.duplicateGroups} label="重复文件" />
            <TabButton active={tab === "series"} onClick={() => setTab("series")} count={overview.seriesGroups} label="疑似系列" />
            <TabButton active={tab === "done"} onClick={() => setTab("done")} count={0} label="说明" />
          </nav>

          {tab === "incoming" && (
            <section className="scan-panel" aria-label="待导入的书">
              <div className="scan-panel__toolbar">
                <label className="scan-check">
                  <input
                    type="checkbox"
                    checked={allPageSelected}
                    disabled={busy || importRunning || unimportedOnPage.length === 0}
                    onChange={(event) => setSelected((current) => {
                      const next = new Set(current);
                      for (const file of unimportedOnPage) {
                        if (event.target.checked) next.add(file.inventoryId);
                        else next.delete(file.inventoryId);
                      }
                      return next;
                    })}
                  />
                  <span>本页全选</span>
                </label>
                <span className="scan-panel__count">
                  共 {filesTotal} {onlyUnimported ? "本待导入" : "个文件"}
                  {selected.size > 0 ? ` · 已选 ${selected.size}` : ""}
                </span>
                <button
                  className="button button--subtle"
                  type="button"
                  disabled={busy}
                  onClick={() => void setFilter(!onlyUnimported)}
                >
                  {onlyUnimported ? "显示已在书库的文件" : "只看未入库"}
                </button>
                <div className="scan-panel__spacer" />
                <button
                  className="button button--small"
                  type="button"
                  disabled={busy || importRunning || selected.size === 0}
                  onClick={() => openFiling([...selected])}
                >
                  <Stack size={14} />
                  导入并归入珍藏…
                </button>
                <button
                  className={`button button--small ${selected.size > 0 ? "button--primary" : ""}`}
                  type="button"
                  disabled={busy || importRunning || selected.size === 0}
                  onClick={() => void runImport({ scope: "selected", inventoryIds: [...selected] })}
                >
                  导入所选（{selected.size}）
                </button>
              </div>

              {files.length === 0 ? (
                <p className="scan-panel__empty">
                  {onlyUnimported ? "文件夹里的书都已经在书库中了。" : "文件夹里没有书籍文件。"}
                </p>
              ) : (
                <ul className="scan-rows">
                  {files.map((file) => (
                    <li key={file.inventoryId} className="scan-row">
                      <input
                        type="checkbox"
                        aria-label={`选择 ${fileName(file.relativePath)}`}
                        checked={selected.has(file.inventoryId)}
                        disabled={busy || importRunning || file.bookId !== null}
                        onChange={() => toggleSelected(file.inventoryId)}
                      />
                      <div className="scan-row__main">
                        {/* The file name leads: this is a list of files to pick from, and
                            a TXT's extracted "title" is often just its first line. */}
                        <span className="scan-row__title">{fileName(file.relativePath)}</span>
                        <span className="scan-row__path">
                          {folderOf(file.relativePath) ?? ""}
                          {file.bookId && <>{folderOf(file.relativePath) ? " · " : ""}已在书库</>}
                        </span>
                      </div>
                      {file.author && <span className="scan-row__author">{file.author}</span>}
                      <span className="scan-row__meta">{file.format.toUpperCase()} · {formatBytes(file.fileSize)}</span>
                    </li>
                  ))}
                </ul>
              )}

              {filesTotal > FILE_PAGE_SIZE && (
                <div className="scan-pager">
                  <button className="button button--small" type="button" disabled={busy || filePage === 0}
                    onClick={() => { setFilePage(filePage - 1); void refresh({ page: filePage - 1 }); }}>
                    上一页
                  </button>
                  <span className="scan-pager__label">
                    第 {filePage + 1} / {Math.max(1, Math.ceil(filesTotal / FILE_PAGE_SIZE))} 页
                  </span>
                  <button className="button button--small" type="button"
                    disabled={busy || (filePage + 1) * FILE_PAGE_SIZE >= filesTotal}
                    onClick={() => { setFilePage(filePage + 1); void refresh({ page: filePage + 1 }); }}>
                    下一页
                  </button>
                </div>
              )}
            </section>
          )}

          {tab === "duplicates" && (
            <section className="scan-panel" aria-label="重复文件">
              <div className="scan-panel__toolbar">
                <span className="scan-panel__count">
                  {clearable} 组可清理
                  {conflicted > 0 && <> · {conflicted} 组需要单独确认</>}
                  {overview.reclaimableBytes > 0 && <> · 可释放 {formatBytes(overview.reclaimableBytes)}</>}
                </span>
                <div className="scan-panel__spacer" />
                <button className="button button--small" type="button" disabled={busy || duplicates.length === 0}
                  onClick={() => void decideAll("exact_duplicate", "reject")}>
                  全部忽略
                </button>
                <button
                  className="button button--small button--danger-outline"
                  type="button"
                  disabled={busy || clearable === 0}
                  onClick={() => setConfirming("batch:exact_duplicate")}
                >
                  全部移入回收站（{clearable} 组）
                </button>
              </div>

              {confirming === "batch:exact_duplicate" && (
                <div className="scan-confirm scan-confirm--block" role="alert">
                  <p>
                    将把 <strong>{clearable} 组</strong>重复文件里多余的副本移入系统回收站，共可释放{" "}
                    <strong>{formatBytes(overview.reclaimableBytes)}</strong>。
                    每组都会在移动前重新计算保留副本的完整哈希，只要有任何文件变化，那一组就整体跳过，不会动任何文件。
                    {conflicted > 0 && <> 另有 {conflicted} 组文件名冲突，需要你逐条确认，不在这次范围内。</>}
                  </p>
                  <div className="scan-confirm__actions">
                    <button className="button button--small" type="button" disabled={busy} onClick={() => setConfirming(null)}>
                      取消
                    </button>
                    <button className="button button--small button--danger" type="button" disabled={busy}
                      onClick={() => void decideAll("exact_duplicate", "accept")}>
                      确认清理 {clearable} 组
                    </button>
                  </div>
                </div>
              )}

              {duplicates.length === 0 ? (
                <p className="scan-panel__empty">没有重复文件。</p>
              ) : (
                <ul className="scan-rows">
                  {duplicates.map((finding) => (
                    <FindingRow
                      key={finding.id}
                      finding={finding}
                      busy={busy}
                      confirming={confirming === finding.id}
                      onAskConfirm={() => setConfirming(finding.id)}
                      onCancelConfirm={() => setConfirming(null)}
                      onDecide={(decision) => void decide(finding, decision)}
                      onImportFirst={() => {
                        const ids = finding.candidates.map((candidate) => candidate.inventoryId);
                        void runImport({ scope: "selected", inventoryIds: ids });
                      }}
                      onOrganize={() => {
                        const ids = finding.candidates.map((candidate) => candidate.inventoryId);
                        const name = finding.evidence.kind === "series_volume"
                          ? finding.evidence.normalizedSeries
                          : undefined;
                        openFiling(ids, name);
                      }}
                    />
                  ))}
                </ul>
              )}
            </section>
          )}

          {tab === "series" && (
            <section className="scan-panel" aria-label="疑似系列">
              <div className="scan-panel__toolbar">
                <span className="scan-panel__count">
                  {seriesReady} 组可直接归入珍藏
                  {seriesPending > 0 && <> · {seriesPending} 组需要先导入</>}
                </span>
                <div className="scan-panel__spacer" />
                <button className="button button--small" type="button" disabled={busy || series.length === 0}
                  onClick={() => void decideAll("series_volume", "reject")}>
                  全部忽略
                </button>
              </div>

              {series.length === 0 ? (
                <p className="scan-panel__empty">没有发现疑似系列。</p>
              ) : (
                <ul className="scan-rows">
                  {series.map((finding) => (
                    <FindingRow
                      key={finding.id}
                      finding={finding}
                      busy={busy}
                      confirming={confirming === finding.id}
                      onAskConfirm={() => setConfirming(finding.id)}
                      onCancelConfirm={() => setConfirming(null)}
                      onDecide={(decision) => void decide(finding, decision)}
                      onImportFirst={() => {
                        const ids = finding.candidates.map((candidate) => candidate.inventoryId);
                        void runImport({ scope: "selected", inventoryIds: ids });
                      }}
                      onOrganize={() => {
                        const ids = finding.candidates.map((candidate) => candidate.inventoryId);
                        const name = finding.evidence.kind === "series_volume"
                          ? finding.evidence.normalizedSeries
                          : undefined;
                        openFiling(ids, name);
                      }}
                    />
                  ))}
                </ul>
              )}
            </section>
          )}

          {tab === "done" && (
            <section className="scan-panel scan-panel--prose" aria-label="说明">
              <h2>这一页是怎么工作的</h2>
              <p>
                扫描只读取文件夹、列出发现的问题，<strong>不会移动或删除任何文件</strong>。
                导入会把文件登记进书库（书籍仍留在原文件夹）；唯一的删除动作是清理重复文件，
                它需要你确认，而且移入的是系统回收站，可以还原。
              </p>
              <h3>导入</h3>
              <p>
                「导入全部」会遍历文件夹里所有还没入库的书，走的是和手动导入完全相同的流程：
                计算内容哈希去重，然后登记。内容完全相同的第二个文件不会变成第二本书 ——
                这也是为什么"重复文件"和"待导入"是两件事。
              </p>
              <h3>重复文件</h3>
              <p>
                同一份内容出现在多个文件里。清理时每组会先重新计算保留副本的完整哈希，
                只有当场证明存在逐字节相同的副本才会移动，并按文件名长短、修改时间挑出更该保留的那一份。
                文件名暗示的卷数不一致时（例如两个文件都叫不同的卷），不会被自动处理，需要你逐条判断。
              </p>
              <h3>疑似系列</h3>
              <p>
                根据文件名里的卷标（第 N 卷 / Vol.N / 上中下卷…）归类，至少要有两个不同的卷标才算一组。
                归入珍藏只影响书库里的归类，不动文件。
              </p>
            </section>
          )}
        </>
      )}

      {filing && (
        <div className="modal-backdrop" role="presentation" onClick={() => { if (!busy) setFiling(null); }}>
          <div
            className="scan-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="导入并归入珍藏"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="scan-dialog__header">
              <h2>导入并归入珍藏</h2>
              <button className="button button--subtle" type="button" aria-label="关闭" disabled={busy} onClick={() => setFiling(null)}>
                <X size={16} />
              </button>
            </header>
            <p className="scan-dialog__hint">
              已选 {filing.ids.length} 个文件。先查找已有珍藏，或为它们建立新珍藏；尚未入库的文件会一并导入。
            </p>

            {collections.length > 0 && (
              <div className="scan-dialog__existing">
                <label htmlFor="scan-existing-search">加入已有珍藏</label>
                <input id="scan-existing-search" type="search" aria-label="搜索已有珍藏" placeholder={`搜索 ${collections.length} 个珍藏`} value={collectionQuery} disabled={busy} onChange={(event) => { setCollectionQuery(event.target.value); setError(null); }} />
                <div className="scan-dialog__existing-choice">
                  <select aria-label="选择已有珍藏" value={selectedExistingCollectionId} disabled={busy || matchingCollections.length === 0} onChange={(event) => { setExistingCollectionId(event.target.value); setError(null); }}>
                    {matchingCollections.map((collection) => <option key={collection.id} value={collection.id}>{collection.name}</option>)}
                  </select>
                  <button className="button button--primary" type="button" disabled={busy || !selectedExistingCollectionId} onClick={() => void organize(filing.ids, { collectionId: selectedExistingCollectionId })}>导入到已有珍藏</button>
                </div>
                {matchingCollections.length === 0 && <small>没有找到珍藏，请换个关键词。</small>}
              </div>
            )}

            <div className="scan-dialog__field scan-dialog__field--new">
              <label htmlFor="scan-new-collection">新建珍藏</label>
              <input
                id="scan-new-collection"
                type="text"
                value={newCollectionName ?? filing.seriesName ?? ""}
                placeholder="输入珍藏名称"
                disabled={busy}
                onChange={(event) => { setNewCollectionName(event.target.value); setError(null); }}
              />
            </div>

            {error && <p className="scan-dialog__error" role="alert">{error}</p>}

            <footer className="scan-dialog__footer">
              <button className="button" type="button" disabled={busy} onClick={() => setFiling(null)}>取消</button>
              <button
                className={`button button--small ${collections.length === 0 && (newCollectionName ?? filing.seriesName ?? "").trim().length > 0 ? "button--primary" : ""}`}
                type="button"
                disabled={busy || (newCollectionName ?? filing.seriesName ?? "").trim().length === 0}
                onClick={() => void organize(filing.ids, { newName: (newCollectionName ?? filing.seriesName ?? "").trim() })}
              >
                导入并归入
              </button>
            </footer>
          </div>
        </div>
      )}
    </main>
  );
}

function stepIndex(unimported: number, clearable: number): number {
  return 1 + (unimported > 0 ? 1 : 0) + (clearable > 0 ? 1 : 0);
}

/** The last segment of a relative path — what the file is called. */
function fileName(relativePath: string): string {
  const parts = relativePath.split("/");
  return parts[parts.length - 1] || relativePath;
}

/** The folder a file sits in, or null at the top level where it adds nothing. */
function folderOf(relativePath: string): string | null {
  const parts = relativePath.split("/");
  return parts.length > 1 ? parts.slice(0, -1).join("/") : null;
}

function percent(progress: { done: number; total: number }): number {
  return Math.min(100, Math.round((progress.done / Math.max(1, progress.total)) * 100));
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function Stat({ label, value, hint, tone }: {
  label: string;
  value: number;
  hint: string;
  tone?: "ok" | "warn" | "attention" | "muted";
}) {
  return (
    <div className="scan-stat" data-tone={tone}>
      <span className="scan-stat__label">{label}</span>
      <span className="scan-stat__value">{value.toLocaleString("zh-CN")}</span>
      <span className="scan-stat__hint">{hint}</span>
    </div>
  );
}

function TabButton({ active, onClick, count, label }: {
  active: boolean;
  onClick(): void;
  count: number;
  label: string;
}) {
  return (
    <button
      className="scan-tab"
      type="button"
      aria-current={active ? "true" : undefined}
      data-active={active}
      onClick={onClick}
    >
      {label}
      {count > 0 && <span className="scan-tab__count">{count}</span>}
    </button>
  );
}

type FindingRowProps = {
  finding: ScanFindingDetail;
  busy: boolean;
  confirming: boolean;
  onAskConfirm(): void;
  onCancelConfirm(): void;
  onDecide(decision: "accept" | "reject"): void;
  onImportFirst(): void;
  onOrganize(): void;
};

/**
 * One finding, as a task rather than a report.
 *
 * The first version showed every candidate path with three kinds of badge and left the
 * reader to work out what to press. The action comes first here, and the file list is
 * supporting detail: the survivor is named inside the confirmation, which is where it
 * actually matters.
 */
function FindingRow({
  finding,
  busy,
  confirming,
  onAskConfirm,
  onCancelConfirm,
  onDecide,
  onImportFirst,
  onOrganize,
}: FindingRowProps) {
  const action = finding.proposedAction;
  const [expanded, setExpanded] = useState(false);
  const survivorId = action.kind === "recycle_duplicates" ? action.survivorInventoryId : null;
  const victims = action.kind === "recycle_duplicates" ? action.victimInventoryIds : [];
  const survivor = finding.candidates.find((candidate) => candidate.inventoryId === survivorId);
  const importedCount = finding.candidates.filter((candidate) => candidate.bookId !== null).length;

  const title = finding.kind === "exact_duplicate"
    ? finding.evidence.kind === "exact_duplicate" && finding.evidence.volumeConflict
      ? `内容相同的 ${finding.candidates.length} 个文件，卷数不一致`
      : `内容相同的 ${finding.candidates.length} 个文件`
    : `「${finding.evidence.kind === "series_volume" ? finding.evidence.normalizedSeries : "未命名"}」${finding.candidates.length} 卷`;

  return (
    <li className="scan-row scan-row--finding" data-kind={finding.kind}>
      <div className="scan-row__icon" aria-hidden="true">
        {finding.kind === "exact_duplicate" ? <Copy size={18} /> : <Stack size={18} />}
      </div>

      <div className="scan-row__main">
        <span className="scan-row__title">{title}</span>
        <span className="scan-row__path">
          {finding.kind === "exact_duplicate"
            ? `保留 ${survivor?.relativePath ?? "未知"}，移除 ${victims.length} 个副本`
            : importedCount === 0
              ? `${finding.candidates.length} 卷都还没入库`
              : importedCount === finding.candidates.length
                ? `${finding.candidates.length} 卷都已入库`
                : `${finding.candidates.length} 卷中 ${importedCount} 卷已入库`}
        </span>
      </div>

      <span className="scan-row__meta">
        {action.kind === "recycle_duplicates" ? `可释放 ${formatBytes(action.reclaimableBytes)}` : ""}
      </span>

      <div className="scan-row__actions">
        <button className="button button--subtle" type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? "收起" : "文件"}
        </button>
        <button className="button button--small" type="button" disabled={busy} onClick={() => onDecide("reject")}>
          忽略
        </button>

        {action.kind === "recycle_duplicates" && !confirming && (
          <button className="button button--small button--danger-outline" type="button" disabled={busy} onClick={onAskConfirm}>
            移入回收站
          </button>
        )}
        {action.kind === "create_collection" && !confirming && (
          <button className="button button--small button--primary" type="button" disabled={busy} onClick={onAskConfirm}>
            归入珍藏「{action.name}」
          </button>
        )}
        {action.kind === "none" && action.reason === "nothing_imported" && (
          <>
            <button className="button button--small" type="button" disabled={busy} onClick={onImportFirst}>
              先导入这 {finding.candidates.length} 个文件
            </button>
            <button className="button button--small button--primary" type="button" disabled={busy} onClick={onOrganize}>
              导入并归入珍藏…
            </button>
          </>
        )}
        {action.kind === "none" && action.reason !== "nothing_imported" && (
          <span className="scan-row__note">
            <Warning size={14} />
            扫描结果已过期，重新扫描后再处理
          </span>
        )}
      </div>

      {confirming && action.kind === "recycle_duplicates" && (
        <div className="scan-confirm scan-confirm--block" role="alert">
          <p>
            将把 {victims.length} 个副本移入系统回收站，保留 <strong>{survivor?.relativePath}</strong>，
            释放 {formatBytes(action.reclaimableBytes)}。移动前会重新校验保留副本的完整哈希，
            内容有变化就整组跳过。
          </p>
          <div className="scan-confirm__actions">
            <button className="button button--small" type="button" disabled={busy} onClick={onCancelConfirm}>
              取消
            </button>
            <button className="button button--small button--danger" type="button" disabled={busy} onClick={() => onDecide("accept")}>
              确认移入回收站
            </button>
          </div>
        </div>
      )}

      {confirming && action.kind === "create_collection" && (
        <div className="scan-confirm scan-confirm--block" role="alert">
          <p>
            将新建或复用珍藏「{action.name}」，并加入 {action.bookIds.length} 本已入库的书。
          </p>
          <div className="scan-confirm__actions">
            <button className="button button--small" type="button" disabled={busy} onClick={onCancelConfirm}>
              取消
            </button>
            <button className="button button--small button--primary" type="button" disabled={busy} onClick={() => onDecide("accept")}>
              确认归入
            </button>
          </div>
        </div>
      )}

      {expanded && (
        <ul className="scan-row__files">
          {finding.candidates.map((candidate) => (
            <li key={candidate.inventoryId}>
              <span className="scan-row__filepath">{candidate.relativePath}</span>
              <span className="scan-row__meta">{formatBytes(candidate.fileSize)}</span>
              {candidate.inventoryId === survivorId && <span className="scan-badge scan-badge--ok">保留</span>}
              {victims.includes(candidate.inventoryId) && <span className="scan-badge scan-badge--warn">移除</span>}
              {candidate.bookId && <span className="scan-badge">已入库</span>}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
