export type ReaderOpenPhase =
  | "selected"
  | "details-ready"
  | "rendition-mounted"
  | "publication-opened"
  | "restore-complete"
  | "stable-paint"
  | "interactive";

export type ReaderOpenTrace = {
  id: string;
  bookId: string;
  startedAt: number;
  marks: Partial<Record<ReaderOpenPhase, number>>;
};

type Options = {
  now?: () => number;
  createId?: () => string;
};

const phases = new Set<ReaderOpenPhase>([
  "selected",
  "details-ready",
  "rendition-mounted",
  "publication-opened",
  "restore-complete",
  "stable-paint",
  "interactive",
]);

export class ReaderOpenTraceStore {
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly active = new Map<string, ReaderOpenTrace>();
  private readonly history: ReaderOpenTrace[] = [];

  constructor(options: Options = {}) {
    this.now = options.now ?? (() => performance.now());
    this.createId = options.createId ?? (() => crypto.randomUUID());
  }

  start(bookId: string) {
    if (!bookId || bookId.length > 128 || /[\\/:]/.test(bookId)) {
      throw new Error("INVALID_READER_TRACE_BOOK_ID");
    }
    const startedAt = this.now();
    const trace: ReaderOpenTrace = {
      id: this.createId(),
      bookId,
      startedAt,
      marks: { selected: startedAt },
    };
    this.active.set(trace.id, trace);
    return trace.id;
  }

  mark(id: string, phase: ReaderOpenPhase) {
    if (!phases.has(phase)) throw new Error("INVALID_READER_OPEN_PHASE");
    const trace = this.active.get(id);
    if (!trace) return;
    const value = this.now();
    const latest = Math.max(trace.startedAt, ...Object.values(trace.marks));
    trace.marks[phase] = Math.max(latest, value);
    if (phase === "interactive") {
      this.active.delete(id);
      this.history.push({
        ...trace,
        marks: { ...trace.marks },
      });
      if (this.history.length > 20) {
        this.history.splice(0, this.history.length - 20);
      }
    }
  }

  completed() {
    return this.history.map((trace) => ({
      ...trace,
      marks: { ...trace.marks },
    }));
  }
}

export const readerOpenTraces = new ReaderOpenTraceStore();

type TraceDebugTarget = Record<string, unknown>;
const debugKey = "__AETHERBOUND_READER_TRACES__";

export function installReaderOpenTraceDebugTarget(
  target: TraceDebugTarget,
  store: ReaderOpenTraceStore,
  enabled: boolean,
) {
  if (!enabled) return;
  Object.defineProperty(target, debugKey, {
    configurable: true,
    enumerable: false,
    value: () => store.completed(),
    writable: false,
  });
}
