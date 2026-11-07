import { CheckCircle, Info, X } from "@phosphor-icons/react";
import type { LibraryImportBatchResult, LibraryImportProgress } from "../../../../shared/contracts.js";
import { sanitizePublicReaderText } from "../../errors/public-error.js";
import { countFolderImportItems } from "./FolderImportSummary.js";

type Props = {
  active: boolean;
  progress: LibraryImportProgress | null;
  result: LibraryImportBatchResult | null;
  onDismiss(): void;
};

export function FileImportSummary({ active, progress, result, onDismiss }: Props) {
  if (active) return (
    <aside className="folder-import-summary" role="status" aria-label="书籍文件导入进度">
      <Info size={20} weight="duotone" aria-hidden="true" />
      <div>
        <strong>{progress ? `正在导入 ${progress.processed} / ${progress.total}` : "正在准备书籍文件"}</strong>
        {progress?.fileName && <span>{sanitizePublicReaderText(progress.fileName)}</span>}
      </div>
    </aside>
  );
  if (!result || result.status === "cancelled") return null;
  const counts = countFolderImportItems(result.items);
  const failures = result.items.filter((item) => item.status === "failed" || item.status === "unsupported");
  return (
    <aside className="folder-import-summary" role="status" aria-label="书籍文件导入结果">
      <CheckCircle size={20} weight="duotone" aria-hidden="true" />
      <div>
        <strong>书籍文件导入完成</strong>
        <span>新加入 {counts.imported} · 已有 {counts.duplicate} · 失败 {counts.failed}</span>
        {failures.length > 0 && <ul>{failures.slice(0, 5).map((item, index) => (
          <li key={`${item.fileName}:${index}`}>{sanitizePublicReaderText(item.fileName)} · {item.errorCode}</li>
        ))}</ul>}
      </div>
      <button className="icon-button" type="button" aria-label="关闭导入结果" onClick={onDismiss}><X size={18} /></button>
    </aside>
  );
}
