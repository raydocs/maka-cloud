import type { DutyEngine, RunRequest } from './engine.js';

/** The launcher cannot start this run and never will (the owner is gone, the project is not there). */
export class LaunchRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LaunchRefused';
  }
}

export interface RunLauncher {
  /**
   * Starts the run for a request and returns its conversation. Called at least once per request,
   * so it must be idempotent on `request.requestId`: a second call for a request that already
   * started returns the same conversation and starts nothing. Throw `LaunchRefused` for a
   * request that can never start; any other error is retried.
   */
  start(request: RunRequest, signal: AbortSignal): Promise<{ conversationId: string }>;
}

export interface DispatcherOptions {
  engine: DutyEngine;
  launcher: RunLauncher;
  retryBaseMs?: number;
  retryMaxMs?: number;
  now?: () => number;
  onWarning?: (message: string, detail?: unknown) => void;
  /** Replaces setTimeout, so a test can see the timer is released. */
  setTimer?: (fn: () => void, ms: number) => () => void;
}

export interface DispatcherStats {
  /** A pass is running. */
  running: boolean;
  /** A retry timer is set. */
  timers: number;
}

/**
 * Starts the runs of claimed requests, one at a time, oldest first. It wakes when the engine
 * claims work, and at the time the next retry is due. Closing aborts the launch in progress and
 * leaves that request to start again next time: it stays reserved and unfinished, which is the
 * right state for work that was interrupted.
 */
export class Dispatcher {
  private readonly abort = new AbortController();
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly setTimer: NonNullable<DispatcherOptions['setTimer']>;
  private unsubscribe: (() => void) | undefined;
  private cancelTimer: (() => void) | undefined;
  private pass: Promise<void> | undefined;
  private again = false;
  private closed = false;

  constructor(private readonly options: DispatcherOptions) {
    this.retryBaseMs = options.retryBaseMs ?? 5_000;
    this.retryMaxMs = options.retryMaxMs ?? 300_000;
    this.setTimer =
      options.setTimer ??
      ((fn, ms) => {
        const timer = setTimeout(fn, ms);
        timer.unref();
        return () => clearTimeout(timer);
      });
    this.unsubscribe = options.engine.onWork(() => this.kick());
  }

  stats(): DispatcherStats {
    return { running: this.pass !== undefined, timers: this.cancelTimer ? 1 : 0 };
  }

  /** Starts a pass unless one is running; a pass that is running looks again before it ends. */
  kick(): void {
    if (this.closed) return;
    if (this.pass) {
      this.again = true;
      return;
    }
    this.pass = this.run().finally(() => {
      this.pass = undefined;
    });
  }

  /** Resolves when the running pass, if any, has ended. */
  async settled(): Promise<void> {
    while (this.pass) await this.pass;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.abort.abort();
    await this.settled();
  }

  private async run(): Promise<void> {
    const { engine } = this.options;
    try {
      do {
        this.again = false;
        for (let ids = engine.due(); ids.length > 0 && !this.closed; ids = engine.due()) {
          for (const id of ids) {
            if (this.closed) break;
            await this.launch(id);
          }
        }
      } while (this.again && !this.closed);
    } catch (error) {
      this.options.onWarning?.('The duties dispatcher failed', error);
    }
    this.arm();
  }

  private async launch(requestId: string): Promise<void> {
    const { engine, launcher } = this.options;
    const request = engine.beginLaunch(requestId);
    if (!request) return;
    try {
      const { conversationId } = await launcher.start(request, this.abort.signal);
      engine.launched(requestId, conversationId);
    } catch (error) {
      // Closing is not a failure: the request stays as it is and starts again next time.
      if (this.closed) return;
      const permanent = error instanceof LaunchRefused;
      if (!permanent) this.options.onWarning?.('Starting a duty run failed', error);
      const delay = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** (request.attempts - 1));
      engine.launchFailed(requestId, { permanent, retryAfterMs: delay });
    }
  }

  /** Wakes at the time the next retry is due. */
  private arm(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    if (this.closed) return;
    const at = this.options.engine.nextDueAt();
    if (at === undefined) return;
    const now = (this.options.now ?? Date.now)();
    if (at <= now) {
      // Work arrived after the last look; the next kick takes it.
      queueMicrotask(() => this.kick());
      return;
    }
    this.cancelTimer = this.setTimer(() => {
      this.cancelTimer = undefined;
      this.kick();
    }, at - now);
  }
}
