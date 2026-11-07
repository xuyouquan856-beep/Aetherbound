import { Moon, Sun, TextAa, X } from "@phosphor-icons/react";
import type {
  ReaderShortcutProfileV1,
  ReadingAppearance,
} from "../../../../shared/contracts.js";
import { ShortcutEditor } from "./ShortcutEditor.js";

type Props = {
  appearance: ReadingAppearance;
  open: boolean;
  onChange(next: ReadingAppearance): void;
  onClose(): void;
  epub?: boolean;
  hasBookOverride?: boolean;
  onBookOverrideChange?(enabled: boolean): void;
  historyState?: { canGoBack: boolean; canGoForward: boolean };
  onHistoryBack?(): void;
  onHistoryForward?(): void;
  shortcuts: ReaderShortcutProfileV1;
  onShortcutsChange(profile: ReaderShortcutProfileV1): void;
  saveError?: string | null;
};

export function AppearancePanel({
  appearance,
  open,
  onChange,
  onClose,
  epub = false,
  hasBookOverride = false,
  onBookOverrideChange,
  shortcuts,
  onShortcutsChange,
  saveError,
}: Props) {
  function update<K extends keyof ReadingAppearance>(key: K, value: ReadingAppearance[K]) {
    onChange({ ...appearance, [key]: value });
  }
  const activeFlow = epub ? appearance.epubFlow : (appearance.txtFlow ?? "scrolled");
  const activeColumns = epub ? appearance.epubColumns : (appearance.txtColumns ?? "single");

  return (
    <aside className="reader-panel reader-panel--appearance" data-open={open} aria-label="阅读外观" aria-hidden={!open}>
      <header className="panel-header">
        <div><strong>阅读外观</strong><span>{hasBookOverride ? "本书专属" : "即时保存"}</span></div>
        <button className="icon-button" type="button" aria-label="收起阅读外观" onClick={onClose}><X size={20} /></button>
      </header>
      <div className="appearance-form">
        {onBookOverrideChange && (
          <div className="setting-group">
            <span className="setting-label">作用范围</span>
            <div className="segmented-control">
              <button type="button" aria-label="全局外观" data-active={!hasBookOverride} onClick={() => onBookOverrideChange(false)}>全部书籍</button>
              <button type="button" aria-label="仅应用于本书" data-active={hasBookOverride} onClick={() => onBookOverrideChange(true)}>仅本书</button>
            </div>
          </div>
        )}
        <div className="setting-group">
          <span className="setting-label">阅读方式</span>
          <div className="segmented-control">
            <button type="button" aria-label="分页阅读" data-active={activeFlow === "paginated"} onClick={() => update(epub ? "epubFlow" : "txtFlow", "paginated")}>分页</button>
            <button type="button" aria-label="滚动阅读" data-active={activeFlow === "scrolled"} onClick={() => update(epub ? "epubFlow" : "txtFlow", "scrolled")}>滚动</button>
          </div>
        </div>
        <div className="setting-group">
          <span className="setting-label">分页栏数</span>
          <div className="segmented-control">
            <button type="button" aria-label="单栏阅读" disabled={activeFlow === "scrolled"} data-active={activeColumns === "single"} onClick={() => update(epub ? "epubColumns" : "txtColumns", "single")}>单栏</button>
            <button type="button" aria-label="双栏阅读" disabled={activeFlow === "scrolled"} data-active={activeColumns === "double"} onClick={() => update(epub ? "epubColumns" : "txtColumns", "double")}>双栏</button>
          </div>
          <small className="setting-note">窗口较窄时，双栏会自动变为单栏。</small>
        </div>
        <div className="setting-group">
          <span className="setting-label">主题</span>
          <div className="segmented-control">
            <button type="button" aria-label="纸张主题" data-active={appearance.theme === "paper"} onClick={() => update("theme", "paper")}><Sun size={18} />纸张</button>
            <button type="button" aria-label="夜间主题" data-active={appearance.theme === "night"} onClick={() => update("theme", "night")}><Moon size={18} />夜间</button>
          </div>
        </div>
        <div className="setting-group">
          <span className="setting-label">字体</span>
          <div className="segmented-control">
            <button type="button" data-active={appearance.fontFamily === "serif"} onClick={() => update("fontFamily", "serif")}><TextAa size={18} />衬线</button>
            <button type="button" data-active={appearance.fontFamily === "sans"} onClick={() => update("fontFamily", "sans")}><TextAa size={18} />无衬线</button>
          </div>
        </div>
        <label className="range-setting"><span>字号 <output>{appearance.fontSize}px</output></span><input aria-label="字号" type="range" min="14" max="36" step="1" value={appearance.fontSize} onChange={(event) => update("fontSize", Number(event.target.value))} /></label>
        <label className="range-setting"><span>行距 <output>{appearance.lineHeight.toFixed(2)}</output></span><input aria-label="行距" type="range" min="1.4" max="2.4" step="0.05" value={appearance.lineHeight} onChange={(event) => update("lineHeight", Number(event.target.value))} /></label>
        <label className="range-setting"><span>页宽 <output>{appearance.measure}px</output></span><input aria-label="页宽" type="range" min="520" max="920" step="20" value={appearance.measure} onChange={(event) => update("measure", Number(event.target.value))} /></label>
        <label className="range-setting"><span>段间距 <output>{appearance.paragraphSpacing.toFixed(1)}em</output></span><input aria-label="段间距" type="range" min="0" max="1.5" step="0.1" value={appearance.paragraphSpacing} onChange={(event) => update("paragraphSpacing", Number(event.target.value))} /></label>
        <div className="setting-group">
          <span className="setting-label">首行缩进</span>
          <div className="segmented-control">
            <button type="button" aria-label="取消首行缩进" data-active={appearance.firstLineIndent === "none"} onClick={() => update("firstLineIndent", "none")}>关闭</button>
            <button type="button" aria-label="首行缩进两字" data-active={appearance.firstLineIndent === "two-em"} onClick={() => update("firstLineIndent", "two-em")}>缩进两字</button>
          </div>
        </div>
        <label className="range-setting"><span>字距 <output>{appearance.letterSpacing.toFixed(2)}em</output></span><input aria-label="字距" type="range" min="0" max="0.2" step="0.01" value={appearance.letterSpacing} onChange={(event) => update("letterSpacing", Number(event.target.value))} /></label>
        <label className="range-setting"><span>亮度 <output>{appearance.brightness}%</output></span><input aria-label="亮度" type="range" min="30" max="100" step="5" value={appearance.brightness} onChange={(event) => update("brightness", Number(event.target.value))} /></label>
        <section className="setting-group" aria-labelledby="shortcut-settings-title">
          <span className="setting-label" id="shortcut-settings-title">快捷键</span>
          <ShortcutEditor profile={shortcuts} onChange={onShortcutsChange} />
        </section>
        {saveError && <p className="reader-setting-error" role="status">{saveError}</p>}
      </div>
    </aside>
  );
}
