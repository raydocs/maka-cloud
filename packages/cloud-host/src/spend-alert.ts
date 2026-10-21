/** An alert asked for and not yet delivered to every device. */
export interface OwedAlert {
  inviteId: string;
  key: string;
  /** When it was first asked for. */
  firstAt: number;
  /** Rounds that left a device owed. */
  failures: number;
  /** The earliest the timer may try again. */
  retryAt: number;
}

/** Where owed alerts are kept, so a restart (or a drop in spend) does not forget them. */
export interface OwedAlerts {
  save(alert: OwedAlert): void;
  list(): OwedAlert[];
  clear(inviteId: string, key: string): void;
}

/** Owed alerts kept in memory; for a watcher with nowhere better to put them. */
export class MemoryOwedAlerts implements OwedAlerts {
  private readonly owed = new Map<string, OwedAlert>();

  save(alert: OwedAlert): void {
    const known = this.owed.get(`${alert.inviteId}\n${alert.key}`);
    this.owed.set(`${alert.inviteId}\n${alert.key}`, {
      ...alert,
      firstAt: known?.firstAt ?? alert.firstAt,
    });
  }

  list(): OwedAlert[] {
    return [...this.owed.values()].sort((a, b) => a.firstAt - b.firstAt);
  }

  clear(inviteId: string, key: string): void {
    this.owed.delete(`${inviteId}\n${key}`);
  }
}

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
  /** Where an alert is kept from the moment it is asked for until it is delivered or given up. */
  owed?: OwedAlerts;
  now?: () => number;
  /** How often spend is read (default 1 minute). */
  pollMs?: number;
  /** Longest `close` waits for a tick in flight. */
  closeWaitMs?: number;
  /**
   * Called when an alert is dropped unsent because it is a day old, so its loss is not silent.
   * If it throws, the alert stays owed and this is called again at the next tick.
   */
  onDropped?(alert: OwedAlert): void | Promise<void>;
  /** Called once per UTC day, when the threshold is first seen to be reached. */
  onAlert?: (day: string) => void;
  onWarning?: (message: string, detail?: unknown) => void;
}

/** The longest wait between attempts when the push service keeps failing. */
const MAX_BACKOFF_MS = 15 * 60_000;

/** An alert still undelivered this long after it was asked for is about a day that is over. */
const GIVE_UP_AFTER_MS = 24 * 60 * 60_000;

/**
 * Watches the day's spend and, once it reaches the threshold, asks for the owner's devices to be
 * told. Every tick while the spend is at or past the threshold asks again, which sends nothing to a
 * device already told that day and tells one that subscribed since, so a restart repeats nothing.
 * An alert is written down as owed when it is first asked for, and each tick asks again for every
 * owed alert whatever the spend is now and whatever day it is, until every device was told or the
 * alert is a day old. One tick runs at a time; `close` ends the timer and waits (for a bounded
 * time) for the tick in flight.
 */
export class SpendAlertWatcher {
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private reported: string | undefined;
  private closed = false;
  private readonly owed: OwedAlerts;

  constructor(private readonly options: SpendAlertWatcherOptions) {
    this.owed = options.owed ?? new MemoryOwedAlerts();
  }

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
    const run = async (): Promise<void> => {
      const now = (): number => (this.options.now ?? Date.now)();
      // What is owed goes first, whatever the spend is now and whatever day it is.
      let owed: OwedAlert[] = [];
      try {
        owed = this.owed.list();
      } catch (error) {
        this.options.onWarning?.('The spend alert failed; trying again', error);
      }
      const asked = new Set<string>();
      for (const alert of owed) {
        asked.add(`${alert.inviteId}\n${alert.key}`);
        if (now() - alert.firstAt >= GIVE_UP_AFTER_MS) {
          await this.giveUp(alert);
          continue;
        }
        if (scheduled && now() < alert.retryAt) continue;
        await this.ask(alert);
      }
      try {
        const day = new Date(now()).toISOString().slice(0, 10);
        const spent = this.options.spentToday();
        if (!Number.isFinite(spent) || spent < this.options.thresholdUsd) return;
        const key = `spend:${day}`;
        if (asked.has(`${this.options.ownerInvite}\n${key}`)) return;
        await this.ask({
          inviteId: this.options.ownerInvite,
          key,
          firstAt: now(),
          failures: 0,
          retryAt: 0,
        });
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

  /** One attempt at an alert: written down as owed first, ended when every device was told. */
  private async ask(alert: OwedAlert): Promise<void> {
    const now = (): number => (this.options.now ?? Date.now)();
    let complete = false;
    let threw = false;
    try {
      // Written down before the first ask of the day, so a stop in the middle of it loses nothing.
      if (alert.failures === 0 && this.reported !== alert.key) this.owed.save(alert);
      complete = await this.options.alert(alert.inviteId, alert.key);
    } catch (error) {
      threw = true;
      this.options.onWarning?.('The spend alert failed; trying again', error);
    }
    if (!complete) {
      // Still owed: try again, with growing waits.
      const failures = alert.failures + 1;
      const wait = Math.min((this.options.pollMs ?? 60_000) * 2 ** failures, MAX_BACKOFF_MS);
      try {
        this.owed.save({ ...alert, failures, retryAt: now() + wait });
      } catch (error) {
        this.options.onWarning?.('The spend alert failed; trying again', error);
      }
      if (!threw) {
        this.options.onWarning?.('The spend alert did not reach every device; trying again later');
      }
      return;
    }
    this.settle(alert);
    if (this.reported !== alert.key) {
      this.reported = alert.key;
      this.options.onAlert?.(alert.key.slice('spend:'.length));
    }
  }

  /** An alert a day old is dropped, and the loss is told: a warning, and `onDropped` (the inbox). */
  private async giveUp(alert: OwedAlert): Promise<void> {
    const day = alert.key.slice('spend:'.length);
    try {
      await this.options.onDropped?.(alert);
    } catch (error) {
      // Still owed: the loss has not been told yet, so the next tick tries to tell it again.
      this.options.onWarning?.(
        `The spend alert for ${day} was dropped but could not be raised`,
        error,
      );
      return;
    }
    this.settle(alert);
    this.options.onWarning?.(`The spend alert for ${day} was not delivered in 24 hours; giving up`);
  }

  private settle(alert: OwedAlert): void {
    try {
      this.owed.clear(alert.inviteId, alert.key);
    } catch (error) {
      this.options.onWarning?.('The spend alert failed; trying again', error);
    }
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
