// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReaderView } from "../../src/renderer/src/features/reader/ReaderView.js";
import {
  DefaultReaderShortcutProfile,
  DefaultReadingAppearance,
  type EpubBookDetails,
  type EpubReadingLocationV1,
  type ReaderApi,
} from "../../src/shared/contracts.js";
import { createScanApiStub } from "./scan-api-stub.js";

const restoredLocation: EpubReadingLocationV1 = {
  locatorVersion: 1,
  sourceRevision: "rev-1",
  format: "epub",
  primary: {
    kind: "epub",
    spineIndex: 0,
    spineHref: "EPUB/ch1.xhtml",
    engineLocator: { kind: "epub-cfi", value: "epubcfi(/6/2!/4/2:0)" },
  },
  progression: { resource: 0.4, total: 0.42 },
  text: { exact: "第一章", prefix: "", suffix: "正文" },
};

const details: EpubBookDetails = {
  book: {
    id: "book-1",
    title: "EPUB 书",
    author: "作者",
    format: "epub",
    availabilityStatus: "available",
    progress: 0,
    addedAt: "2026-07-29T00:00:00.000Z",
    lastReadAt: null,
    updatedAt: "2026-07-29T00:00:00.000Z",
    coverUrl: null,
  },
  sourceRevision: "rev-1",
  publication: {
    bookId: "book-1", sourceRevision: "rev-1", metadata: { title: "EPUB 书", author: "作者", language: "zh" },
    toc: [{ id: "t1", label: "第一章", href: "EPUB/ch1.xhtml", children: [{ id: "t2", label: "第二章", href: "EPUB/ch2.xhtml", children: [] }] }],
    spine: [{ index: 0, href: "EPUB/ch1.xhtml", linear: true }, { index: 1, href: "EPUB/ch2.xhtml", linear: true }],
  },
  savedLocation: null,
  sessionId: "session-1",
};

