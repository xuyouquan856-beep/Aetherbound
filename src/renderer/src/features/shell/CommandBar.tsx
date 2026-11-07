import { TransitionPresence } from "./TransitionPresence.js";
import { CaretDown, FilePlus, FolderPlus, MagnifyingGlass, Plus } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";

type CommandBarProps = {
  search?: {
    query: string;
    placeholder: string;
    label: string;
    onChange(value: string): void;
  };
  busy: boolean;
  onImportFiles(): void;
  onImportFolder(): void;
  onImportOrganizedFolder(): void;
};

export function CommandBar({
  search,
  busy,
  onImportFiles,
  onImportFolder,
  onImportOrganizedFolder,
}: CommandBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    if (menuOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("keydown", handleKeyDown);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  return (
    <header className="command-bar">
      {search && <div className="command-bar__search">
        <MagnifyingGlass size={18} className="command-bar__search-icon" aria-hidden="true" />
        <input
          type="search"
          className="command-bar__search-input"
          placeholder={search.placeholder}
          aria-label={search.label}
          value={search.query}
          onChange={(event) => search.onChange(event.target.value)}
        />
      </div>}

      <div className="command-bar__actions" ref={menuRef}>
        <div className="dropdown">
          <button
            className="button button--primary command-bar__import-trigger"
            type="button"
            onClick={() => setMenuOpen(!menuOpen)}
            disabled={busy}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
          >
            <Plus size={18} weight="bold" />
            <span>导入</span>
            <CaretDown size={14} />
          </button>

          <TransitionPresence kind="menu">{menuOpen && (
            <div className="dropdown-menu" role="menu" aria-label="导入菜单">
              <button
                className="dropdown-item"
                role="menuitem"
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onImportFiles();
                }}
              >
                <FilePlus size={18} />
                <span>导入书籍文件</span>
              </button>
              <button
                className="dropdown-item"
                role="menuitem"
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onImportFolder();
                }}
              >
                <FolderPlus size={18} />
                <span>导入文件夹为珍藏</span>
              </button>
              <button
                className="dropdown-item"
                role="menuitem"
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onImportOrganizedFolder();
                }}
              >
                <FolderPlus size={18} />
                <span>按子文件夹整理导入</span>
              </button>
            </div>
          )}</TransitionPresence>
        </div>
      </div>
    </header>
  );
}
