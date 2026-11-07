import { useCallback, useEffect, useState } from "react";
import {
  ReadingAppearanceSchema,
  type ReaderApi,
  type ReaderShortcutProfileV1,
  type ReadingAppearance,
} from "../../../../shared/contracts.js";
import { useDeferredAppearance } from "./useDeferredAppearance.js";
import { useReadingProgress } from "./useReadingProgress.js";

const BOOK_APPEARANCE_PREFIX = "aetherbound.reader.bookAppearance.";

export function readBookAppearanceOverride(bookId: string): ReadingAppearance | null {
  try {
    const raw = window.localStorage.getItem(`${BOOK_APPEARANCE_PREFIX}${bookId}`);
    if (!raw) return null;
    const parsed = ReadingAppearanceSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function writeBookAppearanceOverride(bookId: string, value: ReadingAppearance | null) {
  try {
    const key = `${BOOK_APPEARANCE_PREFIX}${bookId}`;
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage quota or private mode errors.
  }
}

type Options = {
  api: ReaderApi; bookId: string; sessionId: string; appearance: ReadingAppearance;
  onAppearanceChange(next: ReadingAppearance): void;
  onShortcutsChange(next: ReaderShortcutProfileV1): void;
  onSuspend?(): void; onBack(): void;
};

/** Both renditions share persistence and exit behavior; only layout remains format-specific. */
export function useReaderPreferences({ api, bookId, sessionId, appearance, onAppearanceChange, onShortcutsChange, onSuspend, onBack }: Options) {
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [bookOverride, setBookOverride] = useState<ReadingAppearance | null>(() => readBookAppearanceOverride(bookId));
  useEffect(() => {
    setBookOverride(readBookAppearanceOverride(bookId));
  }, [bookId]);

  const hasBookOverride = bookOverride !== null;
  const activeAppearance = bookOverride ?? appearance;
  const { queue, flush } = useReadingProgress(api, bookId, sessionId);

  const persistAppearance = useCallback(async (next: ReadingAppearance) => {
    if (readBookAppearanceOverride(bookId) !== null) {
      writeBookAppearanceOverride(bookId, next);
      setBookOverride(next);
      setSettingsError(null);
      return;
    }
    try { onAppearanceChange(await api.settings.updateAppearance(next)); setSettingsError(null); }
    catch { setSettingsError("阅读外观暂未保存，本次阅读仍可继续使用。"); }
  }, [api, bookId, onAppearanceChange]);

  const { draft: visibleAppearance, layout: layoutAppearance, update: updateAppearance, flush: flushAppearance } = useDeferredAppearance(activeAppearance, persistAppearance);

  const setBookOverrideEnabled = useCallback((enabled: boolean) => {
    if (enabled) {
      writeBookAppearanceOverride(bookId, visibleAppearance);
      setBookOverride(visibleAppearance);
    } else {
      writeBookAppearanceOverride(bookId, null);
      setBookOverride(null);
    }
    setSettingsError(null);
  }, [bookId, visibleAppearance]);

  const leaveReader = useCallback(async () => {
    try { await flushAppearance(); await flush(); }
    catch { setSettingsError("阅读进度未保存，请重试返回；当前阅读位置仍已保留。"); return; }
    if (onSuspend) onSuspend(); else onBack();
  }, [flush, flushAppearance, onBack, onSuspend]);

  const updateShortcuts = useCallback(async (next: ReaderShortcutProfileV1) => {
    try { onShortcutsChange(await api.settings.updateShortcuts(next)); setSettingsError(null); }
    catch { setSettingsError("快捷键暂未保存，请重试。"); }
  }, [api, onShortcutsChange]);

  return {
    queue,
    visibleAppearance,
    layoutAppearance,
    updateAppearance,
    hasBookOverride,
    setBookOverrideEnabled,
    leaveReader,
    updateShortcuts,
    settingsError,
  };
}
