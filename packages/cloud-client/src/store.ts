/**
 * A small observable value, shaped for React's `useSyncExternalStore` (`subscribe` and
 * `getSnapshot` are bound, and a snapshot is replaced, never changed in place). The web app and the
 * phone apps both read the flows below through it, so the flows themselves have no UI framework.
 */
export class Store<S> {
  private readonly listeners = new Set<() => void>();
  private current: S;

  constructor(initial: S) {
    this.current = initial;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): S => this.current;

  /** Replaces the snapshot with `next(current)`; an unchanged snapshot tells nobody. */
  protected update(next: (current: S) => S): void {
    const value = next(this.current);
    if (value === this.current) return;
    this.current = value;
    for (const listener of [...this.listeners]) listener();
  }

  protected patch(part: Partial<S>): void {
    this.update((current) => ({ ...current, ...part }));
  }
}
