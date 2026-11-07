import { useCallback, useEffect, useRef } from "react";
import type { ReaderApi, ReadingLocationV1 } from "../../../../shared/contracts.js";

export function useReadingProgress(api: ReaderApi, bookId: string, sessionId: string) {
  const latest = useRef<ReadingLocationV1 | null>(null);
  const lastSaved = useRef<ReadingLocationV1 | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = useRef<Promise<void> | null>(null);
  const closed = useRef(false);

  const saveLatest = useCallback((): Promise<void> => {
    timer.current = null;
    if (!latest.current || closed.current || latest.current === lastSaved.current) return Promise.resolve();
    if (saving.current) return saving.current;
    const request = (async () => {
      while (!closed.current && latest.current && latest.current !== lastSaved.current) {
        const location = latest.current;
        await api.reader.saveProgress(bookId, sessionId, location);
        lastSaved.current = location;
      }
    })()
      .catch((error) => {
        if (!closed.current && !timer.current) {
          timer.current = setTimeout(() => {
            void saveLatest().catch(() => undefined);
          }, 2_000);
        }
        throw error;
      })
      .finally(() => {
        if (saving.current === request) saving.current = null;
      });
    saving.current = request;
    return request;
  }, [api, bookId, sessionId]);

  const queue = useCallback((location: ReadingLocationV1) => {
    latest.current = location;
    if (timer.current || closed.current) return;
    timer.current = setTimeout(() => {
      void saveLatest().catch(() => undefined);
    }, 700);
  }, [saveLatest]);

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    await saveLatest();
  }, [saveLatest]);

  const close = useCallback(async () => {
    if (closed.current) return;
    closed.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    try {
      await api.reader.closeSession(bookId, sessionId, latest.current);
    } catch (error) {
      closed.current = false;
      throw error;
    }
  }, [api, bookId, sessionId]);

  useEffect(() => () => { void close().catch(() => undefined); }, [close]);

  return { queue, flush, close };
}
