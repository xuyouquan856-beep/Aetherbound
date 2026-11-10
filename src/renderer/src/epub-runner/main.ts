// foliate-js intentionally has no TypeScript declarations for browser subpaths.
// @ts-expect-error pinned browser module
import { View } from "foliate-js/view.js";
// @ts-expect-error pinned browser module
import { Overlayer } from "foliate-js/overlayer.js";
import type { EpubReadingLocationV1, ReadingAppearance } from "../../../shared/contracts.js";
import {
  EPUB_RUNNER_VERSION, EpubRunnerIdentitySchema, parseEpubRunnerCommand,
  type EpubRunnerEventPayload,
} from "./protocol.js";
import {
  LayoutTransactionCoordinator,
  restoreCapturedPosition,
} from "./layout-transaction.js";
import {
  paginatorLayoutAttributes,
  publicationAppearanceCss,
} from "./appearance.js";
import { NavigationHistory } from "./navigation-history.js";
import { initialLastLocation } from "./restoration.js";
import { findQuoteRange } from "./quote-range.js";
import {
  isReaderEditingTarget,
  keyBindingFromEvent,
} from "../features/reader/reader-shortcuts.js";

const params = new URLSearchParams(location.search);
const identity = EpubRunnerIdentitySchema.parse({
  version: EPUB_RUNNER_VERSION,
  bookId: params.get("bookId"),
  sourceRevision: params.get("sourceRevision"),
  nonce: params.get("nonce"),
});
const hostOrigin = params.get("hostOrigin") ?? "";

function trustedHostOrigin(value: string) {
  try {
    const url = new URL(value);
    return (url.protocol === "reader-app:" && url.hostname === "bundle")
      || (["http:", "https:"].includes(url.protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  } catch { return false; }
}
if (!trustedHostOrigin(hostOrigin)) throw new Error("Untrusted EPUB host origin");
if ((window as Window & { readerApi?: unknown }).readerApi) throw new Error("Preload API exposed in EPUB runner");

let view: any = null;
let resourceFraction = 0;
let resourceIndex = 0;
let publicSpine: Array<{ index: number; href: string; linear: boolean }> = [];
let restoring = false;
let layoutChanging = false;
let pendingLocation: EpubReadingLocationV1 | null = null;
let currentLocation: EpubReadingLocationV1 | null = null;
let currentCfi: string | null = null;
let layoutCoordinator: LayoutTransactionCoordinator<
  ReadingAppearance,
  string,
  EpubReadingLocationV1
> | null = null;
let pageTurnQueue = Promise.resolve();
let shellListening = false;
let searchGeneration = 0;
let marks: Array<{ id: string; location: EpubReadingLocationV1; endLocation?: EpubReadingLocationV1; color: "cyan" | "yellow" | "pink" }> = [];
const marksByCfi = new Map<string, (typeof marks)[number]>();
const publicationDocuments = new Set<Document>();
const linkHistory = new NavigationHistory<string>(50);

function emit(event: EpubRunnerEventPayload) {
  window.parent.postMessage({ channel: "reader-epub-event", ...identity, ...event }, hostOrigin);
}

function emitHistoryState() {
  emit({ event: "history-state", ...linkHistory.state });
}

function forwardKeystroke(event: KeyboardEvent) {
  if (isReaderEditingTarget(event.target)) return;
  if (event.code === "Escape" && !event.repeat && !event.isComposing) {
    emit({
      event: "keystroke",
      binding: {
        code: "Escape",
        ctrl: event.ctrlKey,
        alt: event.altKey,
        shift: event.shiftKey,
        meta: event.metaKey,
      },
    });
    return;
  }
  const binding = keyBindingFromEvent(event);
  if (binding) emit({ event: "keystroke", binding });
}

function startKeystrokeForwarding() {
  if (!shellListening) {
    window.addEventListener("keydown", forwardKeystroke);
    shellListening = true;
  }
}

function stopKeystrokeForwarding() {
  if (shellListening) {
    window.removeEventListener("keydown", forwardKeystroke);
    shellListening = false;
  }
  for (const doc of publicationDocuments) {
    doc.removeEventListener("keydown", forwardKeystroke);
  }
  publicationDocuments.clear();
}

startKeystrokeForwarding();

function safeMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[A-Z]:\\[^\s]+/gi, "[path]").slice(0, 240);
}

