export interface SpendAlertWatcherOptions {
  /** Alert once the server's spend of the UTC day reaches this many dollars. */
  thresholdUsd: number;
  /** The invite whose devices are told. */
  ownerInvite: string;
  /** What the server spent today, settled and held. */
  spentToday(): number;
  /** Tells the owner's devices; a device is told once per key however often this is called. */
  alert(inviteId: string, key: string): Promise<void>;
  now?: () => number;
  /** How often spend is read (default 1 minute). */
  pollMs?: number;
  /** Longest `close` waits for a tick in flight. */
  closeWaitMs?: number;
  /** Called once per UTC day, when the threshold is first seen to be reached. */
  onAlert?: (day: string) => void;
  onWarning?: (message: string, detail?: unknown) => void;
}

/**
 * Watches the day's spend and, once it reaches the threshold, asks for the owner's devices to be
 * told. Every tick while the spend is at or past the threshold asks again, which sends nothing to a
 * device already told that day and tells one that subscribed since, so a restart repeats nothing.
 * One tick runs at a time; `close` ends the timer and waits (for a bounded time) for the tick in
 * flight.
 */
export class SpendAlertWatcher {
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private reported: string | undefined;
  private closed = false;

  constructor(private readonly options: SpendAlertWatcherOptions) {}

  /** Ticks at once, then every `pollMs`. */
  start(): void {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.options.pollMs ?? 60_000);
    void this.tick();
  }

  /** One look. Resolves when it is done; a tick already running is joined, not repeated. */
  tick(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    const run = async (): Promise<void> => {
      try {
        const day = new Date((this.options.now ?? Date.now)()).toISOString().slice(0, 10);
        const spent = this.options.spentToday();
        if (!Number.isFinite(spent) || spent < this.options.thresholdUsd) return;
        await this.options.alert(this.options.ownerInvite, `spend:${day}`);
        if (this.reported !== day) {
          this.reported = day;
          this.options.onAlert?.(day);
        }
      } catch (error) {
        this.options.onWarning?.('The spend alert failed; trying again', error);
      }
    };
    const tracked = run().finally(() => {
      if (this.inFlight === tracked) this.inFlight = undefined;
    });
    this.inFlight = tracked;
    return tracked;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const pending = this.inFlight;
    if (!pending) return;
    let timeout: NodeJS.Timeout | undefined;
    const gaveUp = new Promise<'late'>((resolve) => {
      timeout = setTimeout(() => resolve('late'), this.options.closeWaitMs ?? 5_000);
    });
    try {
      if ((await Promise.race([pending.then(() => 'done' as const), gaveUp])) === 'late') {
        this.options.onWarning?.('A spend alert was still being sent when the stack closed');
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}
