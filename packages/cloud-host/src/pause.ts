import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The operator's kill switch: a file under the data directory. `maka-cloud pause` writes it and
 * `maka-cloud resume` removes it, from another process than the server's, so the server reads it
 * each time it is asked.
 */
export class PauseSwitch {
  constructor(readonly path: string) {}

  /** Whether spending is paused. A file that cannot be examined counts as paused: it fails closed. */
  isPaused(): boolean {
    try {
      statSync(this.path);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ENOENT';
    }
  }

  /** When it was paused, if the file says. */
  pausedAt(): string | undefined {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
      const at = (parsed as { pausedAt?: unknown } | null)?.pausedAt;
      return typeof at === 'string' ? at : undefined;
    } catch {
      return undefined;
    }
  }

  /** Pauses. Returns false when it already was; the file then keeps its first time. */
  pause(now: () => number = Date.now): boolean {
    if (this.isPaused()) return false;
    mkdirSync(dirname(this.path), { recursive: true });
    // Written whole and then renamed, so a reader sees no file or a complete one.
    const staged = `${this.path}.${process.pid}.tmp`;
    writeFileSync(staged, `${JSON.stringify({ pausedAt: new Date(now()).toISOString() })}\n`, {
      mode: 0o600,
    });
    renameSync(staged, this.path);
    return true;
  }

  /** Resumes. Returns false when spending was not paused. */
  resume(): boolean {
    const was = this.isPaused();
    rmSync(this.path, { force: true });
    return was;
  }
}

export interface PauseWatcherOptions {
  switch: Pick<PauseSwitch, 'isPaused'>;
  /**
   * Stops what is running. Called on every tick while spending is paused, so a run admitted during
   * the pause is stopped too; it must be harmless when nothing is open.
   */
  onPause(): Promise<unknown>;
  pollMs?: number;
  /** Longest `close` waits for a tick in flight. */
  closeWaitMs?: number;
  onWarning?: (message: string, detail?: unknown) => void;
}

/**
 * Watches the switch and, while spending is paused, has the stack stop its runs. One tick runs at
 * a time. A tick that fails is reported and tried again at the next one. `close` ends the timer and
 * waits (for a bounded time) for the tick in flight, so nothing runs after the stack closes.
 */
export class PauseWatcher {
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private closed = false;

  constructor(private readonly options: PauseWatcherOptions) {}

  /** Ticks at once, then every `pollMs`. */
  start(): void {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.options.pollMs ?? 1_000);
    void this.tick();
  }

  /** One check. Resolves when it is done; a tick already running is joined, not repeated. */
  tick(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    const run = async (): Promise<void> => {
      try {
        if (this.options.switch.isPaused()) await this.options.onPause();
      } catch (error) {
        this.options.onWarning?.('Stopping runs for the pause switch failed; trying again', error);
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
        this.options.onWarning?.('A pause tick was still running when the stack closed');
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}
