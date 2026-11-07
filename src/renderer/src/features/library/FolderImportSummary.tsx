import { CheckCircle, Info, WarningCircle, X } from "@phosphor-icons/react";
import type {
  FolderCollectionImportProgress,
  FolderCollectionImportResult,
  LibraryImportItemResult,
} from "../../../../shared/contracts.js";
import { sanitizePublicReaderText } from "../../errors/public-error.js";

export function countFolderImportItems(items: LibraryImportItemResult[]) {
  return items.reduce((counts, item) => {
    if (item.status === "imported") counts.imported += 1;
    else if (item.status === "duplicate") counts.duplicate += 1;
    else counts.failed += 1;
    return counts;
  }, { imported: 0, duplicate: 0, failed: 0 });
}

type Props = {
  active: boolean;
  progress: FolderCollectionImportProgress | null;
  result: FolderCollectionImportResult | null;
  onDismiss(): void;
};

export function FolderImportSummary({
  active,
  progress,
  result,
  onDismiss,
}: Props) {
  if (!active && !result) return null;

  if (active) {
    return (
      <aside className="folder-import-summary" role="status" aria-label="文件夹导入进度">
        <span className="folder-import-summary__icon" aria-hidden="true"><Info size={20} weight="duotone" /></span>
        <div>
          <strong>{progress && progress.total > 0
            ? `正在导入 ${progress.processed} / ${progress.total}`
            : "正在准备导入文件夹"}</strong>
          {progress?.fileName && <span>{sanitizePublicReaderText(progress.fileName)}</span>}
        </div>
        {progress && progress.total > 0 && (
          <div className="folder-import-summary__track" aria-hidden="true">
            <span style={{ width: `${Math.round(progress.processed / progress.total * 100)}%` }} />
          </div>
        )}
      </aside>
    );
  }

  if (!result || result.status === "cancelled") return null;
  if (result.status === "empty") {
    return (
      <aside className="folder-import-summary" role="status" aria-label="文件夹导入结果">
        <span className="folder-import-summary__icon" aria-hidden="true"><Info size={20} weight="duotone" /></span>
        <div>
          <strong>文件夹中没有可导入的 EPUB 或 TXT</strong>
          <span>{sanitizePublicReaderText(result.folderName)} 未创建珍藏。</span>
        </div>
        <button className="icon-button" type="button" aria-label="关闭导入结果" onClick={onDismiss}><X size={18} /></button>
      </aside>
    );
  }

  const counts = countFolderImportItems(result.items);
  const preparing = result.items.filter((item) =>
    (item.status === "imported" || item.status === "duplicate")
    && item.book.format === "epub"
    && (
      item.book.preparationStatus === "queued"
      || item.book.preparationStatus === "preparing"
    )).length;
  const failures = result.items.filter((item) =>
    item.status === "failed" || item.status === "unsupported");
  return (
    <aside
      className="folder-import-summary"
      data-result={result.status}
      role="status"
      aria-label="文件夹导入结果"
    >
      <span className="folder-import-summary__icon" aria-hidden="true">
        {result.status === "completed" || result.status === "organized"
          ? <CheckCircle size={20} weight="duotone" />
          : <WarningCircle size={20} weight="duotone" />}
      </span>
      <div>
        <strong>{result.status === "completed"
          ? `已加入《${sanitizePublicReaderText(result.collection.name)}》`
          : result.status === "organized"
            ? `已按 ${result.collections.length} 个珍藏整理`
            : `《${sanitizePublicReaderText(result.folderName)}》未能导入`}</strong>
        <span className="folder-import-summary__counts">
          新加入 {counts.imported} · 已有 {counts.duplicate} · 忽略 {result.ignoredEntries} · 失败 {counts.failed}
          {result.status === "organized" && result.rootFiles > 0 ? ` · 根目录 ${result.rootFiles} 本未自动归类` : ""}
          {preparing > 0 ? ` · EPUB 后台准备中 ${preparing}` : ""}
        </span>
        {failures.length > 0 && (
          <ul>
            {failures.slice(0, 5).map((item) => (
              <li key={`${item.status}:${item.fileName}`}>
                {sanitizePublicReaderText(item.fileName)} · {item.errorCode}
                {item.status === "failed" ? ` · ${sanitizePublicReaderText(item.message)}` : ""}
              </li>
            ))}
          </ul>
        )}
      </div>
      <button className="icon-button" type="button" aria-label="关闭导入结果" onClick={onDismiss}><X size={18} /></button>
    </aside>
  );
}
