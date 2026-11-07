import {
  PublicPreparationEventSchema,
  type PublicPreparationEvent,
} from "../../shared/contracts.js";
import {
  ReaderError,
  type ReaderErrorCode,
} from "../../shared/errors.js";
import type { EpubPreparationService } from "./epub-preparation-service.js";
import type { BookPreparationJobRepository } from "./book-preparation-job-repository.js";

type Runtime = {
  now(): string;
  defer(callback: () => void): void;
};

type Waiter = {
  resolve(): void;
  reject(error: ReaderError): void;
};

export class BookPreparationCoordinator {
  private active: Promise<void> | null = null;
  private readonly singleFlights = new Map<string, Promise<void>>();
  private readonly listeners = new Set<(event: PublicPreparationEvent) => void>();
  private readonly waiters = new Map<string, Set<Waiter>>();
  private stopped = false;
  private started = false;
  private pumpScheduled = false;
  private readonly runtime: Runtime;

  constructor(
    private readonly jobs: BookPreparationJobRepository,
    private readonly preparation: Pick<EpubPreparationService, "prepare">,
    runtime: Partial<Runtime> = {},
  ) {
    this.runtime = {
      now: runtime.now ?? (() => new Date().toISOString()),
      defer: runtime.defer ?? ((callback) => setImmediate(callback)),
    };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.jobs.recoverInterrupted(this.runtime.now());
    this.schedulePump();
  }

  async ensureReady(bookId: string): Promise<void> {
    if (!this.started) this.start();
    if (this.stopped) {
      throw new ReaderError("CANCELLED", "Book preparation is stopping.");
    }
    let job = this.jobs.get(bookId);
    if (!job) {
      throw new ReaderError("BOOK_NOT_FOUND", "Book preparation job not found.");
    }
    if (job.state === "ready") return;
    if (job.state === "error") {
      throw new ReaderError(
        job.errorCode ?? "INTERNAL_ERROR",
        "Book preparation failed.",
      );
    }
    if (job.state === "queued") {
      job = this.jobs.promote(
        bookId,
        job.sourceRevision,
        this.runtime.now(),
      );
    }
    const waiting = this.waitForReady(bookId, job.sourceRevision);
    this.schedulePump();
    return waiting;
  }

  async retry(bookId: string): Promise<void> {
    if (!this.started) this.start();
    if (this.stopped) {
      throw new ReaderError("CANCELLED", "Book preparation is stopping.");
    }
    const current = this.jobs.get(bookId);
    if (!current) {
      throw new ReaderError("BOOK_NOT_FOUND", "Book preparation job not found.");
    }
    if (current.state === "ready") return;
    if (current.state === "error") {
      this.jobs.retry(
        bookId,
        current.sourceRevision,
        this.runtime.now(),
      );
    } else if (current.state === "queued") {
      this.jobs.promote(
        bookId,
        current.sourceRevision,
        this.runtime.now(),
      );
    }
    const waiting = this.waitForReady(bookId, current.sourceRevision);
    this.schedulePump();
    return waiting;
  }

