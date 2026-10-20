export interface SpendAlertWatcherOptions {
  /** Alert once the server's spend of the UTC day reaches this many dollars. */
  thresholdUsd: number;
  /** The invite whose devices are told. */
  ownerInvite: string;
  /** What the server spent today, settled and held. */
  spentToday(): number;
  /**
   * Tells the owner's devices; a device is told once per key however often this is called.
   * Resolves `false` when some device is still owed because the push service failed.
   */
  alert(inviteId: string, key: string): Promise<boolean>;
  now?: () => number;
  /** How often spend is read (default 1 minute). */
  pollMs?: number;
  /** Longest `close` waits for a tick in flight. */
  closeWaitMs?: number;
  /** Called once per UTC day, when the threshold is first seen to be reached. */
  onAlert?: (day: string) => void;
  onWarning?: (message: string, detail?: unknown) => void;
}

/** The longest wait between attempts when the push service keeps failing. */
const MAX_BACKOFF_MS = 15 * 60_000;

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
  /** Consecutive rounds that left a device owed, and when the timer may try again. */
  private failures = 0;
  private retryAt = 0;

  constructor(private readonly options: SpendAlertWatcherOptions) {}

  /** Ticks at once, then every `pollMs`. */
  start(): void {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => void this.tick(true), this.options.pollMs ?? 60_000);
    void this.tick(true);
  }

  /**
   * One look. Resolves when it is done; a tick already running is joined, not repeated. The timer's
   * own ticks (`scheduled`) wait out the backoff after a round that left a device owed; a look
   * asked for by hand does not.
   */
  tick(scheduled = false): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    if (scheduled && (this.options.now ?? Date.now)() < this.retryAt) return Promise.resolve();
    const run = async (): Promise<void> => {
      try {
        const day = new Date((this.options.now ?? Date.now)()).toISOString().slice(0, 10);
        const spent = this.options.spentToday();
        if (!Number.isFinite(spent) || spent < this.options.thresholdUsd) return;
        const complete = await this.options.alert(this.options.ownerInvite, `spend:${day}`);
        if (!complete) {
          // The push service failed for some device: still owed, so try again, with growing waits.
          this.failures += 1;
          const wait = Math.min(
            (this.options.pollMs ?? 60_000) * 2 ** this.failures,
            MAX_BACKOFF_MS,
          );
          this.retryAt = (this.options.now ?? Date.now)() + wait;
          this.options.onWarning?.(
            'The spend alert did not reach every device; trying again later',
          );
          return;
        }
        this.failures = 0;
        this.retryAt = 0;
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