function locationFromCfi(cfi: string, index: number, exact = ""): EpubReadingLocationV1 {
  const section = view?.book?.sections?.[index];
  return {
    locatorVersion: 1, sourceRevision: identity.sourceRevision, format: "epub",
    primary: { kind: "epub", spineIndex: index, spineHref: publicSpine[index]?.href ?? section?.id ?? section?.href ?? `spine-${index}`, engineLocator: { kind: "epub-cfi", value: cfi } },
    progression: { resource: index === resourceIndex ? resourceFraction : 0 },
    text: { exact: exact.slice(0, 256), prefix: "", suffix: "" },
  };
}

function selectedRange(doc: Document, index: number) {
  const selection = doc.defaultView?.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) { emit({ event: "selection", selection: null }); return; }
  const range = selection.getRangeAt(0);
  const text = selection.toString().trim().slice(0, 100_000);
  if (!text || !doc.body.contains(range.commonAncestorContainer)) return;
  const cfi = view.getCFI(index, range);
  const rectangle = range.getBoundingClientRect();
  const innerFrame = doc.defaultView?.frameElement?.getBoundingClientRect();
  emit({ event: "selection", selection: {
    text, location: locationFromCfi(cfi, index, text),
    rect: { x: rectangle.x + (innerFrame?.left ?? 0), y: rectangle.y + (innerFrame?.top ?? 0), width: rectangle.width, height: rectangle.height },
  } });
}

async function searchBook(query: string, requestId: number) {
  const generation = ++searchGeneration;
  const targetView = view;
  const results: Array<{ id: string; text: string; location: EpubReadingLocationV1 }> = [];
  for await (const item of targetView.search({ query })) {
    if (generation !== searchGeneration || targetView !== view) return;
    const hits = item?.subitems ?? (item?.cfi ? [item] : []);
    for (const hit of hits) {
      if (results.length >= 2000) break;
      const resolved = targetView.resolveNavigation(hit.cfi);
      const index = resolved?.index ?? 0;
      const excerpt = hit.excerpt;
      results.push({ id: `epub:${results.length}:${hit.cfi}`.slice(0, 128),
        text: `${excerpt?.pre ?? ""}${excerpt?.match ?? ""}${excerpt?.post ?? ""}`.slice(0, 512),
        location: locationFromCfi(hit.cfi, index, excerpt?.match ?? "") });
    }
    if (results.length >= 2000) break;
  }
  if (generation === searchGeneration && targetView === view) emit({ event: "search-results", requestId, results });
}

async function setMarks(next: typeof marks) {
  if (!view) return;
  for (const cfi of marksByCfi.keys()) await view.deleteAnnotation({ value: cfi });
  marks = next;
  marksByCfi.clear();
  for (const mark of marks) {
    const cfi = mark.location.primary.engineLocator.value;
    marksByCfi.set(cfi, mark);
    await view.addAnnotation({ value: cfi });
  }
}

