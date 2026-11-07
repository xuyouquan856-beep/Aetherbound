import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type {
  BookDetails,
  ChapterContent,
  EpubBookDetails,
  EpubReadingLocationV1,
  KeyBinding,
  ReaderApi,
  ReaderCommandId,
  ReaderShortcutProfileV1,
  ReadingAppearance,
  ReadingLocationV1,
  TocNode,
  TxtBookDetails,
  TxtReadingLocationV1,
} from "../../../../shared/contracts.js";
import { isTxtBookDetails } from "../../../../shared/contracts.js";
import { InlineNotice } from "../../components/InlineNotice.js";
import { describeReaderError, type ReaderNoticeModel } from "../../errors/public-error.js";
import { EpubRendition, type EpubRenditionHandle } from "../../renditions/EpubRendition.js";
import type { EpubRunnerPhase } from "../../epub-runner/protocol.js";
import { TxtRendition, type TxtRenditionHandle } from "../../renditions/TxtRendition.js";
import { AppearancePanel } from "./AppearancePanel.js";
import { ChapterSidebar } from "./ChapterSidebar.js";
import { EpubImageGalleryPanel } from "./EpubImageGalleryPanel.js";
import { isReaderEditingTarget } from "./reader-shortcuts.js";
import { ReaderHintLayer } from "./ReaderHintLayer.js";
import { useReaderShortcuts } from "./useReaderShortcuts.js";
import { useReaderPreferences } from "./useReaderPreferences.js";

import { useReaderWorkspace } from "./useReaderWorkspace.js";
import { ReaderTools } from "./ReaderTools.js";
import { searchTxtBook } from "./reader-book-search.js";

type Props = {
  api: ReaderApi;
  details: BookDetails;
  appearance: ReadingAppearance;
  shortcuts: ReaderShortcutProfileV1;
  onAppearanceChange(next: ReadingAppearance): void;
  onShortcutsChange(next: ReaderShortcutProfileV1): void;
  active?: boolean;
  onReady?(): void;
  onOpenPhase?(phase: "rendition-mounted" | EpubRunnerPhase): void;
  onSuspend?(): void;
  onBack(): void;
  initialLocation?: ReadingLocationV1 | null;
  onLocationConsumed?(): void;
  initialSearchTarget?: { query: string; unitIndex: number } | null;
  onSearchTargetConsumed?(): void;
};

export function ReaderView(props: Props) {
  const onOpenPhaseRef = useRef<Props["onOpenPhase"]>(props.onOpenPhase);
  onOpenPhaseRef.current = props.onOpenPhase;
  useEffect(() => {
    onOpenPhaseRef.current?.("rendition-mounted");
  }, []);
  return isTxtBookDetails(props.details)
    ? <TxtReaderView {...props} details={props.details} />
    : <EpubReaderView {...props} details={props.details} />;
}

function brightnessStyle(appearance: ReadingAppearance): CSSProperties {
  return {
    "--reader-dim": String((100 - appearance.brightness) / 100),
  } as CSSProperties;
}

function nextBrightness(appearance: ReadingAppearance, direction: 1 | -1): ReadingAppearance {
  return {
    ...appearance,
    brightness: Math.max(30, Math.min(100, appearance.brightness + direction * 5)),
  };
}

