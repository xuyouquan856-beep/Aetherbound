import { usePageTransition } from "./usePageTransition.js";
import { HomeImportContext } from "./HomeImportContext.js";
import { useLayoutEffect, useRef, useState, type ReactNode, type UIEvent } from "react";
import type { BookSummary, ReaderShortcutProfileV1, ReadingAppearance } from "../../../../shared/contracts.js";
import { CommandBar } from "./CommandBar.js";
import { Sidebar } from "./Sidebar.js";
import { LivingSky } from "../library/LivingSky.js";
import { LibrarySettings } from "./LibrarySettings.js";

export type AppPage = "home" | "books" | "collections" | "uncategorized" | "scan" | "settings";

type AppShellProps = {
  page: AppPage;
  viewKey?: string;
  scrollFrozen?: boolean;
  books: BookSummary[];
  settingsSubpage?: "quotes" | "reading" | null;
  onSettingsSubpageChange?(subpage: "quotes" | "reading" | null): void;
  appearance?: ReadingAppearance;
  onAppearanceChange?(next: ReadingAppearance): void;
  shortcuts?: ReaderShortcutProfileV1;
  onShortcutsChange?(next: ReaderShortcutProfileV1): void;
  search?: {
    query: string;
    placeholder: string;
    label: string;
    onChange(value: string): void;
  };
  busy: boolean;
  onNavigate(next: AppPage): void;
  onImportFiles(): void;
  onImportFolder(): void;
  onImportOrganizedFolder(): void;
  children: ReactNode;
};

export function AppShell({
  page,
  books,
  settingsSubpage = null,
  onSettingsSubpageChange,
  appearance,
  onAppearanceChange,
  shortcuts,
  onShortcutsChange,
  viewKey = page,
  scrollFrozen = false,
  search,
  busy,
  onNavigate,
  onImportFiles,
  onImportFolder,
  onImportOrganizedFolder,
  children,
}: AppShellProps) {
  const pageRef = useRef<HTMLElement>(null);
  const scrollPositions = useRef(new Map<string, number>());
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem("aetherbound.library.collapsed") === "on"; } catch { return false; }
  });
  const [motionEnabled, setMotionEnabled] = useState(() => {
    try {
      const stored = window.localStorage.getItem("aetherbound.library.motion");
      if (stored === "on") return true;
      if (stored === "off") return false;
    } catch { /* localStorage can be unavailable in embedded/test contexts */ }
    return !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  });

  useLayoutEffect(() => {
    if (!scrollFrozen && pageRef.current) {
      pageRef.current.scrollTop = scrollPositions.current.get(viewKey) ?? 0;
    }
  }, [viewKey, scrollFrozen]);

  usePageTransition(pageRef, viewKey, scrollFrozen);

  function rememberScroll(event: UIEvent<HTMLElement>) {
    if (scrollFrozen) return;
    scrollPositions.current.set(viewKey, event.currentTarget.scrollTop);
  }

  const toolbar = (<CommandBar
          search={search}
          busy={busy}
          onImportFiles={onImportFiles}
          onImportFolder={onImportFolder}
          onImportOrganizedFolder={onImportOrganizedFolder}
        />);
  return (
    <HomeImportContext.Provider value={toolbar}>
    <div className={`app-shell app-shell--${page}`} data-page={page} data-collapsed={collapsed} data-motion={motionEnabled && !scrollFrozen ? "on" : "off"}>
      <Sidebar
        page={page}
        onNavigate={onNavigate}
      />
      <div className="app-shell__workspace">
        <LivingSky active={motionEnabled && !scrollFrozen} />
        {page !== "home" && toolbar}
        <main className="app-shell__page" ref={pageRef} onScroll={rememberScroll}>{page === "settings" ? <LibrarySettings
          books={books}
          motion={motionEnabled}
          collapsed={collapsed}
          initialSubpage={settingsSubpage}
          onSubpageChange={onSettingsSubpageChange}
          appearance={appearance}
          onAppearanceChange={onAppearanceChange}
          shortcuts={shortcuts}
          onShortcutsChange={onShortcutsChange}
          onMotion={() => {
            const next = !motionEnabled;
            setMotionEnabled(next);
            try { localStorage.setItem("aetherbound.library.motion", next ? "on" : "off"); } catch { /* best effort */ }
          }}
          onCollapsed={() => {
            const next = !collapsed;
            setCollapsed(next);
            try { localStorage.setItem("aetherbound.library.collapsed", next ? "on" : "off"); } catch { /* best effort */ }
          }}
        >{children}</LibrarySettings> : children}</main>
      </div>
    </div>
    </HomeImportContext.Provider>
  );
}