async function waitForStablePaint() {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

async function applyLayoutValues(appearance: ReadingAppearance) {
  document.documentElement.style.colorScheme = appearance.theme === "night" ? "dark" : "light";
  document.documentElement.style.backgroundColor = appearance.theme === "night" ? "#1c201e" : "#f5f1e8";
  for (const [name, value] of Object.entries(paginatorLayoutAttributes(appearance))) {
    view?.renderer?.setAttribute(name, value);
  }
  view?.renderer?.setStyles?.(publicationAppearanceCss(appearance));
  document.documentElement.dataset.theme = appearance.theme;
  document.documentElement.dataset.flow = appearance.epubFlow;
}

function quoteFromRange(range: Range | undefined) {
  if (!range) return { exact: "", prefix: "", suffix: "" };
  const exact = range.toString().replace(/\s+/g, " ").trim().slice(0, 256);
  const startText = range.startContainer.nodeType === Node.TEXT_NODE ? range.startContainer.textContent ?? "" : "";
  const endText = range.endContainer.nodeType === Node.TEXT_NODE ? range.endContainer.textContent ?? "" : "";
  return {
    exact,
    prefix: startText.slice(Math.max(0, range.startOffset - 256), range.startOffset),
    suffix: endText.slice(range.endOffset, range.endOffset + 256),
  };
}

async function restore(locationValue: EpubReadingLocationV1 | null) {
  if (!locationValue || !view) return;
  const sameRevision = locationValue.sourceRevision === identity.sourceRevision;
  if (sameRevision) {
    try { await view.goTo(locationValue.primary.engineLocator.value); return; }
    catch { /* fall through to quote/progression */ }
  }
  const candidates = [locationValue.primary.spineIndex, ...view.book.sections.map((_: unknown, index: number) => index)]
    .filter((value, index, all) => value >= 0 && value < view.book.sections.length && all.indexOf(value) === index);
  for (const index of candidates) {
    try {
      const document = await view.book.sections[index].createDocument();
      const range = findQuoteRange(document, locationValue.text.exact, locationValue.text.prefix, locationValue.text.suffix);
      if (range) { await view.goTo(view.getCFI(index, range)); return; }
    } catch { /* try the next fallback */ }
  }
  if (typeof locationValue.progression.total === "number") await view.goTo({ fraction: locationValue.progression.total });
  else await view.goTo({ index: locationValue.primary.spineIndex, fraction: locationValue.progression.resource });
}

function createLayoutCoordinator() {
  return new LayoutTransactionCoordinator<ReadingAppearance, string, EpubReadingLocationV1>({
    capture: () => ({ anchor: currentCfi, fallback: currentLocation }),
    apply: applyLayoutValues,
    waitForStable: waitForStablePaint,
    restore: (position) => restoreCapturedPosition(position, {
      goToAnchor: async (anchor) => {
        if (!view) throw new Error("EPUB rendition is unavailable");
        await view.goTo(anchor);
      },
      restoreFallback: restore,
    }),
    readLocation: () => pendingLocation ?? currentLocation,
    onActiveChange: (active) => {
      layoutChanging = active;
      document.documentElement.dataset.layoutState = active ? "changing" : "stable";
      if (active) pendingLocation = null;
      else pendingLocation = null;
    },
    onStarted: (transactionId) => {
      document.documentElement.dataset.layoutTransaction = String(transactionId);
      emit({ event: "layout-started", transactionId });
    },
    onSettled: (transactionId, locationValue) => {
      currentLocation = locationValue;
      document.documentElement.dataset.layoutState = "stable";
      document.documentElement.dataset.layoutTransaction = String(transactionId);
      emit({ event: "layout-settled", transactionId, location: locationValue });
    },
  });
}

async function followInternalLink(event: CustomEvent<{ href: string }>) {
  event.preventDefault();
  if (!view) return;
  const from = currentCfi;
  const resolved = await view.goTo(event.detail.href);
  if (!resolved) return;
  await waitForStablePaint();
  const to = currentCfi ?? event.detail.href;
  if (from) linkHistory.visit(from, to);
  emitHistoryState();
}

async function moveThroughLinkHistory(direction: "back" | "forward") {
  if (!view) return;
  const target = direction === "back" ? linkHistory.back() : linkHistory.forward();
  if (!target) return;
  const resolved = await view.goTo(target);
  if (!resolved) {
    if (direction === "back") linkHistory.forward();
    else linkHistory.back();
  }
  emitHistoryState();
}

async function open(bytes: ArrayBuffer, appearance: ReadingAppearance, restoreLocation: EpubReadingLocationV1 | null, spine: Array<{ index: number; href: string; linear: boolean }>) {
  searchGeneration++;
  marks = [];
  marksByCfi.clear();
  layoutCoordinator?.dispose();
  layoutCoordinator = null;
  view?.close?.();
  view?.remove?.();
  view = new View();
  pageTurnQueue = Promise.resolve();
  startKeystrokeForwarding();
  restoring = true;
  layoutChanging = false;
  pendingLocation = null;
  currentLocation = null;
  currentCfi = null;
  linkHistory.clear();
  publicSpine = spine;
  document.body.append(view);
  view.addEventListener("link", (event: CustomEvent<{ href: string }>) => {
    event.preventDefault();
    void followInternalLink(event);
  });
  view.addEventListener("external-link", (event: CustomEvent<{ href: string }>) => {
    event.preventDefault();
  });
  await view.open(new File([bytes], "book.epub", { type: "application/epub+zip" }));
  emit({ event: "phase", phase: "publication-opened" });
  view.addEventListener("draw-annotation", (event: CustomEvent<{ draw: (kind: unknown, options: unknown) => void; annotation: { value: string } }>) => {
    const mark = marksByCfi.get(event.detail.annotation.value);
    if (mark) event.detail.draw(Overlayer.highlight, { color: { cyan: "#44cfda", yellow: "#ffde55", pink: "#f784b9" }[mark.color] });
  });
  view.addEventListener("show-annotation", (event: CustomEvent<{ value: string }>) => {
    const mark = marksByCfi.get(event.detail.value);
    if (mark) emit({ event: "mark-click", id: mark.id });
  });
  view.addEventListener("create-overlay", () => {
    queueMicrotask(() => {
      for (const mark of marks) void view?.addAnnotation({ value: mark.location.primary.engineLocator.value });
    });
  });
  view.addEventListener("load", (event: CustomEvent<{ doc: Document; index: number }>) => {
    const doc = event.detail.doc;
    doc.addEventListener("keydown", forwardKeystroke);
    doc.addEventListener("pointerup", () => selectedRange(doc, event.detail.index));
    doc.addEventListener("keyup", () => selectedRange(doc, event.detail.index));
    let pointerStart: { x: number; y: number } | null = null;
    doc.addEventListener("pointerdown", (pointer) => { pointerStart = { x: pointer.clientX, y: pointer.clientY }; });
    doc.addEventListener("click", (click) => {
      if (!pointerStart || Math.hypot(click.clientX - pointerStart.x, click.clientY - pointerStart.y) > 6) return;
      if (doc.defaultView?.getSelection()?.toString().trim()) return;
      if ((click.target as Element)?.closest?.("a[href], button")) return;
      emit({ event: "content-click" });
    });
    publicationDocuments.add(doc);
  });
  view.renderer.addEventListener("relocate", (event: CustomEvent<{ index: number; fraction?: number }>) => {
    resourceIndex = event.detail.index;
    resourceFraction = Math.min(1, Math.max(0, event.detail.fraction ?? 0));
  });
  view.addEventListener("relocate", (event: CustomEvent<any>) => {
    const detail = event.detail;
    currentCfi = detail.cfi;
    const index = detail.section?.current ?? resourceIndex;
    const spine = view.book.sections[index];
    const locationValue: EpubReadingLocationV1 = {
      locatorVersion: 1,
      sourceRevision: identity.sourceRevision,
      format: "epub",
      primary: { kind: "epub", spineIndex: index, spineHref: publicSpine[index]?.href ?? spine?.id ?? spine?.href ?? `spine-${index}`, engineLocator: { kind: "epub-cfi", value: detail.cfi } },
      progression: { resource: resourceFraction, total: typeof detail.fraction === "number" ? detail.fraction : undefined },
      text: quoteFromRange(detail.range),
    };
    currentLocation = locationValue;
    if (restoring || layoutChanging) pendingLocation = locationValue;
    else emit({ event: "relocated", location: locationValue });
    document.documentElement.dataset.spineIndex = String(index);
    document.documentElement.dataset.cfi = detail.cfi;
  });
  layoutCoordinator = createLayoutCoordinator();
  await applyLayoutValues(appearance);
  const lastLocation = initialLastLocation(restoreLocation, identity.sourceRevision);
  let restoredExactly = false;
  if (lastLocation) {
    try {
      await view.init({ lastLocation });
      restoredExactly = true;
    } catch { /* use quote/progression fallback below */ }
  }
  if (!restoredExactly) {
    if (!view.lastLocation) await view.init({ showTextStart: !restoreLocation });
    await restore(restoreLocation);
  }
  emit({ event: "phase", phase: "restore-complete" });
  restoring = false;
  await waitForStablePaint();
  emit({ event: "phase", phase: "stable-paint" });
  document.documentElement.dataset.ready = "true";
  document.documentElement.dataset.layoutState = "stable";
  document.documentElement.dataset.layoutTransaction = "0";
  emit({ event: "ready" });
  emitHistoryState();
  if (pendingLocation) emit({ event: "relocated", location: pendingLocation });
  pendingLocation = null;
}

function engineHref(publicHref: string) {
  const [path, fragment] = publicHref.split("#", 2);
  const index = publicSpine.findIndex((item) => item.href === path || item.href.endsWith(`/${path}`) || path?.endsWith(`/${item.href}`));
  const enginePath = index >= 0 ? view?.book?.sections?.[index]?.id : path;
  return fragment ? `${enginePath}#${fragment}` : enginePath;
}

function enqueuePageTurn(direction: "next" | "previous") {
  const targetView = view;
  const queued = pageTurnQueue.then(async () => {
    if (!targetView || targetView !== view) return;
    if (direction === "next") await targetView.next();
    else await targetView.prev();
  });
  pageTurnQueue = queued.catch(() => undefined);
  return queued;
}

window.addEventListener("message", async (event) => {
  if (event.origin !== hostOrigin || event.source !== window.parent) return;
  const command = parseEpubRunnerCommand(event.data, identity);
  if (!command) return;
  try {
    if (command.command === "open") await open(command.bytes, command.appearance, command.restoreLocation, command.spine);
    else if (command.command === "navigate") await view?.goTo(engineHref(command.href));
    else if (command.command === "next") await enqueuePageTurn("next");
    else if (command.command === "previous") await enqueuePageTurn("previous");
    else if (command.command === "applyLayout") await layoutCoordinator?.request({
      transactionId: command.transactionId,
      layout: command.appearance,
    });
    else if (command.command === "historyBack") await moveThroughLinkHistory("back");
    else if (command.command === "historyForward") await moveThroughLinkHistory("forward");
    else if (command.command === "navigateLocation") {
      if (command.location.sourceRevision === identity.sourceRevision) await view?.goTo(command.location.primary.engineLocator.value);
      else await restore(command.location);
    }
    else if (command.command === "clearSelection") {
      view?.deselect();
      emit({ event: "selection", selection: null });
    }
    else if (command.command === "search") await searchBook(command.query, command.requestId);
    else if (command.command === "setMarks") await setMarks(command.marks);
    else if (command.command === "dispose") {
      searchGeneration++;
      marks = [];
      marksByCfi.clear();
      layoutCoordinator?.dispose();
      layoutCoordinator = null;
      stopKeystrokeForwarding();
      view?.close?.();
      view?.remove?.();
      view = null;
    }
  } catch (error) {
    emit({ event: "error", code: "INVALID_PACKAGE", message: safeMessage(error) });
  }
});
