import { Books, FolderSimple, GearSix, House, MagnifyingGlass, Stack } from "@phosphor-icons/react";
import { ButterflyMark } from "./ButterflyMark.js";
import type { AppPage } from "./AppShell.js";
import { useLayoutEffect, useRef, useState } from "react";

type SidebarProps = {
  page: AppPage;
  onNavigate(page: AppPage): void;
};

export function Sidebar({ page, onNavigate }: SidebarProps) {
  const nav = useRef<HTMLElement>(null);
  const [indicator, setIndicator] = useState<{ top: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const element = nav.current;
    if (!element) return;
    const measure = () => {
      const active = element.querySelector<HTMLElement>('[aria-current="page"]');
      if (!active) { setIndicator(null); return; }
      setIndicator(previous => previous?.top === active.offsetTop && previous?.height === active.offsetHeight ? previous : { top: active.offsetTop, height: active.offsetHeight });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [page]);
  return (
    <aside className="app-sidebar" aria-label="侧边主导航">
      <div className="app-sidebar__brand" aria-label="Aetherbound 书库">
        <ButterflyMark title="Aetherbound 图标" className="app-sidebar__brand-mark" />
        <span className="app-sidebar__brand-copy"><span className="app-sidebar__brand-title">Aetherbound</span><small>故事，自此展开</small></span>
      </div>

      <nav className="app-sidebar__nav" ref={nav} data-indicator={Boolean(indicator)}>
        <span className="sidebar-selection" aria-hidden="true" style={{ opacity: indicator ? 1 : 0, height: indicator?.height ?? 52, transform: `translateY(${indicator?.top ?? 0}px)` }} />
        <div className="app-sidebar__nav-caption"><span>我的空间</span><small>01—02</small></div>
        <button
          className={`app-sidebar__item ${page === "home" ? "app-sidebar__item--active" : ""}`}
          type="button"
          aria-label="书房"
          title="书房"
          onClick={() => onNavigate("home")}
          aria-current={page === "home" ? "page" : undefined}
        >
          <House size={20} weight={page === "home" ? "fill" : "regular"} />
          <span>书房</span>
        </button>

        <button
          className={`app-sidebar__item ${page === "books" ? "app-sidebar__item--active" : ""}`}
          type="button"
          aria-label="全部书籍"
          title="全部书籍"
          onClick={() => onNavigate("books")}
          aria-current={page === "books" ? "page" : undefined}
        >
          <Books size={20} weight={page === "books" ? "fill" : "regular"} />
          <span>全部书籍</span>
        </button>

        <button
          className={`app-sidebar__item ${page === "collections" ? "app-sidebar__item--active" : ""}`}
          type="button"
          aria-label="我的珍藏"
          title="我的珍藏"
          onClick={() => onNavigate("collections")}
          aria-current={page === "collections" ? "page" : undefined}
        >
          <Stack size={20} weight={page === "collections" ? "fill" : "regular"} />
          <span>我的珍藏</span>
        </button>

        <button
          className={`app-sidebar__item ${page === "uncategorized" ? "app-sidebar__item--active" : ""}`}
          type="button"
          aria-label="未整理"
          title="未整理"
          onClick={() => onNavigate("uncategorized")}
          aria-current={page === "uncategorized" ? "page" : undefined}
        >
          <FolderSimple size={20} weight={page === "uncategorized" ? "fill" : "regular"} />
          <span>未整理</span>
        </button>

        <button
          className={`app-sidebar__item ${page === "scan" ? "app-sidebar__item--active" : ""}`}
          type="button"
          aria-label="扫描书库"
          title="扫描书库"
          onClick={() => onNavigate("scan")}
          aria-current={page === "scan" ? "page" : undefined}
        >
          <MagnifyingGlass size={20} weight={page === "scan" ? "fill" : "regular"} />
          <span>扫描书库</span>
        </button>

      </nav>
      <div className="app-sidebar__poem" aria-hidden="true">Between<br /><em>the pages,</em><br />another world.<ButterflyMark /></div>
      <button
        className={`app-sidebar__settings ${page === "settings" ? "app-sidebar__item--active" : ""}`}
        type="button"
        aria-label="设置"
        title="设置"
        aria-current={page === "settings" ? "page" : undefined}
        onClick={() => onNavigate("settings")}
      ><GearSix size={21} weight={page === "settings" ? "fill" : "regular"} /></button>
    </aside>
  );
}
