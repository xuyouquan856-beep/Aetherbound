export type CapturedPosition<TAnchor, TLocation> = {
  anchor: TAnchor | null;
  fallback: TLocation | null;
};

type Dependencies<TLayout, TAnchor, TLocation> = {
  capture(): CapturedPosition<TAnchor, TLocation>;
  apply(layout: TLayout): Promise<void>;
  waitForStable(): Promise<void>;
  restore(position: CapturedPosition<TAnchor, TLocation>): Promise<void>;
  readLocation(): TLocation | null;
  onActiveChange(active: boolean): void;
  onStarted(transactionId: number): void;
  onSettled(transactionId: number, location: TLocation): void;
};

export class LayoutTransactionCoordinator<TLayout, TAnchor, TLocation> {
  private pending: { transactionId: number; layout: TLayout } | null = null;
  private running: Promise<void> | null = null;
  private latestTransactionId = 0;
  private disposed = false;

  constructor(private readonly dependencies: Dependencies<TLayout, TAnchor, TLocation>) {}

  request(request: { transactionId: number; layout: TLayout }) {
    if (this.disposed) return Promise.resolve();
    this.latestTransactionId = Math.max(this.latestTransactionId, request.transactionId);
    this.pending = request;
    if (!this.running) {
      this.running = this.drain().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  dispose() {
    this.disposed = true;
    this.pending = null;
  }

  private async drain() {
    this.dependencies.onActiveChange(true);
    try {
      while (this.pending && !this.disposed) {
        const request = this.pending;
        this.pending = null;
        this.dependencies.onStarted(request.transactionId);
        const position = this.dependencies.capture();
        await this.dependencies.apply(request.layout);
        if (this.disposed) break;
        await this.dependencies.waitForStable();
        if (this.disposed) break;
        await this.dependencies.restore(position);
        if (this.disposed) break;
        await this.dependencies.waitForStable();
        if (this.disposed) break;
        const location = this.dependencies.readLocation();
        if (location !== null && request.transactionId === this.latestTransactionId) {
          this.dependencies.onSettled(request.transactionId, location);
        }
      }
    } finally {
      this.dependencies.onActiveChange(false);
    }
  }
}

export async function restoreCapturedPosition<TAnchor, TLocation>(
  position: CapturedPosition<TAnchor, TLocation>,
  dependencies: {
    goToAnchor(anchor: TAnchor): Promise<void>;
    restoreFallback(location: TLocation): Promise<void>;
  },
) {
  if (position.anchor !== null) {
    try {
      await dependencies.goToAnchor(position.anchor);
      return;
    } catch {
      // The fallback locator is intentionally tried below.
    }
  }
  if (position.fallback !== null) {
    await dependencies.restoreFallback(position.fallback);
  }
}