function TxtReaderView({
  api,
  details,
  appearance,
  shortcuts,
  onAppearanceChange,
  onShortcutsChange,
  active = true,
  onReady,
  onSuspend,
  onBack,
  initialLocation,
  onLocationConsumed,
  initialSearchTarget,
  onSearchTargetConsumed,
}: Omit<Props, "details"> & { details: TxtBookDetails }) {
  const rendition = useRef<TxtRenditionHandle>(null);
  const requestedLocation = initialLocation?.format === "txt" && initialLocation.sourceRevision === details.sourceRevision ? initialLocation : details.savedLocation;
  const [targetLocation, setTargetLocation] = useState<TxtReadingLocationV1 | null>(requestedLocation);
  const searchChapterId = initialSearchTarget ? details.chapters[initialSearchTarget.unitIndex]?.id : undefined;
  const initialId = searchChapterId
    ?? (requestedLocation
      && details.chapters.some((item) => item.id === requestedLocation?.primary.chapterId)
      ? requestedLocation.primary.chapterId
      : details.chapters[0]?.id);
  const [chapterId, setChapterId] = useState(initialId);
  const [content, setContent] = useState<ChapterContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [initialEdge, setInitialEdge] = useState<"start" | "end">("start");
  const [progress, setProgress] = useState<number | undefined>(details.savedLocation?.progression.total);
  const { queue, visibleAppearance, layoutAppearance, hasBookOverride, setBookOverrideEnabled, updateAppearance, leaveReader, updateShortcuts, settingsError } = useReaderPreferences({
    api, bookId: details.book.id, sessionId: details.sessionId, appearance, onAppearanceChange, onShortcutsChange, onSuspend, onBack,
  });
  const tools = useReaderWorkspace({ api, book: details.book, sourceRevision: details.sourceRevision, active,
    navigate: location => {
      if (location.format !== "txt") return;
      setTargetLocation(location);
      if (location.primary.chapterId === chapterId) rendition.current?.navigateLocation(location);
      else { setInitialEdge("start"); setChapterId(location.primary.chapterId); }
    },
    clearSelection: () => rendition.current?.clearSelection(),
    setMarks: marks => rendition.current?.setMarks(marks),
    search: (query, isCurrent) => searchTxtBook(details.book.id, details.chapters, api.reader.getChapter, query, isCurrent),
  });
  const { panel: openPanel, setPanel: setOpenPanel } = tools;
  useEffect(() => {
    if (!initialLocation) return;
    tools.jump(initialLocation);
    onLocationConsumed?.();
  }, [initialLocation, onLocationConsumed, tools.jump]);
  useEffect(() => {
    if (!initialSearchTarget) return;
    const preferredChapterId = details.chapters[initialSearchTarget.unitIndex]?.id;
    void tools.searchAndJump(initialSearchTarget.query, preferredChapterId);
    onSearchTargetConsumed?.();
  }, [details.chapters, initialSearchTarget, onSearchTargetConsumed, tools.searchAndJump]);
  const handleReady = useCallback(() => { tools.applyMarks(); onReady?.(); }, [tools.applyMarks, onReady]);

  const chapterIndex = useMemo(
    () => details.chapters.findIndex((chapter) => chapter.id === chapterId),
    [chapterId, details.chapters],
  );

  useEffect(() => {
    if (!chapterId) return;
    let current = true;
    setContent(null);
    setError(null);
    api.reader.getChapter(details.book.id, chapterId)
      .then((next) => current && setContent(next))
      .catch(() => current && setError("这一章暂时无法载入。"));
    return () => { current = false; };
  }, [api, chapterId, details.book.id]);

  const moveAcrossBoundary = useCallback((direction: -1 | 1) => {
    const next = details.chapters[chapterIndex + direction];
    if (next) {
      setInitialEdge(direction > 0 ? "start" : "end");
      setChapterId(next.id);
    }
  }, [chapterIndex, details.chapters]);

  const handleEscape = useCallback(() => {
    if (tools.selection) tools.clearSelection();
    else if (openPanel) setOpenPanel(null);
    else if (tools.toolbarOpen) tools.setToolbarOpen(false);
    else void leaveReader();
  }, [leaveReader, openPanel, tools.selection, tools.clearSelection, tools.toolbarOpen, tools.setToolbarOpen, setOpenPanel]);

  const handleCommand = useCallback((command: ReaderCommandId) => {
    if (command === "reader.page.previous") rendition.current?.previousPage();
    if (command === "reader.page.next") rendition.current?.nextPage();
    if (command === "reader.panel.toc.toggle") {
      setOpenPanel((current) => current === "toc" ? null : "toc");
    }
    if (command === "reader.panel.appearance.toggle") {
      setOpenPanel((current) => current === "appearance" ? null : "appearance");
    }
    if (command === "reader.panel.search.toggle") {
      setOpenPanel((current) => current === "search" ? null : "search");
    }
    if (command === "reader.brightness.increase") {
      updateAppearance(nextBrightness(visibleAppearance, 1));
    }
    if (command === "reader.brightness.decrease") {
      updateAppearance(nextBrightness(visibleAppearance, -1));
    }
  }, [setOpenPanel, updateAppearance, visibleAppearance]);

  useReaderShortcuts({
    profile: shortcuts,
    panelOpen: openPanel !== null,
    enabled: active && !tools.selection,
    onCommand: handleCommand,
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!active || event.code !== "Escape" || isReaderEditingTarget(event.target)) return;
      event.preventDefault();
      handleEscape();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, handleEscape]);

  const handleLocation = useCallback((location: TxtReadingLocationV1) => {
    setProgress(location.progression.total);
    tools.onLocation(location);
    queue(location);
  }, [queue, tools.onLocation]);

  const chapterTitle = content?.chapter.title ?? "正在载入";
  const nextChapterTitle = chapterIndex >= 0 ? (details.chapters[chapterIndex + 1]?.title ?? null) : null;
  const previousPage = () => rendition.current?.previousPage();
  const nextPage = () => rendition.current?.nextPage();
  const handleSeekProgression = useCallback((ratio: number) => {
    if (!details.chapters.length) return;
    const index = Math.min(details.chapters.length - 1, Math.max(0, Math.floor(ratio * details.chapters.length)));
    const target = details.chapters[index];
    if (target) {
      setInitialEdge("start");
      setTargetLocation(null);
      setChapterId(target.id);
    }
  }, [details.chapters]);

  return (
    <main className="reader-shell" data-panel-open={openPanel ?? "none"}>
      <section className="reader-stage">
        {error
          ? <div className="reader-message" role="alert">{error}</div>
          : content
            ? <>
                <h1 className="reader-chapter-sr">{content.chapter.title}</h1>
                <TxtRendition
                  ref={rendition}
                  content={content}
                  appearance={layoutAppearance}
                  restoreLocation={content.chapter.id === targetLocation?.primary.chapterId
                    ? targetLocation
                    : null}
                  chapterCount={details.chapters.length}
                  nextChapterTitle={nextChapterTitle}
                  onLocation={handleLocation}
                  onReady={handleReady}
                  onSelection={tools.setSelection}
                  onContentClick={tools.toggleToolbar}
                  onMarkClick={tools.onMarkClick}
                  onBoundary={moveAcrossBoundary}
                  initialEdge={initialEdge}
                />
              </>
            : <div className="reader-message" aria-label="正在载入章节">正在载入章节</div>}
      </section>
      <div
        className="reader-brightness-layer"
        data-testid="reader-brightness"
        style={brightnessStyle(visibleAppearance)}
      />
      <ReaderHintLayer
        chapter={chapterTitle}
        progression={progress}
        blocked={!active || openPanel !== null || !!tools.selection}
        onPrevious={previousPage}
        onNext={nextPage}
        onSeekProgression={handleSeekProgression}
      />
      <ReaderTools tools={tools} title={details.book.title} author={details.book.author} chapter={chapterTitle} onBack={() => void leaveReader()} saveError={settingsError} />
      <ChapterSidebar
        chapters={details.chapters}
        activeId={chapterId}
        open={openPanel === "toc"}
        onSelect={(id) => {
          setInitialEdge("start");
          setTargetLocation(null);
          setChapterId(id);
          setOpenPanel(null);
        }}
        onClose={() => setOpenPanel(null)}
      />
      <AppearancePanel
        appearance={visibleAppearance}
        open={openPanel === "appearance"}
        onChange={updateAppearance}
        onClose={() => setOpenPanel(null)}
        hasBookOverride={hasBookOverride}
        onBookOverrideChange={setBookOverrideEnabled}
        shortcuts={shortcuts}
        onShortcutsChange={(next) => void updateShortcuts(next)}
        saveError={settingsError}
      />
    </main>
  );
}

