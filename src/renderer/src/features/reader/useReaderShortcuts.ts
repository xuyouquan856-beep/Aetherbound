import { useCallback, useEffect } from "react";
import type {
  KeyBinding,
  ReaderCommandId,
  ReaderShortcutProfileV1,
} from "../../../../shared/contracts.js";
import {
  isReaderEditingTarget,
  keyBindingFromEvent,
  resolveReaderCommand,
} from "./reader-shortcuts.js";

type ReaderShortcutOptions = {
  profile: ReaderShortcutProfileV1;
  panelOpen: boolean;
  enabled?: boolean;
  onCommand(command: ReaderCommandId): void;
};

export function useReaderShortcuts({
  profile,
  panelOpen,
  enabled = true,
  onCommand,
}: ReaderShortcutOptions): (binding: KeyBinding) => boolean {
  const dispatchBinding = useCallback((binding: KeyBinding) => {
    if (!enabled) return false;
    const command = resolveReaderCommand(profile, binding);
    if (!command || (panelOpen && !command.startsWith("reader.panel."))) {
      return false;
    }
    onCommand(command);
    return true;
  }, [enabled, onCommand, panelOpen, profile]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isReaderEditingTarget(event.target)) return;
      if (
        event.code === "Space"
        && event.target instanceof Element
        && event.target.closest("button, a[href], [role='button']")
      ) {
        return;
      }
      const binding = keyBindingFromEvent(event);
      if (binding && dispatchBinding(binding)) {
        event.preventDefault();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [dispatchBinding]);

  return dispatchBinding;
}
