interface Timer {
  id: number;
  at: number;
  fn: () => void;
}

/**
 * Replaces the global `setTimeout` and `clearTimeout` while installed, so wait
 * timeouts fire only when the scheduler advances the clock. The orchestrator's
 * `now` reads the same clock.
 */
export class FakeClock {
  now = 1_000_000;
  private readonly timers = new Map<number, Timer>();
  private nextId = 1;

  install(): () => void {
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      const id = this.nextId++;
      this.timers.set(id, { id, at: this.now + Math.max(ms ?? 0, 0), fn });
      return id;
    }) as unknown as typeof globalThis.setTimeout;
    globalThis.clearTimeout = ((id: unknown) => {
      if (typeof id === 'number') this.timers.delete(id);
    }) as typeof globalThis.clearTimeout;
    return () => {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    };
  }

  get pending(): number {
    return this.timers.size;
  }

  /** Moves the clock to the earliest timer and fires every timer due by then, in order. */
  fireNext(): string {
    const due = this.ordered();
    const first = due[0];
    if (!first) return 'no timers';
    this.now = Math.max(this.now, first.at);
    let fired = 0;
    for (const timer of due) {
      if (timer.at > this.now) break;
      if (!this.timers.delete(timer.id)) continue;
      fired += 1;
      timer.fn();
    }
    return `now=${this.now} fired=${fired}`;
  }

  advance(ms: number): string {
    this.now += ms;
    let fired = 0;
    for (const timer of this.ordered()) {
      if (timer.at > this.now) break;
      if (!this.timers.delete(timer.id)) continue;
      fired += 1;
      timer.fn();
    }
    return `+${ms}ms now=${this.now} fired=${fired}`;
  }

  /** Timers of a process that died never fire. */
  dropAll(): void {
    this.timers.clear();
  }

  private ordered(): Timer[] {
    return [...this.timers.values()].sort((a, b) => a.at - b.at || a.id - b.id);
  }
}