function flattenToc(
  nodes: TocNode[],
  depth = 0,
): Array<{ id: string; title: string; index: number; depth: number; startOffset: number; endOffset: number }> {
  const result: Array<{ id: string; title: string; index: number; depth: number; startOffset: number; endOffset: number }> = [];
  for (const node of nodes) {
    result.push({
      id: node.href,
      title: node.label,
      depth,
      index: result.length,
      startOffset: 0,
      endOffset: 0,
    });
    result.push(...flattenToc(node.children, depth + 1));
  }
  return result.map((item, index) => ({ ...item, index }));
}

function EpubReaderView({
  api,
  details,
  appearance,
  shortcuts,
  onAppearanceChange,
  onShortcutsChange,
  active = true,
  onReady,
  onOpenPhase,
  onSuspend,
  onBack,
  initialLocation,
  onLocationConsumed,
  initialSearchTarget,
  onSearchTargetConsumed,
}: Omit<Props, "details"> & { details: EpubBookDetails }) {
  const rendition = useRef<EpubRenditionHandle>(null);
  const chapters = useMemo(() => flattenToc(details.publication.toc), [details.publication.toc]);
  const [activeHref, setActiveHref] = useState(
    details.savedLocation?.primary.spineHref ?? chapters[0]?.id ?? "",
  );
  const [error, setError] = useState<ReaderNoticeModel | null>(null);
  const [publicationBytes, setPublicationBytes] = useState<Uint8Array | null>(null);
  const [progress, setProgress] = useState<number | undefined>(details.savedLocation?.progression.total);
  const [historyState, setHistoryState] = useState({ canGoBack: false, canGoForward: false });
  const { queue, visibleAppearance, layoutAppearance, hasBookOverride, setBookOverrideEnabled, updateAppearance, leaveReader, updateShortcuts, settingsError } = useReaderPreferences({
    api, bookId: details.book.id, sessionId: details.sessionId, appearance, onAppearanceChange, onShortcutsChange, onSuspend, onBack,
  });
  const tools = useReaderWorkspace({ api, book: details.book, sourceRevision: details.sourceRevision, active,
    navigate: location => rendition.current?.navigateLocation(location),
    clearSelection: () => rendition.current?.clearSelection(),
    setMarks: marks => rendition.current?.setMarks(marks),
    search: query => rendition.current?.search(query) ?? Promise.resolve([]),
  });
  const { panel: openPanel, setPanel: setOpenPanel } = tools;
  const requestedLocation = useRef(initialLocation); requestedLocation.current = initialLocation;
  const requestedSearch = useRef(initialSearchTarget); requestedSearch.current = initialSearchTarget;
  const ready = useRef(false);
  useEffect(() => {
    if (initialLocation && ready.current) { tools.jump(initialLocation); onLocationConsumed?.(); }
  }, [initialLocation, onLocationConsumed, tools.jump]);
  useEffect(() => {
    if (initialSearchTarget && ready.current) {
      const preferredHref = details.publication.spine[initialSearchTarget.unitIndex]?.href;
      void tools.searchAndJump(initialSearchTarget.query, preferredHref);
      onSearchTargetConsumed?.();
    }
  }, [details.publication.spine, initialSearchTarget, onSearchTargetConsumed, tools.searchAndJump]);
  const handleReady = useCallback(() => {
    ready.current = true; tools.applyMarks(); onReady?.();
    if (requestedLocation.current) { tools.jump(requestedLocation.current); onLocationConsumed?.(); }
    if (requestedSearch.current) {
      const preferredHref = details.publication.spine[requestedSearch.current.unitIndex]?.href;
      void tools.searchAndJump(requestedSearch.current.query, preferredHref);
      onSearchTargetConsumed?.();
    }
  }, [details.publication.spine, onReady, onLocationConsumed, onSearchTargetConsumed, tools.applyMarks, tools.jump, tools.searchAndJump]);

  const activeTitle = chapters.find(
    (chapter) => chapter.id.split("#", 1)[0] === activeHref.split("#", 1)[0],
  )?.title ?? "EPUB";

  useEffect(() => {
    let current = true;
    setPublicationBytes(null);
    setError(null);
    api.reader.getEpubBinary(details.book.id, details.sourceRevision)
      .then((value) => {
        if (current) setPublicationBytes(value.bytes);
      })
      .catch((reason) => {
        if (current) setError(describeReaderError(reason, "runner"));
      });
    return () => {
      current = false;
    };
  }, [api, details.book.id, details.sourceRevision]);

  const handleEscape = useCallback(() => {
    if (tools.selection) tools.clearSelection();
    else if (openPanel) setOpenPanel(null);
    else if (tools.toolbarOpen) tools.setToolbarOpen(false);
    else void leaveReader();
  }, [leaveReader, openPanel, tools.selection, tools.clearSelection, tools.toolbarOpen, tools.setToolbarOpen, setOpenPanel]);

  const handleCommand = useCallback((command: ReaderCommandId) => {
    if (command === "reader.page.previous") rendition.current?.previous();
    if (command === "reader.page.next") rendition.current?.next();
    if (command === "reader.panel.toc.toggle") {
      setOpenPanel((current) => current === "toc" ? null : "toc");
    }
    if (command === "reader.panel.appearance.toggle") {
      setOpenPanel((current) => current === "appearance" ? null : "appearance");
    }
    if (command === "reader.panel.search.toggle") {
      setOpenPanel((current) => current === "search" ? null : "search");
    }
    if (command === "reader.brightness.increase") {
      updateAppearance(nextBrightness(visibleAppearance, 1));
    }
    if (command === "reader.brightness.decrease") {
      updateAppearance(nextBrightness(visibleAppearance, -1));
    }
  }, [setOpenPanel, updateAppearance, visibleAppearance]);

  const dispatchBinding = useReaderShortcuts({
    profile: shortcuts,
    panelOpen: openPanel !== null,
    enabled: active && !tools.selection,
    onCommand: handleCommand,
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!active || event.code !== "Escape" || isReaderEditingTarget(event.target)) return;
      event.preventDefault();
      handleEscape();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, handleEscape]);

  const handleRenditionKeystroke = useCallback((binding: KeyBinding) => {
    if (!active) return;
    if (binding.code === "Escape") {
      handleEscape();
      return;
    }
    dispatchBinding(binding);
  }, [active, dispatchBinding, handleEscape]);

  const handleLocation = useCallback((location: EpubReadingLocationV1) => {
    setActiveHref(previous => previous.split("#")[0] === location.primary.spineHref ? previous : location.primary.spineHref);
    setProgress(location.progression.total);
    tools.onLocation(location);
    queue(location);
  }, [queue, tools.onLocation]);

  const handleRunnerError = useCallback((message: string) => {
    setError(describeReaderError(
      new Error(JSON.stringify({ code: "INVALID_PACKAGE", message })),
      "runner",
    ));
  }, []);

  const handleSeekProgression = useCallback((ratio: number) => {
    const spine = details.publication.spine;
    if (!spine.length) return;
    const index = Math.min(spine.length - 1, Math.max(0, Math.floor(ratio * spine.length)));
    const target = spine[index];
    if (target) {
      setActiveHref(target.href);
      rendition.current?.navigate(target.href);
    }
  }, [details.publication.spine]);

  return (
    <main className="reader-shell" data-panel-open={openPanel ?? "none"}>
      <section className="reader-stage">
        {error && (
          <div className="reader-message reader-message--overlay">
            <InlineNotice notice={error} />
          </div>
        )}
        {publicationBytes
          ? <EpubRendition
              ref={rendition}
              publication={details.publication}
              publicationBytes={publicationBytes}
              appearance={layoutAppearance}
              restoreLocation={details.savedLocation}
              onReady={handleReady}
              onSelection={tools.setSelection}
              onContentClick={tools.toggleToolbar}
              onMarkClick={tools.onMarkClick}
              onPhase={onOpenPhase}
              onLocation={handleLocation}
              onError={handleRunnerError}
              onKeystroke={handleRenditionKeystroke}
              onHistoryState={setHistoryState}
            />
          : !error && <div
              className="reader-message"
              data-testid="epub-binary-loading"
            >正在载入正文</div>}
      </section>
      <div
        className="reader-brightness-layer"
        data-testid="reader-brightness"
        style={brightnessStyle(visibleAppearance)}
      />
      <ReaderHintLayer
        chapter={activeTitle}
        progression={progress}
        blocked={!active || openPanel !== null || !!tools.selection}
        historyHint={historyState.canGoBack ? "可返回链接原处" : undefined}
        onPrevious={() => rendition.current?.previous()}
        onNext={() => rendition.current?.next()}
        onSeekProgression={handleSeekProgression}
      />
      <ReaderTools tools={tools} title={details.book.title} author={details.book.author} chapter={activeTitle} epub onBack={() => void leaveReader()} saveError={settingsError}
        history={{ ...historyState, back: () => rendition.current?.historyBack(), forward: () => rendition.current?.historyForward() }} />
      <ChapterSidebar
        chapters={chapters}
        activeId={activeHref}
        open={openPanel === "toc"}
        onOpenImages={() => setOpenPanel("images")}
        onSelect={(href) => {
          setActiveHref(href);
          rendition.current?.navigate(href);
          setOpenPanel(null);
        }}
        onClose={() => setOpenPanel(null)}
      />
      <EpubImageGalleryPanel
        publicationBytes={publicationBytes}
        open={openPanel === "images"}
        onChapters={() => setOpenPanel("toc")}
        onClose={() => setOpenPanel(null)}
      />
      <AppearancePanel
        appearance={visibleAppearance}
        open={openPanel === "appearance"}
        onChange={updateAppearance}
        onClose={() => setOpenPanel(null)}
        epub
        hasBookOverride={hasBookOverride}
        onBookOverrideChange={setBookOverrideEnabled}
        shortcuts={shortcuts}
        onShortcutsChange={(next) => void updateShortcuts(next)}
        saveError={settingsError}
      />
    </main>
  );
}
