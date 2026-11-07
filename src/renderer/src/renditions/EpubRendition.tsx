import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type {
  EpubReadingLocationV1,
  ReadingLocationV1,
  KeyBinding,
  PublicationView,
  ReadingAppearance,
} from "../../../shared/contracts.js";
import {
  EPUB_RUNNER_ORIGIN,
  EPUB_RUNNER_VERSION,
  parseEpubRunnerEvent,
  type EpubRunnerCommandPayload,
  type EpubRunnerIdentity,
  type EpubRunnerPhase,
} from "../epub-runner/protocol.js";
import type { ReaderMark, ReaderSearchResult, ReaderSelection } from "./reading-tools.js";

export type EpubRenditionHandle = {
  next(): void;
  previous(): void;
  navigate(href: string): void;
  applyLayout(appearance: ReadingAppearance): void;
  historyBack(): void;
  historyForward(): void;
  navigateLocation(location: ReadingLocationV1): void;
  clearSelection(): void;
  search(query: string): Promise<ReaderSearchResult[]>;
  setMarks(marks: ReaderMark[]): void;
};

type Props = {
  publication: PublicationView;
  publicationBytes: Uint8Array;
  appearance: ReadingAppearance;
  restoreLocation: EpubReadingLocationV1 | null;
  onLocation(location: EpubReadingLocationV1): void;
  onReady?(): void;
  onPhase?(phase: EpubRunnerPhase): void;
  onError?(message: string): void;
  onKeystroke?(binding: KeyBinding): void;
  onHistoryState?(state: { canGoBack: boolean; canGoForward: boolean }): void;
  nonce?: string;
  onSelection?(selection: ReaderSelection | null): void;
  onContentClick?(): void;
  onMarkClick?(id: string): void;
};

function createNonce() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

