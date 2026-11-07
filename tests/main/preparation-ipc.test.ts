import { beforeEach, describe, expect, it, vi } from "vitest";
import { channels } from "../../src/shared/ipc.js";

const electronState = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>(),
  sent: [] as Array<{ channel: string; payload: unknown }>,
}));

vi.mock("electron", () => {
  const trustedWebContents = {
    getURL: () => "reader-app://bundle/index.html",
    send: (channel: string, payload: unknown) => {
      electronState.sent.push({ channel, payload });
    },
  };
  const untrustedWebContents = {
    getURL: () => "reader-rendition://epub/epub-runner.html",
    send: vi.fn(),
  };
  return {
    app: {
      isPackaged: true,
      getVersion: () => "0.4.1",
    },
    BrowserWindow: {
      getAllWindows: () => [
        { webContents: trustedWebContents },
        { webContents: untrustedWebContents },
      ],
    },
    dialog: {
      showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
    },
    ipcMain: {
      handle: (
        channel: string,
        handler: (event: unknown, payload: unknown) => Promise<unknown>,
      ) => electronState.handlers.set(channel, handler),
    },
  };
});

import { registerIpc } from "../../src/main/ipc/register-ipc.js";
import { shouldExposeReaderApi } from "../../src/preload/index.js";
import { createScanServicesStub } from "./scan-services-stub.js";

const summary = {
  id: "book-1",
  title: "Queued",
  author: null,
  format: "epub" as const,
  availabilityStatus: "available" as const,
  progress: 0,
  addedAt: "2026-07-29T00:00:00.000Z",
  lastReadAt: null,
  updatedAt: "2026-07-29T00:00:00.000Z",
  coverUrl: null,
  preparationStatus: "queued" as const,
  preparationErrorCode: null,
};

function trustedEvent() {
  const frame = { url: "reader-app://bundle/index.html" };
  return {
    senderFrame: frame,
    sender: { mainFrame: frame, send: vi.fn() },
  };
}

function services() {
  const order: string[] = [];
  let preparationListener: ((event: unknown) => void) | null = null;
  const value = {
    preparations: {
      subscribe: vi.fn((listener) => {
        preparationListener = listener;
        return () => undefined;
      }),
      ensureReady: vi.fn(async () => {
        order.push("ensure");
      }),
      retry: vi.fn(async () => undefined),
    },
    library: {
      getBook: vi.fn(() => summary),
      readPublication: vi.fn(async () => {
        order.push("read");
        return {
          bookId: "book-1",
          sourceRevision: "revision-1",
          metadata: { title: "Queued", author: null, language: null },
          toc: [],
          spine: [{ index: 0, href: "chapter.xhtml", linear: true }],
        };
      }),
      getSourceForBook: vi.fn(() => ({ sourceRevision: "revision-1" })),
    },
    progress: { get: vi.fn(() => null) },
    sessions: { openSession: vi.fn(() => "session-1") },
    scan: createScanServicesStub(),
  };
  return {
    value: value as never,
    order,
    emit: (event: unknown) => preparationListener?.(event),
  };
}

beforeEach(() => {
  electronState.handlers.clear();
  electronState.sent.length = 0;
});

describe("preparation IPC boundary", () => {
  it("validates bounded retry IDs before invoking the coordinator", async () => {
    const fixture = services();
    registerIpc(fixture.value);
    const retry = electronState.handlers.get(channels.libraryPreparationRetry)!;

    await retry(trustedEvent(), { bookId: "book-1" });
    expect((fixture.value as any).preparations.retry).toHaveBeenCalledWith("book-1");
    await expect(
      retry(trustedEvent(), { bookId: "x".repeat(129) }),
    ).rejects.toThrow();
    await expect(
      retry(trustedEvent(), { bookId: "E:\\private\\book.epub" }),
    ).rejects.toThrow();
  });

  it("awaits readiness before reading an EPUB publication", async () => {
    const fixture = services();
    registerIpc(fixture.value);
    const open = electronState.handlers.get(channels.readerOpen)!;

    await open(trustedEvent(), { bookId: "book-1" });

    expect(fixture.order).toEqual(["ensure", "read"]);
  });

  it("broadcasts only schema-validated path-free events to the trusted top frame", () => {
    const fixture = services();
    registerIpc(fixture.value);

    fixture.emit({
      bookId: "book-1",
      sourceRevision: "revision-1",
      state: "ready",
      errorCode: null,
    });

    expect(electronState.sent).toEqual([{
      channel: channels.libraryPreparationChanged,
      payload: {
        bookId: "book-1",
        sourceRevision: "revision-1",
        state: "ready",
        errorCode: null,
      },
    }]);
    expect(() => fixture.emit({
      bookId: "book-1",
      sourceRevision: "revision-1",
      state: "error",
      errorCode: "INVALID_PACKAGE",
      sourcePath: "E:\\private\\book.epub",
    })).toThrow();
  });

  it("never exposes the reader API inside the rendition iframe", () => {
    expect(shouldExposeReaderApi(true)).toBe(true);
    expect(shouldExposeReaderApi(false)).toBe(false);
  });

  it("serves EPUB bytes only to a trusted top frame with a strict identity", async () => {
    const fixture = services();
    (fixture.value as any).epubBinary = {
      read: vi.fn(async (request) => ({
        ...request,
        mediaType: "application/epub+zip",
        bytes: new Uint8Array([1, 2, 3]),
      })),
    };
    registerIpc(fixture.value);
    const read = electronState.handlers.get(channels.readerEpubBinary)!;

    await expect(read(trustedEvent(), {
      bookId: "book-1",
      sourceRevision: "revision-1",
    })).resolves.toMatchObject({ bytes: new Uint8Array([1, 2, 3]) });

    await expect(read(trustedEvent(), {
      bookId: "book-1",
      sourceRevision: "revision-1",
      path: "E:\\private\\book.epub",
    })).rejects.toThrow();

    const childFrame = { url: "reader-rendition://epub/epub-runner.html" };
    await expect(read({
      senderFrame: childFrame,
      sender: { mainFrame: { url: "reader-app://bundle/index.html" } },
    }, {
      bookId: "book-1",
      sourceRevision: "revision-1",
    })).rejects.toThrow();
  });
});