  subscribe(listener: (event: PublicPreparationEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  notifyQueued(): void {
    if (!this.started) {
      this.start();
      return;
    }
    this.schedulePump();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const active = this.active;
    if (active) await active;
    const cancelled = new ReaderError("CANCELLED", "Book preparation stopped.");
    for (const key of [...this.waiters.keys()]) {
      this.settleWaiters(key, cancelled);
    }
  }

  private schedulePump() {
    if (this.stopped || this.active || this.pumpScheduled) return;
    this.pumpScheduled = true;
    this.runtime.defer(() => {
      this.pumpScheduled = false;
      this.pump();
    });
  }

  private pump() {
    if (this.stopped || this.active) return;
    const job = this.jobs.nextQueued();
    if (!job) return;
    if (!this.jobs.markPreparing(
      job.bookId,
      job.sourceRevision,
      this.runtime.now(),
    )) {
      this.schedulePump();
      return;
    }

    const key = this.key(job.bookId, job.sourceRevision);
    const flight = Promise.resolve().then(() =>
      this.execute(job.bookId, job.sourceRevision),
    );
    this.singleFlights.set(key, flight);
    this.active = flight;
    void flight.finally(() => {
      if (this.singleFlights.get(key) === flight) {
        this.singleFlights.delete(key);
      }
      if (this.active === flight) this.active = null;
      this.schedulePump();
    });
  }

  private async execute(bookId: string, sourceRevision: string) {
    const key = this.key(bookId, sourceRevision);
    try {
      await this.preparation.prepare(bookId, sourceRevision);
      if (this.jobs.markReady(
        bookId,
        sourceRevision,
        this.runtime.now(),
      )) {
        this.emit({
          bookId,
          sourceRevision,
          state: "ready",
          errorCode: null,
        });
        this.settleWaiters(key);
      } else {
        this.settleObsolete(key, bookId);
      }
    } catch (error) {
      const code = this.errorCode(error);
      if (this.jobs.markError(
        bookId,
        sourceRevision,
        code,
        this.runtime.now(),
      )) {
        this.emit({
          bookId,
          sourceRevision,
          state: "error",
          errorCode: code,
        });
        this.settleWaiters(
          key,
          new ReaderError(code, "Book preparation failed."),
        );
      } else {
        this.settleObsolete(key, bookId);
      }
    }
  }

  private waitForReady(bookId: string, sourceRevision: string): Promise<void> {
    const key = this.key(bookId, sourceRevision);
    const flight = this.singleFlights.get(key);
    if (flight) {
      return flight.then(() => this.assertReady(bookId, sourceRevision));
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject };
      const existing = this.waiters.get(key) ?? new Set<Waiter>();
      existing.add(waiter);
      this.waiters.set(key, existing);
      const current = this.jobs.get(bookId);
      if (!current) {
        this.settleWaiters(
          key,
          new ReaderError("BOOK_NOT_FOUND", "The book was deleted."),
        );
      } else if (current.sourceRevision !== sourceRevision) {
        this.settleWaiters(
          key,
          new ReaderError("SOURCE_CHANGED", "The source revision changed."),
        );
      } else if (current.state === "ready") {
        this.settleWaiters(key);
      } else if (current.state === "error") {
        this.settleWaiters(
          key,
          new ReaderError(
            current.errorCode ?? "INTERNAL_ERROR",
            "Book preparation failed.",
          ),
        );
      }
    });
  }

  private assertReady(bookId: string, sourceRevision: string) {
    const current = this.jobs.get(bookId);
    if (!current) {
      throw new ReaderError("BOOK_NOT_FOUND", "The book was deleted.");
    }
    if (current.sourceRevision !== sourceRevision) {
      throw new ReaderError("SOURCE_CHANGED", "The source revision changed.");
    }
    if (current.state !== "ready") {
      throw new ReaderError(
        current.errorCode ?? "INTERNAL_ERROR",
        "Book preparation failed.",
      );
    }
  }

  private settleObsolete(key: string, bookId: string) {
    const current = this.jobs.get(bookId);
    this.settleWaiters(
      key,
      new ReaderError(
        current ? "SOURCE_CHANGED" : "BOOK_NOT_FOUND",
        current ? "The source revision changed." : "The book was deleted.",
      ),
    );
  }

  private settleWaiters(key: string, error?: ReaderError) {
    const waiters = this.waiters.get(key);
    if (!waiters) return;
    this.waiters.delete(key);
    for (const waiter of waiters) {
      if (error) waiter.reject(error);
      else waiter.resolve();
    }
  }

  private emit(value: PublicPreparationEvent) {
    const event = PublicPreparationEventSchema.parse(value);
    for (const listener of this.listeners) listener(event);
  }

  private errorCode(error: unknown): ReaderErrorCode {
    return error instanceof ReaderError ? error.code : "INTERNAL_ERROR";
  }

  private key(bookId: string, sourceRevision: string) {
    return `${bookId}\0${sourceRevision}`;
  }
}
