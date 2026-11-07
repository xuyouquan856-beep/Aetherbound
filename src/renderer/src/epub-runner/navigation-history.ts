export class NavigationHistory<T> {
  private entries: T[] = [];
  private index = -1;

  constructor(private readonly limit = 50) {}

  get state() {
    return {
      canGoBack: this.index > 0,
      canGoForward: this.index >= 0 && this.index < this.entries.length - 1,
    };
  }

  visit(from: T, to: T) {
    if (Object.is(from, to)) return;
    this.entries.length = this.index + 1;
    if (this.index < 0 || !Object.is(this.entries[this.index], from)) {
      this.entries.push(from);
      this.index = this.entries.length - 1;
    }
    if (!Object.is(this.entries[this.index], to)) {
      this.entries.push(to);
      this.index = this.entries.length - 1;
    }
    this.trim();
  }

  back(): T | null {
    if (!this.state.canGoBack) return null;
    this.index -= 1;
    return this.entries[this.index] ?? null;
  }

  forward(): T | null {
    if (!this.state.canGoForward) return null;
    this.index += 1;
    return this.entries[this.index] ?? null;
  }

  clear() {
    this.entries = [];
    this.index = -1;
  }

  private trim() {
    const overflow = this.entries.length - Math.max(1, this.limit);
    if (overflow <= 0) return;
    this.entries.splice(0, overflow);
    this.index = Math.max(0, this.index - overflow);
  }
}
