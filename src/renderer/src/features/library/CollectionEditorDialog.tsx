import { FolderPlus, X } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";

type Props = {
  mode: "create" | "rename";
  initialName?: string;
  busy: boolean;
  onSave(name: string): Promise<void>;
  onCancel(): void;
};

export function CollectionEditorDialog({
  mode,
  initialName = "",
  busy,
  onSave,
  onCancel,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(initialName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disabled = busy || saving;

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !disabled) onCancel();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [disabled, onCancel]);

  async function submit() {
    const nextName = name.trim();
    if (!nextName) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(nextName);
    } catch {
      setError("未能保存名称。名称可能已存在，请修改后重试。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="collection-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby="collection-editor-title"
      >
        <header>
          <FolderPlus size={22} weight="duotone" aria-hidden="true" />
          <h2 id="collection-editor-title">{mode === "create" ? "新建珍藏" : "重命名珍藏"}</h2>
          <button className="icon-button" type="button" aria-label="关闭" onClick={onCancel} disabled={disabled}>
            <X size={18} />
          </button>
        </header>
        <label htmlFor="collection-editor-name">珍藏名称</label>
        <input
          ref={inputRef}
          id="collection-editor-name"
          value={name}
          maxLength={80}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void submit();
          }}
          disabled={disabled}
        />
        {error && <p role="alert">{error}</p>}
        <footer>
          <button className="button" type="button" onClick={onCancel} disabled={disabled}>取消</button>
          <button className="button button--primary" type="button" onClick={() => void submit()} disabled={disabled || !name.trim()}>
            {saving ? "正在保存" : mode === "create" ? "创建珍藏" : "保存名称"}
          </button>
        </footer>
      </section>
    </div>
  );
}
