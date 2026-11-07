import { Trash, X } from "@phosphor-icons/react";
import { useState } from "react";

type Props = {
  count: number;
  busy: boolean;
  onCancel(): void;
  onConfirm(deleteOriginal: boolean): void;
};

export function RemoveBooksDialog({ count, busy, onCancel, onConfirm }: Props) {
  const [deleteOriginal, setDeleteOriginal] = useState(false);
  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="confirmation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="remove-books-title"
        aria-describedby="remove-books-detail"
      >
        <div className="confirmation-dialog__icon" aria-hidden="true"><Trash size={22} weight="duotone" /></div>
        <div className="confirmation-dialog__copy">
          <h2 id="remove-books-title">确认移出书架</h2>
          <p id="remove-books-detail">将移出 {count} 本书，并清除它们在 Aetherbound 中的阅读进度。</p>
          <p>{deleteOriginal ? "原始 TXT 或 EPUB 文件会移入系统回收站。" : "默认保留原始 TXT 或 EPUB 文件。"}</p>
        </div>
        <label className="confirmation-dialog__file-option">
          <input type="checkbox" checked={deleteOriginal} disabled={busy} onChange={(event) => setDeleteOriginal(event.target.checked)} />
          <span>同时删除原始文件（移入系统回收站）</span>
        </label>
        <div className="confirmation-dialog__actions">
          <button className="button" type="button" onClick={onCancel} disabled={busy}>
            <X size={17} />取消
          </button>
          <button className="button button--danger" type="button" onClick={() => onConfirm(deleteOriginal)} disabled={busy}>
            <Trash size={17} />{busy ? "正在移出" : "确认移出"}
          </button>
        </div>
      </section>
    </div>
  );
}
