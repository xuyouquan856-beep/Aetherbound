import { FolderPlus, Plus, X } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CollectionDetails,
  CollectionMembership,
  CollectionSummary,
} from "../../../../shared/contracts.js";

type Props = {
  bookIds: string[];
  collections: CollectionSummary[];
  busy: boolean;
  onGetMemberships(bookIds: string[]): Promise<CollectionMembership[]>;
  onCreateCollection(name: string): Promise<CollectionDetails>;
  onAddBooks(collectionId: string, bookIds: string[]): Promise<CollectionDetails>;
  onCancel(): void;
  onDone(): void;
};

export function AddToCollectionsDialog({
  bookIds,
  collections,
  busy,
  onGetMemberships,
  onCreateCollection,
  onAddBooks,
  onCancel,
  onDone,
}: Props) {
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [memberships, setMemberships] = useState<CollectionMembership[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [newName, setNewName] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disabled = busy || working;

  useEffect(() => {
    let current = true;
    onGetMemberships(bookIds)
      .then((value) => current && setMemberships(value))
      .catch(() => current && setError("无法读取现有珍藏关系，请稍后重试。"));
    nameInputRef.current?.focus();
    return () => {
      current = false;
    };
  }, [bookIds, onGetMemberships]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !disabled) onCancel();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [disabled, onCancel]);

  const membershipByCollection = useMemo(() => new Map(
    (memberships ?? []).map((membership) => [membership.collectionId, membership.bookIds]),
  ), [memberships]);

  function missingBookIds(collectionId: string): string[] {
    const existing = new Set(membershipByCollection.get(collectionId) ?? []);
    return bookIds.filter((bookId) => !existing.has(bookId));
  }

  function toggleCollection(collectionId: string) {
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(collectionId)) next.delete(collectionId);
      else next.add(collectionId);
      return next;
    });
  }

  async function addToChosen() {
    if (chosen.size === 0) return;
    setWorking(true);
    setError(null);
    try {
      for (const collection of collections) {
        if (!chosen.has(collection.id)) continue;
        const missing = missingBookIds(collection.id);
        if (missing.length > 0) await onAddBooks(collection.id, missing);
      }
      onDone();
    } catch {
      setError("未能完成加入操作，已有的珍藏关系不会被移除。");
    } finally {
      setWorking(false);
    }
  }

  async function createAndAdd() {
    const name = newName.trim();
    if (!name) return;
    setWorking(true);
    setError(null);
    try {
      const created = await onCreateCollection(name);
      await onAddBooks(created.id, bookIds);
      onDone();
    } catch {
      setError("未能创建珍藏，请检查名称后重试。");
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="collection-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-to-collections-title"
      >
        <header className="collection-dialog__header">
          <div>
            <span className="collection-dialog__icon" aria-hidden="true">
              <FolderPlus size={21} weight="duotone" />
            </span>
            <div>
              <h2 id="add-to-collections-title">加入珍藏</h2>
              <p>为已选择的 {bookIds.length} 本书添加归组，不会改变已有归组。</p>
            </div>
          </div>
          <button className="icon-button" type="button" aria-label="关闭" onClick={onCancel} disabled={disabled}>
            <X size={19} />
          </button>
        </header>

        <div className="collection-dialog__body">
          <section className="collection-dialog__create">
            <label htmlFor="new-collection-name">新珍藏名称</label>
            <div>
              <input
                ref={nameInputRef}
                id="new-collection-name"
                value={newName}
                maxLength={80}
                onChange={(event) => setNewName(event.target.value)}
                disabled={disabled}
              />
              <button
                className="button"
                type="button"
                disabled={disabled || !newName.trim()}
                onClick={() => void createAndAdd()}
              >
                <Plus size={17} />创建并加入
              </button>
            </div>
          </section>

          <div className="collection-dialog__list" aria-label="现有珍藏">
            {memberships === null && !error ? (
              <p className="collection-dialog__loading" role="status">正在读取珍藏…</p>
            ) : collections.length === 0 ? (
              <p className="collection-dialog__empty">还没有珍藏，可以在上方直接创建。</p>
            ) : collections.map((collection) => {
              const includedCount = bookIds.length - missingBookIds(collection.id).length;
              const fullyIncluded = includedCount === bookIds.length;
              return (
                <label className="collection-choice" key={collection.id} data-complete={fullyIncluded}>
                  <input
                    type="checkbox"
                    checked={fullyIncluded || chosen.has(collection.id)}
                    disabled={disabled || fullyIncluded}
                    onChange={() => toggleCollection(collection.id)}
                  />
                  <span>
                    <strong>{collection.name}</strong>
                    <small>
                      {fullyIncluded
                        ? `已包含全部 ${bookIds.length} 本`
                        : `已包含 ${includedCount} 本，可加入 ${bookIds.length - includedCount} 本`}
                    </small>
                  </span>
                </label>
              );
            })}
          </div>
          {error && <p className="collection-dialog__error" role="alert">{error}</p>}
        </div>

        <footer className="collection-dialog__actions">
          <button className="button" type="button" onClick={onCancel} disabled={disabled}>取消</button>
          <button
            className="button button--primary"
            type="button"
            disabled={disabled || memberships === null || chosen.size === 0}
            onClick={() => void addToChosen()}
          >
            {working ? "正在加入" : "加入所选珍藏"}
          </button>
        </footer>
      </section>
    </div>
  );
}
