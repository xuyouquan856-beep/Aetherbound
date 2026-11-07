import { CrystalAppearanceSettings } from "../library/CrystalAppearanceSettings.js";
import { usePageTransition } from "./usePageTransition.js";
import type { BookSummary, ReaderShortcutProfileV1, ReadingAppearance } from "../../../../shared/contracts.js";
import { HomeDisplaySettings } from "./HomeDisplaySettings.js";
import { ShortcutEditor } from "../reader/ShortcutEditor.js";
import { ArrowLeft, ArrowRight, Moon, Quotes, SidebarSimple, SlidersHorizontal, Sparkle, Sun, TextAa } from "@phosphor-icons/react";
import { useEffect, useState, useRef, type ReactNode } from "react";

export function LibrarySettings({
  books,
  motion,
  collapsed,
  onMotion,
  onCollapsed,
  initialSubpage = null,
  onSubpageChange,
  appearance,
  onAppearanceChange,
  shortcuts,
  onShortcutsChange,
  children,
}: {
  books: BookSummary[];
  motion: boolean;
  collapsed: boolean;
  onMotion(): void;
  onCollapsed(): void;
  initialSubpage?: "quotes" | "reading" | null;
  onSubpageChange?(subpage: "quotes" | "reading" | null): void;
  appearance?: ReadingAppearance;
  onAppearanceChange?(next: ReadingAppearance): void;
  shortcuts?: ReaderShortcutProfileV1;
  onShortcutsChange?(next: ReaderShortcutProfileV1): void;
  children: ReactNode;
}) {
  const [subpage, setSubpage] = useState<"quotes" | "reading" | null>(initialSubpage);
  const surface = useRef<HTMLElement>(null);
  useEffect(() => {
    setSubpage(initialSubpage);
  }, [initialSubpage]);
  const changeSubpage = (next: "quotes" | "reading" | null) => {
    setSubpage(next);
    onSubpageChange?.(next);
  };
  usePageTransition(surface, subpage ?? "settings", false);
  if (subpage === "quotes") return <section ref={surface} className="library-settings__quotes">
    <button className="text-action settings-back" onClick={() => changeSubpage(null)}><ArrowLeft size={18} />返回设置</button>
    {children}
  </section>;
  if (subpage === "reading" && appearance && onAppearanceChange && shortcuts && onShortcutsChange) {
    const update = <K extends keyof ReadingAppearance>(key: K, value: ReadingAppearance[K]) => {
      onAppearanceChange({ ...appearance, [key]: value });
    };
    return <section ref={surface} className="library-settings" aria-labelledby="reading-settings-title">
      <button className="text-action settings-back" onClick={() => changeSubpage(null)}><ArrowLeft size={18} />返回设置</button>
      <header className="library-settings__header"><span className="library-page-index">06 · A</span><h1 id="reading-settings-title">阅读偏好与快捷键</h1><span className="library-page-rule" /></header>
      <p className="library-settings__intro">调整阅读器默认排版、主题与快捷键，修改即时生效。</p>
      <div className="appearance-form">
        <div className="setting-group">
          <span className="setting-label">EPUB 阅读方式</span>
          <div className="segmented-control">
            <button type="button" aria-label="EPUB 分页阅读" data-active={appearance.epubFlow === "paginated"} onClick={() => update("epubFlow", "paginated")}>分页</button>
            <button type="button" aria-label="EPUB 滚动阅读" data-active={appearance.epubFlow === "scrolled"} onClick={() => update("epubFlow", "scrolled")}>滚动</button>
          </div>
        </div>
        <div className="setting-group">
          <span className="setting-label">TXT 阅读方式</span>
          <div className="segmented-control">
            <button type="button" aria-label="TXT 分页阅读" data-active={(appearance.txtFlow ?? "scrolled") === "paginated"} onClick={() => update("txtFlow", "paginated")}>分页</button>
            <button type="button" aria-label="TXT 滚动阅读" data-active={(appearance.txtFlow ?? "scrolled") === "scrolled"} onClick={() => update("txtFlow", "scrolled")}>滚动</button>
          </div>
        </div>
        <div className="setting-group">
          <span className="setting-label">阅读主题</span>
          <div className="segmented-control">
            <button type="button" aria-label="纸张主题" data-active={appearance.theme === "paper"} onClick={() => update("theme", "paper")}><Sun size={18} />纸张</button>
            <button type="button" aria-label="夜间主题" data-active={appearance.theme === "night"} onClick={() => update("theme", "night")}><Moon size={18} />夜间</button>
          </div>
        </div>
        <div className="setting-group">
          <span className="setting-label">正文字体</span>
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
        <section className="setting-group" aria-labelledby="library-shortcut-settings-title">
          <span className="setting-label" id="library-shortcut-settings-title">阅读快捷键</span>
          <ShortcutEditor profile={shortcuts} onChange={onShortcutsChange} />
        </section>
      </div>
    </section>;
  }
  return <section ref={surface} className="library-settings" aria-labelledby="settings-title">
    <header className="library-settings__header"><span className="library-page-index">06</span><h1 id="settings-title">设置</h1><span className="library-page-rule" /></header>
    <p className="library-settings__intro">让书房按你的习惯展开。</p>
    <h2>界面与动效</h2>
    <div className="settings-row"><Sparkle size={24} /><div><h3>流光动效</h3><p>星光闪烁、银白文字和蝴蝶飞行。</p></div><button className="settings-switch" role="switch" aria-label="流光动效" aria-checked={motion} onClick={onMotion}><i /></button></div>
    <div className="settings-row"><SidebarSimple size={24} /><div><h3>收起侧栏</h3><p>保留导航图标，为书架腾出更多空间。</p></div><button className="settings-switch" role="switch" aria-label="收起侧栏" aria-checked={collapsed} onClick={onCollapsed}><i /></button></div>
    <CrystalAppearanceSettings books={books} />
    <HomeDisplaySettings books={books} />
    <h2>我的语句与阅读</h2>
    <button className="settings-row settings-row--link" onClick={() => changeSubpage("quotes")}><Quotes size={24} /><span><strong>语句库</strong><small>管理摘录、导入喜欢的句子，设置首页轮换。</small></span><ArrowRight size={21} /></button>
    {appearance && onAppearanceChange && shortcuts && onShortcutsChange && (
      <button className="settings-row settings-row--link" onClick={() => changeSubpage("reading")}><SlidersHorizontal size={24} /><span><strong>阅读偏好与快捷键</strong><small>调整字号、行距、主题与翻页快捷键。</small></span><ArrowRight size={21} /></button>
    )}
  </section>;
}
