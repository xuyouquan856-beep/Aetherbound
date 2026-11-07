// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { readFile } from "node:fs/promises";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EpubReadingLocationV1, PublicationView } from "../../src/shared/contracts.js";
import { EpubRendition, type EpubRenditionHandle } from "../../src/renderer/src/renditions/EpubRendition.js";
import {
  isEpubRunnerEvent,
  parseEpubRunnerCommand,
} from "../../src/renderer/src/epub-runner/protocol.js";
import { DefaultReadingAppearance } from "../../src/shared/contracts.js";

const publication: PublicationView = {
  bookId: "book-1", sourceRevision: "rev-1",
  metadata: { title: "EPUB", author: null, language: "zh" },
  toc: [{ id: "t1", label: "第一章", href: "EPUB/chapter.xhtml", children: [] }],
  spine: [{ index: 0, href: "EPUB/chapter.xhtml", linear: true }],
};

const location: EpubReadingLocationV1 = {
  locatorVersion: 1, sourceRevision: "rev-1", format: "epub",
  primary: { kind: "epub", spineIndex: 0, spineHref: "EPUB/chapter.xhtml", engineLocator: { kind: "epub-cfi", value: "epubcfi(/6/2!/4/2:0)" } },
  progression: { resource: 0.1, total: 0.1 }, text: { exact: "正文", prefix: "", suffix: "" },
};

const publicationBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("EPUB runner protocol", () => {
  it("accepts a bounded binary open command and rejects an empty payload", () => {
    const identity = {
      version: 1 as const,
      bookId: "book-1",
      sourceRevision: "rev-1",
      nonce: "nonce-bytes",
    };
    const envelope = {
      channel: "reader-epub-command",
      ...identity,
      command: "open",
      appearance: DefaultReadingAppearance,
      restoreLocation: null,
      spine: publication.spine,
    };

    expect(parseEpubRunnerCommand({
      ...envelope,
      bytes: publicationBytes.buffer.slice(0),
    }, identity)).toMatchObject({
      command: "open",
      bytes: expect.any(ArrayBuffer),
    });
    expect(parseEpubRunnerCommand({
      ...envelope,
      bytes: new ArrayBuffer(0),
    }, identity)).toBeNull();
  });

  it("requires the complete versioned identity", () => {
    const identity = { version: 1 as const, bookId: "book-1", sourceRevision: "rev-1", nonce: "nonce-1" };
    expect(isEpubRunnerEvent({ channel: "reader-epub-event", ...identity, event: "relocated", location }, identity)).toBe(true);
    expect(isEpubRunnerEvent({ channel: "reader-epub-event", ...identity, nonce: "forged", event: "relocated", location }, identity)).toBe(false);
    expect(isEpubRunnerEvent({ channel: "reader-epub-event", ...identity, version: 2, event: "relocated", location }, identity)).toBe(false);
  });

  it("accepts one strict layout command and rejects the two legacy commands", () => {
    const identity = { version: 1 as const, bookId: "book-1", sourceRevision: "rev-1", nonce: "nonce-1" };
    const envelope = { channel: "reader-epub-command", ...identity };

    expect(parseEpubRunnerCommand({
      ...envelope,
      command: "applyLayout",
      appearance: DefaultReadingAppearance,
      transactionId: 1,
    }, identity)).toMatchObject({ command: "applyLayout", transactionId: 1 });
    expect(parseEpubRunnerCommand({
      ...envelope,
      command: "applyLayout",
      appearance: DefaultReadingAppearance,
      transactionId: 0,
    }, identity)).toBeNull();
    expect(parseEpubRunnerCommand({
      ...envelope,
      command: "setFlow",
      flow: "scrolled",
    }, identity)).toBeNull();
    expect(parseEpubRunnerCommand({
      ...envelope,
      command: "applyAppearance",
      appearance: DefaultReadingAppearance,
    }, identity)).toBeNull();
  });

  it("accepts only strict layout and navigation-history state events", () => {
    const identity = { version: 1 as const, bookId: "book-1", sourceRevision: "rev-1", nonce: "nonce-1" };
    const envelope = { channel: "reader-epub-event", ...identity };

    expect(isEpubRunnerEvent({
      ...envelope, event: "layout-started", transactionId: 3,
    }, identity)).toBe(true);
    expect(isEpubRunnerEvent({
      ...envelope, event: "layout-settled", transactionId: 3, location,
    }, identity)).toBe(true);
    expect(isEpubRunnerEvent({
      ...envelope, event: "history-state", canGoBack: true, canGoForward: false,
    }, identity)).toBe(true);
    expect(isEpubRunnerEvent({
      ...envelope, event: "history-state", canGoBack: true, canGoForward: false, path: "E:\\secret.epub",
    }, identity)).toBe(false);
  });

  it("accepts only strictly sanitized keystroke events with the expected identity", () => {
    const identity = { version: 1 as const, bookId: "book-1", sourceRevision: "rev-1", nonce: "nonce-1" };
    const binding = { code: "KeyD", ctrl: false, alt: false, shift: false, meta: false };

    expect(isEpubRunnerEvent({
      channel: "reader-epub-event", ...identity, event: "keystroke", binding,
    }, identity)).toBe(true);
    expect(isEpubRunnerEvent({
      channel: "reader-epub-event", ...identity, nonce: "forged", event: "keystroke", binding,
    }, identity)).toBe(false);
    expect(isEpubRunnerEvent({
      channel: "reader-epub-event", ...identity, event: "keystroke",
      binding: { ...binding, path: "E:\\secret.epub" },
    }, identity)).toBe(false);
  });

  it("accepts only named path-free open phase events", () => {
    const identity = {
      version: 1 as const,
      bookId: "book-1",
      sourceRevision: "rev-1",
      nonce: "nonce-1",
    };
    expect(isEpubRunnerEvent({
      channel: "reader-epub-event",
      ...identity,
      event: "phase",
      phase: "restore-complete",
    }, identity)).toBe(true);
    expect(isEpubRunnerEvent({
      channel: "reader-epub-event",
      ...identity,
      event: "phase",
      phase: "restore-complete",
      path: "E:\\private\\book.epub",
    }, identity)).toBe(false);
  });

  it("captures keys from both the runner shell and loaded publication documents", async () => {
    const source = await readFile("src/renderer/src/epub-runner/main.ts", "utf8");
    expect(source).toMatch(/window\.addEventListener\("keydown", forwardKeystroke\)/);
    expect(source).toMatch(/view\.addEventListener\("load"[\s\S]*doc\.addEventListener\("keydown", forwardKeystroke\)/);
    expect(source).toMatch(/event\.code === "Escape"[\s\S]*event:\s*"keystroke"/);
  });
});

describe("EpubRendition", () => {
  it("forwards trusted open phases to host timing without accepting extra data", () => {
    const onPhase = vi.fn();
    render(<EpubRendition
      publication={publication}
      publicationBytes={publicationBytes}
      appearance={DefaultReadingAppearance}
      restoreLocation={location}
      onLocation={vi.fn()}
      onPhase={onPhase}
      nonce="nonce-phase"
    />);
    const frame = screen.getByTitle(/EPUB/) as HTMLIFrameElement;
    window.dispatchEvent(new MessageEvent("message", {
      origin: "reader-rendition://epub",
      source: frame.contentWindow,
      data: {
        channel: "reader-epub-event",
        version: 1,
        bookId: "book-1",
        sourceRevision: "rev-1",
        nonce: "nonce-phase",
        event: "phase",
        phase: "publication-opened",
      },
    }));

    expect(onPhase).toHaveBeenCalledWith("publication-opened");
  });

  it("notifies the host exactly once after a trusted runner ready event", () => {
    const onReady = vi.fn();
    render(<EpubRendition
      publication={publication}
      publicationBytes={publicationBytes}
      appearance={DefaultReadingAppearance}
      restoreLocation={location}
      onLocation={vi.fn()}
      onReady={onReady}
      nonce="nonce-ready"
    />);
    const frame = screen.getByTitle(/EPUB/) as HTMLIFrameElement;
    const ready = {
      channel: "reader-epub-event",
      version: 1,
      bookId: "book-1",
      sourceRevision: "rev-1",
      nonce: "nonce-ready",
      event: "ready",
    };

    window.dispatchEvent(new MessageEvent("message", {
      origin: "reader-rendition://epub",
      source: frame.contentWindow,
      data: ready,
    }));
    window.dispatchEvent(new MessageEvent("message", {
      origin: "reader-rendition://epub",
      source: frame.contentWindow,
      data: ready,
    }));

    expect(onReady).toHaveBeenCalledOnce();
  });

  it("uses a cross-origin opaque runner URL and accepts messages only from its direct frame", () => {
    const onLocation = vi.fn();
    const reference = createRef<EpubRenditionHandle>();
    render(<EpubRendition ref={reference} publication={publication} publicationBytes={publicationBytes} appearance={DefaultReadingAppearance} restoreLocation={null} onLocation={onLocation} nonce="nonce-1" />);
    const frame = screen.getByTitle("EPUB 正文") as HTMLIFrameElement;
    expect(frame.src).toBe("reader-rendition://epub/epub-runner.html?bookId=book-1&sourceRevision=rev-1&nonce=nonce-1&hostOrigin=http%3A%2F%2Flocalhost%3A3000");

    window.dispatchEvent(new MessageEvent("message", { origin: "reader-rendition://epub", source: window, data: {
      channel: "reader-epub-event", version: 1, bookId: "book-1", sourceRevision: "rev-1", nonce: "nonce-1", event: "relocated", location,
    } }));
    expect(onLocation).not.toHaveBeenCalled();

    window.dispatchEvent(new MessageEvent("message", { origin: "https://evil.invalid", source: frame.contentWindow, data: {
      channel: "reader-epub-event", version: 1, bookId: "book-1", sourceRevision: "rev-1", nonce: "nonce-1", event: "relocated", location,
    } }));
    expect(onLocation).not.toHaveBeenCalled();

    window.dispatchEvent(new MessageEvent("message", { origin: "reader-rendition://epub", source: frame.contentWindow, data: {
      channel: "reader-epub-event", version: 1, bookId: "book-1", sourceRevision: "rev-1", nonce: "nonce-1", event: "relocated", location,
    } }));
    expect(onLocation).not.toHaveBeenCalled();

    window.dispatchEvent(new MessageEvent("message", { origin: "reader-rendition://epub", source: frame.contentWindow, data: {
      channel: "reader-epub-event", version: 1, bookId: "book-1", sourceRevision: "rev-1", nonce: "nonce-1", event: "ready",
    } }));
    window.dispatchEvent(new MessageEvent("message", { origin: "reader-rendition://epub", source: frame.contentWindow, data: {
      channel: "reader-epub-event", version: 1, bookId: "book-1", sourceRevision: "rev-1", nonce: "nonce-1", event: "relocated", location,
    } }));
    expect(onLocation).toHaveBeenCalledWith(location);
  });

  it("keeps the rendition hidden and blocks navigation until the runner is ready", async () => {
    const reference = createRef<EpubRenditionHandle>();
    render(<EpubRendition ref={reference} publication={publication} publicationBytes={publicationBytes} appearance={DefaultReadingAppearance} restoreLocation={location} onLocation={vi.fn()} nonce="nonce-2" />);
    const frame = screen.getByTitle("EPUB 正文") as HTMLIFrameElement;
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
    expect(frame).toHaveAttribute("data-ready", "false");
    fireEvent.load(frame);
    reference.current?.next();
    reference.current?.previous();
    reference.current?.navigate("EPUB/chapter.xhtml#target");
    reference.current?.applyLayout({ ...DefaultReadingAppearance, epubFlow: "scrolled" });
    reference.current?.historyBack();
    reference.current?.historyForward();
    const calls = postMessage.mock.calls as unknown as Array<
      [message: unknown, targetOrigin: string, transfer?: Transferable[]]
    >;
    const openCall = calls.find(([message]) =>
      (message as { command?: string }).command === "open");
    expect(openCall?.[0]).toMatchObject({
      command: "open",
      bytes: expect.any(ArrayBuffer),
    });
    const transferred = (openCall?.[0] as { bytes: ArrayBuffer }).bytes;
    expect(transferred.byteLength).toBe(publicationBytes.byteLength);
    expect(openCall?.[1]).toBe("reader-rendition://epub");
    expect(openCall?.[2]).toEqual([transferred]);
    expect(publicationBytes.byteLength).toBe(4);
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ command: "next" }), "reader-rendition://epub");
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ command: "previous" }), "reader-rendition://epub");
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ command: "navigate" }), "reader-rendition://epub");
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ command: "applyLayout" }), "reader-rendition://epub");
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ command: "historyBack" }), "reader-rendition://epub");
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ command: "historyForward" }), "reader-rendition://epub");

    window.dispatchEvent(new MessageEvent("message", { origin: "reader-rendition://epub", source: frame.contentWindow, data: {
      channel: "reader-epub-event", version: 1, bookId: "book-1", sourceRevision: "rev-1", nonce: "nonce-2", event: "ready",
    } }));
    await waitFor(() => expect(frame).toHaveAttribute("data-ready", "true"));

    reference.current?.next();
    reference.current?.previous();
    reference.current?.navigate("EPUB/chapter.xhtml#target");
    reference.current?.applyLayout({ ...DefaultReadingAppearance, epubFlow: "scrolled" });
    reference.current?.historyBack();
    reference.current?.historyForward();
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: "next" }), "reader-rendition://epub");
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: "previous" }), "reader-rendition://epub");
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: "navigate", href: "EPUB/chapter.xhtml#target" }), "reader-rendition://epub");
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      command: "applyLayout",
      appearance: expect.objectContaining({ epubFlow: "scrolled" }),
      transactionId: 1,
    }), "reader-rendition://epub");
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: "historyBack" }), "reader-rendition://epub");
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: "historyForward" }), "reader-rendition://epub");
  });

  it("uses monotonic layout transactions and ignores a stale settled location", async () => {
    const onLocation = vi.fn();
    const firstAppearance = { ...DefaultReadingAppearance, fontSize: 21 };
    const secondAppearance = { ...DefaultReadingAppearance, fontSize: 22 };
    const { rerender } = render(<EpubRendition
      publication={publication}
      publicationBytes={publicationBytes}
      appearance={DefaultReadingAppearance}
      restoreLocation={location}
      onLocation={onLocation}
      nonce="nonce-layout"
    />);
    const frame = screen.getByTitle(/EPUB/) as HTMLIFrameElement;
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
    fireEvent.load(frame);
    window.dispatchEvent(new MessageEvent("message", {
      origin: "reader-rendition://epub",
      source: frame.contentWindow,
      data: {
        channel: "reader-epub-event", version: 1, bookId: "book-1",
        sourceRevision: "rev-1", nonce: "nonce-layout", event: "ready",
      },
    }));

    rerender(<EpubRendition publication={publication} publicationBytes={publicationBytes} appearance={firstAppearance} restoreLocation={location} onLocation={onLocation} nonce="nonce-layout" />);
    rerender(<EpubRendition publication={publication} publicationBytes={publicationBytes} appearance={secondAppearance} restoreLocation={location} onLocation={onLocation} nonce="nonce-layout" />);
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: "applyLayout", transactionId: 2 }),
      "reader-rendition://epub",
    ));

    const envelope = {
      channel: "reader-epub-event",
      version: 1,
      bookId: "book-1",
      sourceRevision: "rev-1",
      nonce: "nonce-layout",
      event: "layout-settled",
      location,
    };
    window.dispatchEvent(new MessageEvent("message", {
      origin: "reader-rendition://epub",
      source: frame.contentWindow,
      data: { ...envelope, transactionId: 1 },
    }));
    expect(onLocation).not.toHaveBeenCalled();

    window.dispatchEvent(new MessageEvent("message", {
      origin: "reader-rendition://epub",
      source: frame.contentWindow,
      data: { ...envelope, transactionId: 2 },
    }));
    expect(onLocation).toHaveBeenCalledWith(location);
  });

  it("suppresses intermediate relocations until the current layout settles", async () => {
    const onLocation = vi.fn();
    const { rerender } = render(<EpubRendition
      publication={publication}
      publicationBytes={publicationBytes}
      appearance={DefaultReadingAppearance}
      restoreLocation={location}
      onLocation={onLocation}
      nonce="nonce-progress"
    />);
    const frame = screen.getByTitle(/EPUB/) as HTMLIFrameElement;
    fireEvent.load(frame);
    const envelope = {
      channel: "reader-epub-event",
      version: 1,
      bookId: "book-1",
      sourceRevision: "rev-1",
      nonce: "nonce-progress",
    };
    window.dispatchEvent(new MessageEvent("message", {
      origin: "reader-rendition://epub",
      source: frame.contentWindow,
      data: { ...envelope, event: "ready" },
    }));
    rerender(<EpubRendition
      publication={publication}
      publicationBytes={publicationBytes}
      appearance={{ ...DefaultReadingAppearance, measure: 800 }}
      restoreLocation={location}
      onLocation={onLocation}
      nonce="nonce-progress"
    />);
    window.dispatchEvent(new MessageEvent("message", {
      origin: "reader-rendition://epub",
      source: frame.contentWindow,
      data: { ...envelope, event: "layout-started", transactionId: 1 },
    }));
    window.dispatchEvent(new MessageEvent("message", {
      origin: "reader-rendition://epub",
      source: frame.contentWindow,
      data: {
        ...envelope,
        event: "relocated",
        location: { ...location, progression: { resource: 0, total: 0 } },
      },
    }));
    expect(onLocation).not.toHaveBeenCalled();

    window.dispatchEvent(new MessageEvent("message", {
      origin: "reader-rendition://epub",
      source: frame.contentWindow,
      data: { ...envelope, event: "layout-settled", transactionId: 1, location },
    }));
    expect(onLocation).toHaveBeenCalledOnce();
    expect(onLocation).toHaveBeenCalledWith(location);
  });

  it("forwards trusted keystrokes only after the runner is ready", () => {
    const onKeystroke = vi.fn();
    render(<EpubRendition
      publication={publication}
      publicationBytes={publicationBytes}
      appearance={DefaultReadingAppearance}
      restoreLocation={null}
      onLocation={vi.fn()}
      onKeystroke={onKeystroke}
      nonce="nonce-keys"
    />);
    const frame = screen.getByTitle(/EPUB/) as HTMLIFrameElement;
    const identity = {
      channel: "reader-epub-event",
      version: 1,
      bookId: "book-1",
      sourceRevision: "rev-1",
      nonce: "nonce-keys",
    };
    const binding = { code: "KeyD", ctrl: false, alt: false, shift: false, meta: false };

    window.dispatchEvent(new MessageEvent("message", {
      origin: "https://evil.invalid",
      source: frame.contentWindow,
      data: { ...identity, event: "keystroke", binding },
    }));
    window.dispatchEvent(new MessageEvent("message", {
      origin: "reader-rendition://epub",
      source: frame.contentWindow,
      data: { ...identity, event: "keystroke", binding },
    }));
    expect(onKeystroke).not.toHaveBeenCalled();

    window.dispatchEvent(new MessageEvent("message", {
      origin: "reader-rendition://epub",
      source: frame.contentWindow,
      data: { ...identity, event: "ready" },
    }));
    window.dispatchEvent(new MessageEvent("message", {
      origin: "reader-rendition://epub",
      source: frame.contentWindow,
      data: { ...identity, event: "keystroke", binding },
    }));
    expect(onKeystroke).toHaveBeenCalledWith(binding);
  });

  it("keeps a not-ready EPUB frame visually hidden in the production stylesheet", async () => {
    const css = await readFile("src/renderer/src/styles/app.css", "utf8");
    expect(css).toMatch(
      /\.epub-rendition-frame\[data-ready="false"\]\s*\{[^}]*opacity:\s*0/s,
    );
  });
});
