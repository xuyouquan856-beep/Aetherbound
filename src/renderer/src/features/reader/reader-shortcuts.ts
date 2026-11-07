import {
  ReaderCommandIdSchema,
  ReaderShortcutProfileSchema,
  type KeyBinding,
  type ReaderCommandId,
  type ReaderShortcutProfileV1,
} from "../../../../shared/contracts.js";

export function bindingSignature(binding: KeyBinding): string {
  return `${binding.ctrl}:${binding.alt}:${binding.shift}:${binding.meta}:${binding.code}`;
}

export function keyBindingFromEvent(event: KeyboardEvent): KeyBinding | null {
  if (event.isComposing || event.repeat || event.code === "Escape" || event.code === "F11") {
    return null;
  }
  return {
    code: event.code,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    meta: event.metaKey,
  };
}

export function isReaderEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest("input, textarea, select, dialog[open], [data-reader-shortcut-capture]")) return true;

  for (let element: Element | null = target; element; element = element.parentElement) {
    if (
      (element instanceof HTMLElement && (element.isContentEditable || element.contentEditable === "true"))
      || (element.hasAttribute("contenteditable") && element.getAttribute("contenteditable") !== "false")
    ) {
      return true;
    }
  }
  return false;
}

export function resolveReaderCommand(
  profile: ReaderShortcutProfileV1,
  binding: KeyBinding,
): ReaderCommandId | null {
  const signature = bindingSignature(binding);
  for (const command of ReaderCommandIdSchema.options) {
    if (profile.bindings[command].some((candidate) => bindingSignature(candidate) === signature)) {
      return command;
    }
  }
  if (!binding.ctrl && !binding.alt && !binding.meta) {
    if (binding.code === "PageDown" && !binding.shift) return "reader.page.next";
    if (binding.code === "PageUp" && !binding.shift) return "reader.page.previous";
    if (binding.code === "Space") {
      return binding.shift ? "reader.page.previous" : "reader.page.next";
    }
  }
  return null;
}

export function moveBinding(
  profile: ReaderShortcutProfileV1,
  targetCommand: ReaderCommandId,
  targetSlot: number,
  binding: KeyBinding,
): ReaderShortcutProfileV1 {
  if (!Number.isInteger(targetSlot) || targetSlot < 0 || targetSlot > 1) {
    throw new RangeError("Reader shortcut slot must be 0 or 1");
  }

  const signature = bindingSignature(binding);
  const bindings = Object.fromEntries(ReaderCommandIdSchema.options.map((command) => [
    command,
    profile.bindings[command]
      .filter((candidate) => bindingSignature(candidate) !== signature)
      .map((candidate) => ({ ...candidate })),
  ])) as ReaderShortcutProfileV1["bindings"];

  const targetBindings = bindings[targetCommand];
  if (targetSlot >= targetBindings.length) {
    targetBindings.push({ ...binding });
  } else {
    targetBindings[targetSlot] = { ...binding };
  }

  return ReaderShortcutProfileSchema.parse({
    shortcutVersion: 1,
    bindings,
  });
}
