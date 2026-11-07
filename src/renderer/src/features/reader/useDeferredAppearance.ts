import { useCallback, useEffect, useRef, useState } from "react";
import type { ReadingAppearance } from "../../../../shared/contracts.js";

export function useDeferredAppearance(
  value: ReadingAppearance,
  onCommit: (value: ReadingAppearance) => Promise<void> | void,
  delay = 100,
) {
  const [draft, setDraft] = useState(value);
  const [layout, setLayout] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef<ReadingAppearance | null>(null);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  useEffect(() => {
    if (!timer.current && !latest.current) {
      setDraft(value);
      setLayout(value);
    }
  }, [value]);

  const commit = useCallback((next: ReadingAppearance) => {
    setLayout(next);
    void Promise.resolve(commitRef.current(next)).catch(() => undefined);
  }, []);

  const update = useCallback((next: ReadingAppearance) => {
    setDraft(next);
    latest.current = next;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      const pending = latest.current;
      latest.current = null;
      if (pending) commit(pending);
    }, delay);
  }, [commit, delay]);

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const pending = latest.current;
    latest.current = null;
    if (!pending) return;
    setLayout(pending);
    await commitRef.current(pending);
  }, []);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const pending = latest.current;
    latest.current = null;
    if (pending) void Promise.resolve(commitRef.current(pending)).catch(() => undefined);
  }, []);

  return { draft, layout, update, flush };
}
