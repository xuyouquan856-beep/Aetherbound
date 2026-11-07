import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  DefaultReaderShortcutProfile,
  ReaderCommandIdSchema,
  type KeyBinding,
  type ReaderCommandId,
  type ReaderShortcutProfileV1,
} from "../../../../shared/contracts.js";
import {
  keyBindingFromEvent,
  moveBinding,
  resolveReaderCommand,
} from "./reader-shortcuts.js";

const commandLabels: Record<ReaderCommandId, string> = {
  "reader.page.previous": "上一页",
  "reader.page.next": "下一页",
  "reader.brightness.increase": "提高亮度",
  "reader.brightness.decrease": "降低亮度",
  "reader.panel.toc.toggle": "目录",
  "reader.panel.appearance.toggle": "阅读外观",
  "reader.panel.search.toggle": "书内搜索",
};

const coreCommands = new Set<ReaderCommandId>([
  "reader.page.previous",
  "reader.page.next",
  "reader.panel.appearance.toggle",
]);

type Capture = { command: ReaderCommandId; slot: number };
type Conflict = {
  binding: KeyBinding;
  existing: ReaderCommandId;
  target: Capture;
};

type Props = {
  profile: ReaderShortcutProfileV1;
  onChange(profile: ReaderShortcutProfileV1): void;
};

function codeLabel(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  const labels: Record<string, string> = {
    ArrowLeft: "←",
    ArrowRight: "→",
    ArrowUp: "↑",
    ArrowDown: "↓",
    Space: "空格",
    Enter: "Enter",
    Backspace: "Backspace",
    Delete: "Delete",
    Home: "Home",
    End: "End",
    PageUp: "Page Up",
    PageDown: "Page Down",
  };
  return labels[code] ?? code;
}

export function formatBinding(binding: KeyBinding): string {
  return [
    binding.ctrl ? "Ctrl" : null,
    binding.alt ? "Alt" : null,
    binding.shift ? "Shift" : null,
    binding.meta ? "Meta" : null,
    codeLabel(binding.code),
  ].filter(Boolean).join(" + ");
}

function ordinal(slot: number): string {
  return slot === 0 ? "第一个" : "第二个";
}

export function ShortcutEditor({ profile, onChange }: Props) {
  const [capture, setCapture] = useState<Capture | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const captureRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    captureRef.current?.focus();
  }, [capture]);

  function beginCapture(target: Capture) {
    setCapture(target);
    setConflict(null);
    setMessage(null);
  }

  function applyBinding(target: Capture, binding: KeyBinding) {
    try {
      onChange(moveBinding(profile, target.command, target.slot, binding));
      setCapture(null);
      setConflict(null);
      setMessage(null);
    } catch {
      setMessage("这个修改会让必要操作失去快捷键，请先设置备用键。");
    }
  }

  function captureKey(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (!capture || event.repeat || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();

    if (event.code === "F11") {
      setMessage("F11 保留给全屏，不能修改。");
      return;
    }
    if (event.code === "Escape") {
      setMessage("Escape 保留给关闭面板或退出阅读，不能修改。");
      return;
    }
    if (["ControlLeft", "ControlRight", "AltLeft", "AltRight", "ShiftLeft", "ShiftRight", "MetaLeft", "MetaRight"].includes(event.code)) {
      setMessage("请同时按下一个字母、数字、方向键或功能键。");
      return;
    }

    const binding = keyBindingFromEvent(event.nativeEvent);
    if (!binding) return;
    const existing = resolveReaderCommand(profile, binding);
    if (!existing || existing === capture.command) {
      applyBinding(capture, binding);
      return;
    }
    if (coreCommands.has(existing) && profile.bindings[existing].length === 1) {
      setMessage(`${formatBinding(binding)} 是${commandLabels[existing]}的唯一按键，请先为它设置备用键。`);
      return;
    }
    setConflict({ binding, existing, target: capture });
    setMessage(null);
  }

  return (
    <div className="shortcut-editor">
      <div className="shortcut-editor__list">
        {ReaderCommandIdSchema.options.map((command) => (
          <div className="shortcut-row" key={command}>
            <span>{commandLabels[command]}</span>
            <div className="shortcut-row__bindings">
              {profile.bindings[command].map((binding, slot) => {
                const active = capture?.command === command && capture.slot === slot;
                return (
                  <button
                    type="button"
                    className="shortcut-key"
                    data-reader-shortcut-capture={active ? "true" : undefined}
                    ref={active ? captureRef : undefined}
                    aria-label={`修改${commandLabels[command]}的${ordinal(slot)}按键`}
                    key={`${command}-${slot}`}
                    onClick={() => beginCapture({ command, slot })}
                    onKeyDown={captureKey}
                  >
                    {active ? "请按新按键…" : formatBinding(binding)}
                  </button>
                );
              })}
              {profile.bindings[command].length < 2 && (
                <button
                  type="button"
                  className="shortcut-key shortcut-key--add"
                  data-reader-shortcut-capture={capture?.command === command
                    && capture.slot === profile.bindings[command].length
                    ? "true"
                    : undefined}
                  ref={capture?.command === command
                    && capture.slot === profile.bindings[command].length
                    ? captureRef
                    : undefined}
                  aria-label={`为${commandLabels[command]}添加备用按键`}
                  onClick={() => beginCapture({
                    command,
                    slot: profile.bindings[command].length,
                  })}
                  onKeyDown={captureKey}
                >
                  {capture?.command === command
                    && capture.slot === profile.bindings[command].length
                    ? "请按新按键…"
                    : "＋"}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {conflict && (
        <div className="shortcut-conflict" role="status">
          <p>{formatBinding(conflict.binding)} 已用于{commandLabels[conflict.existing]}</p>
          <div>
            <button
              type="button"
              onClick={() => applyBinding(conflict.target, conflict.binding)}
              aria-label={`将 ${formatBinding(conflict.binding)} 改用于${commandLabels[conflict.target.command]}`}
            >
              改用此键
            </button>
            <button type="button" onClick={() => { setConflict(null); setCapture(null); }}>取消</button>
          </div>
        </div>
      )}
      {message && <p className="shortcut-message" role="status">{message}</p>}
      <button
        type="button"
        className="shortcut-reset"
        onClick={() => {
          onChange(DefaultReaderShortcutProfile);
          setCapture(null);
          setConflict(null);
          setMessage(null);
        }}
      >
        恢复默认快捷键
      </button>
    </div>
  );
}
