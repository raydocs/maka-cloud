export interface BackupSchedulerOptions {
  /** When the newest finished backup was made, in ms; undefined when there is none. */
  latest(): Promise<number | undefined>;
  /** Makes one backup. A rejection is reported and tried again after `retryAfterMs`. */
  run(): Promise<unknown>;
  now?: () => number;
  /** How often to look (default 5 minutes). */
  tickMs?: number;
  /** Delay before the first look, so a start is not slowed by a backup (default 1 minute). */
  firstTickMs?: number;
  /** Wait after a failed backup (default 1 hour). */
  retryAfterMs?: number;
  /** Longest `close` waits for a backup in flight. */
  closeWaitMs?: number;
  onWarning?: (message: string, detail?: unknown) => void;
}

const DAY_MS = 86_400_000;

/**
 * Makes one backup per UTC day. The newest backup on disk decides, so a restart neither repeats
 * the day's backup nor skips it. One backup runs at a time. `close` ends the timers and waits (for
 * a bounded time) for the backup in flight, so nothing runs after the stack closes.
 */
export class BackupScheduler {
  private timer: NodeJS.Timeout | undefined;
  private first: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private retryAt = 0;
  private closed = false;

  constructor(private readonly options: BackupSchedulerOptions) {}

  start(): void {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.options.tickMs ?? 300_000);
    this.timer.unref();
    this.first = setTimeout(() => void this.tick(), this.options.firstTickMs ?? 60_000);
    this.first.unref();
  }

  /** One look. Resolves when it is done; a backup already running is joined, not repeated. */
  tick(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    const now = this.options.now ?? Date.now;
    const run = async (): Promise<void> => {
      try {
        if (now() < this.retryAt) return;
        const latest = await this.options.latest();
        if (latest !== undefined && Math.floor(latest / DAY_MS) >= Math.floor(now() / DAY_MS)) {
          return;
        }
        await this.options.run();
      } catch (error) {
        this.retryAt = now() + (this.options.retryAfterMs ?? 3_600_000);
        this.options.onWarning?.('The daily backup failed; trying again later', error);
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
    if (this.first) clearTimeout(this.first);
    this.timer = undefined;
    this.first = undefined;
    const pending = this.inFlight;
    if (!pending) return;
    let timeout: NodeJS.Timeout | undefined;
    const gaveUp = new Promise<'late'>((resolve) => {
      timeout = setTimeout(() => resolve('late'), this.options.closeWaitMs ?? 10_000);
    });
    try {
      if ((await Promise.race([pending.then(() => 'done' as const), gaveUp])) === 'late') {
        this.options.onWarning?.('A backup was still running when the stack closed');
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}
