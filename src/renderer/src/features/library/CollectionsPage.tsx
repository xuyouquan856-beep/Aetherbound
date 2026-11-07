import { TransitionPresence } from "../shell/TransitionPresence.js";
import { FolderOpen, FolderPlus, Plus } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import type {
  CollectionDetails,
  CollectionSummary,
  FolderCollectionImportResult,
} from "../../../../shared/contracts.js";
import { CollectionEditorDialog } from "./CollectionEditorDialog.js";
import { CollectionStack } from "./CollectionStack.js";
import {
  DefaultCoverPrewarmOptions,
  prewarmCoverImages,
} from "./cover-image-cache.js";

type Props = {
  collections: CollectionSummary[];
  query?: string;
  busy: boolean;
  onCreate(name: string): Promise<CollectionDetails>;
  onImportFolder(): Promise<FolderCollectionImportResult>;
  onSelect(id: string): void;
};

/** Each stack paints at most three covers; warm the ones above the fold first. */
const CollectionsPagePrewarmLimit = 24;

export function CollectionsPage({
  collections,
  query = "",
  busy,
  onCreate,
  onImportFolder,
  onSelect,
}: Props) {
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const filteredCollections = useMemo(() => {
    const term = query.trim().normalize("NFKC").toLocaleLowerCase();
    return term
      ? collections.filter((collection) => collection.name.normalize("NFKC").toLocaleLowerCase().includes(term))
      : collections;
  }, [collections, query]);

  const coverUrls = useMemo(() => {
    const urls: string[] = [];
    for (const collection of filteredCollections) {
      for (const book of collection.previewBooks) {
        if (book.coverUrl) urls.push(book.coverUrl);
      }
    }
    return urls;
  }, [filteredCollections]);

  // The stacks render with loading="lazy", so without this the covers only start
  // loading as they scroll into view and the view looks empty while it fills in.
  useEffect(() => {
    if (coverUrls.length === 0) return;
    void prewarmCoverImages(coverUrls, {
      ...DefaultCoverPrewarmOptions,
      limit: CollectionsPagePrewarmLimit,
      concurrency: 6,
    }).catch(() => undefined);
  }, [coverUrls]);

  async function create(name: string) {
    const created = await onCreate(name);
    setCreating(false);
    onSelect(created.id);
  }

  async function importFolder() {
    setImporting(true);
    try {
      const result = await onImportFolder();
      if (result.status === "completed") onSelect(result.collection.id);
    } finally {
      setImporting(false);
    }
  }

  return (
    <section className="collections-page" aria-labelledby="collections-title">
      <header className="collections-page__header">
        <div>
          <div className="library-page-title"><span className="library-page-index">03</span><h1 id="collections-title">我的珍藏</h1><span className="library-page-rule" /></div>
          <p>{query.trim()
            ? `找到 ${filteredCollections.length} 个珍藏 · 共 ${collections.length} 个`
            : collections.length ? `${collections.length} 个自定义书单` : "用自己的方式为书籍归组，一本书也可以加入多个珍藏。"}</p>
        </div>
        {collections.length > 0 && (
          <button className="button button--primary" type="button" onClick={() => setCreating(true)} disabled={busy}>
            <Plus size={18} />新建珍藏
          </button>
        )}
      </header>

      {collections.length === 0 ? (
        <div className="collections-empty">
          <span aria-hidden="true"><FolderOpen size={34} weight="duotone" /></span>
          <h2>建立第一份属于你的珍藏</h2>
          <p>你可以手动创建空珍藏，也可以把一个文件夹中的 EPUB 与 TXT 直接导入为同名珍藏。</p>
          <div>
            <button className="button button--primary" type="button" onClick={() => setCreating(true)} disabled={busy}>
              <Plus size={18} />新建珍藏
            </button>
            <button className="button" type="button" onClick={() => void importFolder()} disabled={busy || importing}>
              <FolderPlus size={18} />{importing ? "正在导入" : "导入文件夹为珍藏"}
            </button>
          </div>
        </div>
      ) : filteredCollections.length === 0 ? (
        <div className="collections-empty" role="status">
          <span aria-hidden="true"><FolderOpen size={34} weight="duotone" /></span>
          <h2>没有找到这个珍藏</h2>
          <p>试试珍藏名称中的其他字词，或清除上方的搜索条件。</p>
        </div>
      ) : (
        <div className="collection-stack-grid">
          {filteredCollections.map((collection) => (
            <CollectionStack collection={collection} onSelect={onSelect} variant="crystal" key={collection.id} />
          ))}
        </div>
      )}

      <TransitionPresence>{creating && (
        <CollectionEditorDialog
          mode="create"
          busy={busy}
          onSave={create}
          onCancel={() => setCreating(false)}
        />
      )}</TransitionPresence>
    </section>
  );
}