function api(): ReaderApi {
  return {
    app: { getInfo: vi.fn() },
    library: {
      list: vi.fn(),
      importTxt: vi.fn(),
      importEpub: vi.fn(),
      importFiles: vi.fn(async () => ({ status: "cancelled" as const })),
      onImportProgress: vi.fn(() => () => undefined),
      remove: vi.fn(),
      retryPreparation: vi.fn(async () => undefined),
      onPreparationChanged: vi.fn(() => () => undefined),
    },
    collections: {
      list: vi.fn(async () => []),
      get: vi.fn(),
      create: vi.fn(),
      rename: vi.fn(),
      delete: vi.fn(async () => undefined),
      addBooks: vi.fn(),
      removeBooks: vi.fn(),
      reorder: vi.fn(),
      getMemberships: vi.fn(async () => []),
      listUnorganized: vi.fn(async () => []),
      importFolder: vi.fn(async () => ({ status: "cancelled" as const })),
      importOrganizedFolder: vi.fn(async () => ({ status: "cancelled" as const })),
      importFiles: vi.fn(async () => ({ status: "cancelled" as const })),
      onFolderImportProgress: vi.fn(() => () => undefined),
    },
    reader: {
      open: vi.fn(),
      getEpubBinary: vi.fn(async (bookId, sourceRevision) => ({
        bookId,
        sourceRevision,
        mediaType: "application/epub+zip" as const,
        bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
      })),
      canResume: vi.fn(async () => true),
      getChapter: vi.fn(),
      saveProgress: vi.fn(async () => undefined),
      closeSession: vi.fn(async () => undefined),
    },
    settings: {
      getAppearance: vi.fn(),
      updateAppearance: vi.fn(async (value) => value),
      getShortcuts: vi.fn(async () => DefaultReaderShortcutProfile),
      updateShortcuts: vi.fn(async (value) => value),
    },
    search: { fulltext: vi.fn(async () => []) },
    scan: createScanApiStub(),
  };
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function epubWithImages() {
  const zip = new JSZip();
  zip.file("META-INF/container.xml", '<container><rootfile full-path="EPUB/content.opf" /></container>');
  zip.file("EPUB/content.opf", '<package><manifest><item id="cover" href="cover.png" media-type="image/png" properties="cover-image" /><item id="scene" href="scene.jpg" media-type="image/jpeg" /></manifest></package>');
  zip.file("EPUB/cover.png", new Uint8Array([137, 80, 78, 71]));
  zip.file("EPUB/scene.jpg", new Uint8Array([255, 216, 255]));
  return zip.generateAsync({ type: "uint8array" });
}

describe("EPUB reader shell", () => {
  it("opens cover and illustration previews from the image directory without moving the reading frame", async () => {
    const readerApi = api();
    readerApi.reader.getEpubBinary = vi.fn(async () => ({
      bookId: "book-1", sourceRevision: "rev-1", mediaType: "application/epub+zip" as const,
      bytes: Uint8Array.from(await epubWithImages()),
    }));
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:image") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    try {
      render(<ReaderView api={readerApi} details={details} appearance={DefaultReadingAppearance} shortcuts={DefaultReaderShortcutProfile} onAppearanceChange={vi.fn()} onShortcutsChange={vi.fn()} onBack={vi.fn()} />);
      const frame = await screen.findByTitle("EPUB 正文");
      const initialSource = frame.getAttribute("src");
      fireEvent.click(screen.getByRole("button", { name: /^阅读工具$/ }));
      fireEvent.click(screen.getByRole("button", { name: "图片" }));
      expect(screen.getByRole("complementary", { name: "图片目录" })).toHaveAttribute("data-open", "true");
      fireEvent.click(await screen.findByRole("button", { name: "查看封面" }));
      expect(screen.getByRole("dialog", { name: "封面大图" })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "下一张图片" }));
      expect(screen.getByRole("dialog", { name: "插图 1大图" })).toBeInTheDocument();
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape", code: "Escape" });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.getByRole("complementary", { name: "图片目录" })).toHaveAttribute("data-open", "true");
      expect(frame.getAttribute("src")).toBe(initialSource);
    } finally {
      Reflect.deleteProperty(URL, "createObjectURL");
      Reflect.deleteProperty(URL, "revokeObjectURL");
    }
  });
  it("loads prepared EPUB bytes by opaque identity before mounting the rendition", async () => {
    const readerApi = api();
    render(<ReaderView
      api={readerApi}
      details={details}
      appearance={DefaultReadingAppearance}
      shortcuts={DefaultReaderShortcutProfile}
      onAppearanceChange={vi.fn()}
      onShortcutsChange={vi.fn()}
      onBack={vi.fn()}
    />);

    expect(screen.getByTestId("epub-binary-loading")).toBeVisible();
    await waitFor(() => expect(readerApi.reader.getEpubBinary)
      .toHaveBeenCalledWith("book-1", "rev-1"));
    expect(await screen.findByTitle(/EPUB/)).toBeVisible();
  });

  it("forwards EPUB open phases to the application trace", async () => {
    const onOpenPhase = vi.fn();
    render(<ReaderView
      api={api()}
      details={details}
      appearance={DefaultReadingAppearance}
      shortcuts={DefaultReaderShortcutProfile}
      onAppearanceChange={vi.fn()}
      onShortcutsChange={vi.fn()}
      onOpenPhase={onOpenPhase}
      onBack={vi.fn()}
    />);
    const frame = await screen.findByTitle("EPUB 正文") as HTMLIFrameElement;
    expect(onOpenPhase).toHaveBeenCalledWith("rendition-mounted");
    const nonce = new URL(frame.src).searchParams.get("nonce");
    const post = (data: unknown) => {
      window.dispatchEvent(new MessageEvent("message", {
        origin: "reader-rendition://epub",
        source: frame.contentWindow,
        data,
      }));
    };
    const phase = (value: string) => ({
      channel: "reader-epub-event",
      version: 1,
      bookId: "book-1",
      sourceRevision: "rev-1",
      nonce,
      event: "phase",
      phase: value,
    });

    // The parent registers its message listener in a useEffect, which runs just
    // after the frame is committed. Asserting on a single immediately-dispatched
    // event raced that effect and made this test flaky under load, so retry until
    // the listener is live.
    await waitFor(() => {
      post(phase("restore-complete"));
      expect(onOpenPhase).toHaveBeenCalledWith("restore-complete");
    });

    post(phase("stable-paint"));
    await waitFor(() => expect(onOpenPhase).toHaveBeenCalledWith("stable-paint"));
    // Every phase the runner reports is forwarded, in order.
    expect(onOpenPhase.mock.calls.map(([value]) => value)).toEqual([
      "rendition-mounted",
      "restore-complete",
      "stable-paint",
    ]);
  });

  it("keeps EPUB text immersive and moves its controls into overlay panels", async () => {
    const onBack = vi.fn();
    render(<ReaderView api={api()} details={{ ...details, savedLocation: restoredLocation }} appearance={DefaultReadingAppearance} shortcuts={DefaultReaderShortcutProfile} onAppearanceChange={vi.fn()} onShortcutsChange={vi.fn()} onBack={onBack} />);
    expect(await screen.findByTitle("EPUB 正文")).toBeInTheDocument();
    expect(screen.queryByRole("banner")).not.toBeInTheDocument();
    expect(screen.getByTestId("reader-hints")).toHaveTextContent("42%");
    expect(screen.getByLabelText("目录", { selector: "aside" })).toHaveAttribute("data-open", "false");
    await waitFor(() => expect(
      screen.getByLabelText("阅读外观", { selector: "aside" }),
    ).toHaveAttribute("data-open", "false"));

    fireEvent.keyDown(window, { code: "KeyC" });
    expect(screen.getByRole("complementary", { name: "目录" })).toHaveAttribute("data-open", "true");
    expect(screen.getByRole("button", { name: /第一章/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /第二章/ })).toBeInTheDocument();

    fireEvent.keyDown(window, { code: "KeyV" });
    expect(screen.getByLabelText("目录", { selector: "aside" })).toHaveAttribute("data-open", "false");
    expect(screen.getByRole("complementary", { name: "阅读外观" })).toHaveAttribute("data-open", "true");
    expect(screen.getByRole("slider", { name: "字号" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "滚动阅读" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "单栏阅读" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "双栏阅读" })).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "段间距" })).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "字距" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "首行缩进两字" })).toBeInTheDocument();

    const frame = await screen.findByTitle("EPUB 正文") as HTMLIFrameElement;
    const nonce = new URL(frame.src).searchParams.get("nonce");
    const identity = {
      channel: "reader-epub-event",
      version: 1,
      bookId: "book-1",
      sourceRevision: "rev-1",
      nonce,
    };
    window.dispatchEvent(new MessageEvent("message", {
      origin: "reader-rendition://epub",
      source: frame.contentWindow,
      data: { ...identity, event: "ready" },
    }));
    window.dispatchEvent(new MessageEvent("message", {
      origin: "reader-rendition://epub",
      source: frame.contentWindow,
      data: {
        ...identity,
        event: "keystroke",
        binding: { code: "Escape", ctrl: false, alt: false, shift: false, meta: false },
      },
    }));
    await waitFor(() => expect(
      screen.getByLabelText("阅读外观", { selector: "aside" }),
    ).toHaveAttribute("data-open", "false"));
    window.dispatchEvent(new MessageEvent("message", {
      origin: "reader-rendition://epub",
      source: frame.contentWindow,
      data: {
        ...identity,
        event: "keystroke",
        binding: { code: "Escape", ctrl: false, alt: false, shift: false, meta: false },
      },
    }));
    await waitFor(() => expect(onBack).toHaveBeenCalledOnce());
  });

  it("persists EPUB flow and disables column controls while scrolling", async () => {
    const readerApi = api();
    const onAppearanceChange = vi.fn();
    const appearance = {
      ...DefaultReadingAppearance,
      epubFlow: "scrolled" as const,
      epubColumns: "single" as const,
    };
    render(<ReaderView
      api={readerApi}
      details={details}
      appearance={appearance}
      shortcuts={DefaultReaderShortcutProfile}
      onAppearanceChange={onAppearanceChange}
      onShortcutsChange={vi.fn()}
      onBack={vi.fn()}
    />);

    fireEvent.keyDown(window, { code: "KeyV" });
    expect(screen.getByRole("button", { name: "滚动阅读" })).toHaveAttribute("data-active", "true");
    expect(screen.getByRole("button", { name: "单栏阅读" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "双栏阅读" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "分页阅读" }));
    await waitFor(() => expect(readerApi.settings.updateAppearance).toHaveBeenCalledWith(
      expect.objectContaining({ epubFlow: "paginated", epubColumns: "single" }),
    ));
    expect(onAppearanceChange).toHaveBeenCalledWith(expect.objectContaining({ epubFlow: "paginated" }));
  });

  it("opens the runner with the saved EPUB layout before it becomes visible", async () => {
    const appearance = {
      ...DefaultReadingAppearance,
      epubFlow: "scrolled" as const,
      epubColumns: "single" as const,
      measure: 880,
    };
    render(<ReaderView
      api={api()}
      details={details}
      appearance={appearance}
      shortcuts={DefaultReaderShortcutProfile}
      onAppearanceChange={vi.fn()}
      onShortcutsChange={vi.fn()}
      onBack={vi.fn()}
    />);
    const frame = await screen.findByTitle("EPUB 正文") as HTMLIFrameElement;
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");

    fireEvent.load(frame);

    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      command: "open",
      appearance: expect.objectContaining({
        epubFlow: "scrolled",
        epubColumns: "single",
        measure: 880,
      }),
    }), "reader-rendition://epub", expect.any(Array));
  });

  it("exposes internal-link back and forward only when the runner reports them", async () => {
    render(<ReaderView
      api={api()}
      details={details}
      appearance={DefaultReadingAppearance}
      shortcuts={DefaultReaderShortcutProfile}
      onAppearanceChange={vi.fn()}
      onShortcutsChange={vi.fn()}
      onBack={vi.fn()}
    />);
    const frame = await screen.findByTitle("EPUB 正文") as HTMLIFrameElement;
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
    const nonce = new URL(frame.src).searchParams.get("nonce");
    const envelope = {
      channel: "reader-epub-event",
      version: 1,
      bookId: "book-1",
      sourceRevision: "rev-1",
      nonce,
    };
    window.dispatchEvent(new MessageEvent("message", {
      origin: "reader-rendition://epub",
      source: frame.contentWindow,
      data: { ...envelope, event: "ready" },
    }));
    fireEvent.keyDown(window, { code: "KeyV" });
    expect(screen.queryByRole("button", { name: "返回刚才的位置" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "再次前进" })).not.toBeInTheDocument();

    window.dispatchEvent(new MessageEvent("message", {
      origin: "reader-rendition://epub",
      source: frame.contentWindow,
      data: {
        ...envelope,
        event: "history-state",
        canGoBack: true,
        canGoForward: false,
      },
    }));
    await waitFor(() => expect(
      screen.getByRole("button", { name: "返回刚才的位置" }),
    ).toBeEnabled());
    expect(screen.queryByRole("button", { name: "再次前进" })).not.toBeInTheDocument();
    expect(screen.getByTestId("reader-hints")).toHaveTextContent("可返回链接原处");

    fireEvent.click(screen.getByRole("button", { name: "返回刚才的位置" }));
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: "historyBack" }),
      "reader-rendition://epub",
    );
  });

  it("shows saved total progression and updates it from a trusted relocation event", async () => {
    render(<ReaderView api={api()} details={{ ...details, savedLocation: restoredLocation }} appearance={DefaultReadingAppearance} shortcuts={DefaultReaderShortcutProfile} onAppearanceChange={vi.fn()} onShortcutsChange={vi.fn()} onBack={vi.fn()} />);
    const hints = screen.getByTestId("reader-hints");
    expect(hints).toHaveTextContent("42%");

    const frame = await screen.findByTitle("EPUB 正文") as HTMLIFrameElement;
    const nonce = new URL(frame.src).searchParams.get("nonce");
    window.dispatchEvent(new MessageEvent("message", {
      origin: "reader-rendition://epub",
      source: frame.contentWindow,
      data: {
        channel: "reader-epub-event",
        version: 1,
        bookId: "book-1",
        sourceRevision: "rev-1",
        nonce,
        event: "ready",
      },
    }));
    const moved = { ...restoredLocation, progression: { resource: 0.7, total: 0.73 } };
    window.dispatchEvent(new MessageEvent("message", {
      origin: "reader-rendition://epub",
      source: frame.contentWindow,
      data: {
        channel: "reader-epub-event",
        version: 1,
        bookId: "book-1",
        sourceRevision: "rev-1",
        nonce,
        event: "relocated",
        location: moved,
      },
    }));

    await waitFor(() => expect(hints).toHaveTextContent("73%"));
    expect(JSON.stringify(moved)).not.toMatch(/pageNumber|displayPage/i);
  });
  it("shows an indeterminate state whenever total progression is unavailable", async () => {
    render(<ReaderView api={api()} details={details} appearance={DefaultReadingAppearance} shortcuts={DefaultReaderShortcutProfile} onAppearanceChange={vi.fn()} onShortcutsChange={vi.fn()} onBack={vi.fn()} />);
    const hints = screen.getByTestId("reader-hints");
    expect(hints).toHaveTextContent("计算中");

    const frame = await screen.findByTitle("EPUB 正文") as HTMLIFrameElement;
    const nonce = new URL(frame.src).searchParams.get("nonce");
    window.dispatchEvent(new MessageEvent("message", {
      origin: "reader-rendition://epub",
      source: frame.contentWindow,
      data: {
        channel: "reader-epub-event",
        version: 1,
        bookId: "book-1",
        sourceRevision: "rev-1",
        nonce,
        event: "ready",
      },
    }));
    window.dispatchEvent(new MessageEvent("message", {
      origin: "reader-rendition://epub",
      source: frame.contentWindow,
      data: {
        channel: "reader-epub-event",
        version: 1,
        bookId: "book-1",
        sourceRevision: "rev-1",
        nonce,
        event: "relocated",
        location: { ...restoredLocation, progression: { resource: 0.7 } },
      },
    }));

    await waitFor(() => expect(hints).toHaveTextContent("计算中"));
    expect(hints).not.toHaveTextContent(/0%|42%|73%/);
  });

  it("dispatches page commands received from the trusted EPUB frame", async () => {
    render(<ReaderView api={api()} details={details} appearance={DefaultReadingAppearance} shortcuts={DefaultReaderShortcutProfile} onAppearanceChange={vi.fn()} onShortcutsChange={vi.fn()} onBack={vi.fn()} />);
    const frame = await screen.findByTitle("EPUB 正文") as HTMLIFrameElement;
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
    const nonce = new URL(frame.src).searchParams.get("nonce");
    const identity = {
      channel: "reader-epub-event",
      version: 1,
      bookId: "book-1",
      sourceRevision: "rev-1",
      nonce,
    };

    window.dispatchEvent(new MessageEvent("message", {
      origin: "reader-rendition://epub",
      source: frame.contentWindow,
      data: { ...identity, event: "ready" },
    }));
    window.dispatchEvent(new MessageEvent("message", {
      origin: "reader-rendition://epub",
      source: frame.contentWindow,
      data: {
        ...identity,
        event: "keystroke",
        binding: { code: "KeyD", ctrl: false, alt: false, shift: false, meta: false },
      },
    }));

    await waitFor(() => expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: "next" }),
      "reader-rendition://epub",
    ));
    const nextCalls = () => postMessage.mock.calls.filter(
      ([message]) => (message as { command?: string }).command === "next",
    ).length;
    expect(nextCalls()).toBe(1);

    window.dispatchEvent(new MessageEvent("message", {
      origin: "reader-rendition://epub",
      source: frame.contentWindow,
      data: {
        ...identity,
        event: "keystroke",
        binding: { code: "KeyC", ctrl: false, alt: false, shift: false, meta: false },
      },
    }));
    await waitFor(() => expect(
      screen.getByRole("complementary", { name: "目录" }),
    ).toHaveAttribute("data-open", "true"));
    window.dispatchEvent(new MessageEvent("message", {
      origin: "reader-rendition://epub",
      source: frame.contentWindow,
      data: {
        ...identity,
        event: "keystroke",
        binding: { code: "KeyD", ctrl: false, alt: false, shift: false, meta: false },
      },
    }));
    expect(nextCalls()).toBe(1);
  });

});