export const EpubRendition = forwardRef<EpubRenditionHandle, Props>(function EpubRendition({
  publication, publicationBytes, appearance, restoreLocation, onLocation, onReady, onPhase, onError, onKeystroke,
  onHistoryState, nonce: suppliedNonce,
  onSelection, onContentClick, onMarkClick,
}, forwardedRef) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const nonceRef = useRef(suppliedNonce ?? createNonce());
  const readyRef = useRef(false);
  const layoutTransactionRef = useRef(0);
  const latestLayoutRef = useRef(0);
  const activeLayoutRef = useRef<number | null>(null);
  const layoutStartedRef = useRef(false);
  const callbacksRef = useRef({ onLocation, onReady, onPhase, onError, onKeystroke, onHistoryState, onSelection, onContentClick, onMarkClick });
  callbacksRef.current = { onLocation, onReady, onPhase, onError, onKeystroke, onHistoryState, onSelection, onContentClick, onMarkClick };
  const requestIdRef = useRef(0);
  const pendingSearchRef = useRef<Map<number, (results: ReaderSearchResult[]) => void>>(new Map());
  const [ready, setReady] = useState(false);
  const identity = useMemo<EpubRunnerIdentity>(() => ({
    version: EPUB_RUNNER_VERSION,
    bookId: publication.bookId,
    sourceRevision: publication.sourceRevision,
    nonce: nonceRef.current,
  }), [publication.bookId, publication.sourceRevision]);

  const post = (
    command: EpubRunnerCommandPayload,
    transfer: Transferable[] = [],
  ) => {
    const contentWindow = frameRef.current?.contentWindow;
    if (!contentWindow) return;
    const message = { channel: "reader-epub-command", ...identity, ...command };
    if (transfer.length > 0) {
      contentWindow.postMessage(message, EPUB_RUNNER_ORIGIN, transfer);
      return;
    }
    contentWindow.postMessage(message, EPUB_RUNNER_ORIGIN);
  };

  const postLayout = (nextAppearance: ReadingAppearance) => {
    if (!readyRef.current) return;
    const transactionId = ++layoutTransactionRef.current;
    latestLayoutRef.current = transactionId;
    activeLayoutRef.current = transactionId;
    post({ command: "applyLayout", appearance: nextAppearance, transactionId });
  };

  useImperativeHandle(forwardedRef, () => ({
    next: () => { if (readyRef.current) post({ command: "next" }); },
    previous: () => { if (readyRef.current) post({ command: "previous" }); },
    navigate: (href) => { if (readyRef.current) post({ command: "navigate", href }); },
    applyLayout: postLayout,
    historyBack: () => { if (readyRef.current) post({ command: "historyBack" }); },
    historyForward: () => { if (readyRef.current) post({ command: "historyForward" }); },
    navigateLocation: (location) => { if (readyRef.current && location.format === "epub") post({ command: "navigateLocation", location }); },
    clearSelection: () => { if (readyRef.current) post({ command: "clearSelection" }); },
    search: (query) => new Promise((resolve) => {
      const normalized = query.trim().slice(0, 500);
      if (!readyRef.current || !normalized) { resolve([]); return; }
      for (const pending of pendingSearchRef.current.values()) pending([]);
      pendingSearchRef.current.clear();
      const requestId = ++requestIdRef.current;
      pendingSearchRef.current.set(requestId, resolve);
      post({ command: "search", query: normalized, requestId });
    }),
    setMarks: (marks) => { if (readyRef.current) post({ command: "setMarks", marks: marks.flatMap((mark) => mark.location.format === "epub" ? [{
      id: mark.id, color: mark.color, location: mark.location,
      endLocation: mark.endLocation?.format === "epub" ? mark.endLocation : undefined,
    }] : []) }); },
  }));

  useEffect(() => {
    const frame = frameRef.current;
    function onMessage(event: MessageEvent) {
      if (event.origin !== EPUB_RUNNER_ORIGIN || event.source !== frame?.contentWindow) return;
      const message = parseEpubRunnerEvent(event.data, identity);
      if (message?.event === "ready") {
        const firstReady = !readyRef.current;
        readyRef.current = true;
        setReady(true);
        if (firstReady) callbacksRef.current.onReady?.();
      }
      if (message?.event === "phase") callbacksRef.current.onPhase?.(message.phase);
      if (message?.event === "layout-started"
        && message.transactionId === latestLayoutRef.current) {
        layoutStartedRef.current = true;
        activeLayoutRef.current = message.transactionId;
      }
      if (message?.event === "relocated"
        && readyRef.current
        && (!layoutStartedRef.current || activeLayoutRef.current === null)) {
        callbacksRef.current.onLocation(message.location);
      }
      if (message?.event === "layout-settled"
        && readyRef.current
        && message.transactionId === latestLayoutRef.current) {
        activeLayoutRef.current = null;
        layoutStartedRef.current = false;
        callbacksRef.current.onLocation(message.location);
      }
      if (message?.event === "history-state" && readyRef.current) {
        callbacksRef.current.onHistoryState?.({
          canGoBack: message.canGoBack,
          canGoForward: message.canGoForward,
        });
      }
      if (message?.event === "keystroke" && readyRef.current) callbacksRef.current.onKeystroke?.(message.binding);
      if (message?.event === "selection" && readyRef.current) {
        const rect = frame?.getBoundingClientRect();
        callbacksRef.current.onSelection?.(message.selection ? { ...message.selection, rect: {
          ...message.selection.rect,
          x: message.selection.rect.x + (rect?.left ?? 0), y: message.selection.rect.y + (rect?.top ?? 0),
        } } : null);
      }
      if (message?.event === "content-click" && readyRef.current) callbacksRef.current.onContentClick?.();
      if (message?.event === "mark-click" && readyRef.current) callbacksRef.current.onMarkClick?.(message.id);
      if (message?.event === "search-results" && readyRef.current) {
        pendingSearchRef.current.get(message.requestId)?.(message.results);
        pendingSearchRef.current.delete(message.requestId);
      }
      if (message?.event === "error") {
        activeLayoutRef.current = null;
        callbacksRef.current.onError?.(message.message);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [identity]);

  useEffect(() => {
    postLayout(appearance);
  }, [appearance]);

  useEffect(() => {
    readyRef.current = false;
    for (const pending of pendingSearchRef.current.values()) pending([]);
    pendingSearchRef.current.clear();
    layoutTransactionRef.current = 0;
    latestLayoutRef.current = 0;
    activeLayoutRef.current = null;
    layoutStartedRef.current = false;
    setReady(false);
  }, [identity]);

  useEffect(() => () => {
    for (const pending of pendingSearchRef.current.values()) pending([]);
    pendingSearchRef.current.clear();
    post({ command: "dispose" });
  }, []);

  const params = new URLSearchParams({
    bookId: publication.bookId,
    sourceRevision: publication.sourceRevision,
    nonce: identity.nonce,
    hostOrigin: location.origin,
  });
  return <iframe
    className="epub-rendition-frame"
    data-ready={String(ready)}
    aria-busy={!ready}
    ref={frameRef}
    title="EPUB 正文"
    src={`${EPUB_RUNNER_ORIGIN}/epub-runner.html?${params}`}
    onLoad={() => {
      readyRef.current = false;
      setReady(false);
      const bytes = exactArrayBuffer(publicationBytes);
      post({
        command: "open",
        bytes,
        appearance,
        restoreLocation,
        spine: publication.spine,
      }, [bytes]);
    }}
  />;
});
