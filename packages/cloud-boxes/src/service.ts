import { applyEgressGuard, type InstaboxClient } from '@maka-cloud/instabox';
import { BoxPool } from './pool.js';
import type { BoxPoolOptions } from './types.js';

const DEFAULT_SWEEP_EVERY_MS = 60_000;
const DEFAULT_CLEANUP_EVERY_MS = 5 * 60_000;

export interface BoxServiceOptions {
  client: InstaboxClient;
  /** What a new box starts from. */
  templateId: string;
  /** At most this many boxes per invite. Default 3. */
  maxPerInvite?: number;
  /**
   * Whether the orchestrator still considers a task live. Before the orchestrator exists the answer
   * must be `true`: a box labelled with a task is then kept claimed, never freed by a guess.
   */
  isTaskLive: (taskId: string) => boolean;
  conversationOf?: (taskId: string) => string | undefined;
  /**
   * Runs on every box the pool makes, restores or wakes, and on every builder box, before anything
   * else runs in it. Default: the instabox firewall rules from `applyEgressGuard`, the same function
   * the fleet applies; a box where it fails is deleted (made) or marked lost (woken) and the task fails.
   */
  guard?: (machineId: string) => Promise<void>;
  /** How often idle boxes are looked at. Default one minute. */
  sweepEveryMs?: number;
  /** How often lost boxes are retried and long-idle ones removed. Default five minutes. */
  cleanupEveryMs?: number;
  /** Passed on to the pool (idle times, wake limits, cleanup limits, `recentWrite`, `setupOf`, ...). */
  pool?: Partial<
    Omit<BoxPoolOptions, 'api' | 'source' | 'isTaskLive' | 'beforeUse' | 'conversationOf'>
  >;
  onWarning?: (message: string, detail?: unknown) => void;
  /** Test seam. */
  timers?: NonNullable<BoxPoolOptions['timers']>;
}

export interface BoxService {
  pool: BoxPool;
  /** Stops the loops, waits for a sweep that is running, and refuses new tasks. Boxes are left as they are. */
  close(): Promise<void>;
}

/**
 * The pool of an instabox account with its two loops: `sweepIdle` puts idle boxes to sleep, `cleanup`
 * retries lost boxes, frees claims of tasks that are no longer live and removes long-idle boxes. A loop that fails reports and goes on; neither
 * loop ever overlaps itself (the next run is set after the last one ends).
 */
export function startBoxService(options: BoxServiceOptions): BoxService {
  const timers: NonNullable<BoxPoolOptions['timers']> = options.timers ?? {
    // The loops never keep the process alive on their own; the stack's close stops them.
    setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms).unref(),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as NodeJS.Timeout),
  };
  const warn = options.onWarning ?? (() => undefined);
  const guard = options.guard ?? ((machineId) => applyEgressGuard(options.client, machineId));
  const pool = new BoxPool({
    ...options.pool,
    api: options.client,
    source: () => ({ templateId: options.templateId }),
    isTaskLive: options.isTaskLive,
    beforeUse: (machineId) => guard(machineId),
    onWarning: warn,
    timers,
    ...(options.maxPerInvite === undefined ? {} : { maxPerInvite: options.maxPerInvite }),
    ...(options.conversationOf === undefined ? {} : { conversationOf: options.conversationOf }),
  });

  let stopped = false;
  const loops: { handle: unknown; running: Promise<unknown> | undefined }[] = [];
  const loop = (name: string, everyMs: number, run: () => Promise<unknown>): void => {
    const state: { handle: unknown; running: Promise<unknown> | undefined } = {
      handle: undefined,
      running: undefined,
    };
    const schedule = (): void => {
      if (stopped) return;
      state.handle = timers.setTimeout(() => {
        state.handle = undefined;
        state.running = run()
          .catch((error) => warn(`the box ${name} failed`, error))
          .finally(() => {
            state.running = undefined;
            schedule();
          });
      }, everyMs);
    };
    loops.push(state);
    schedule();
  };
  loop('sweep', options.sweepEveryMs ?? DEFAULT_SWEEP_EVERY_MS, () => pool.sweepIdle());
  loop('cleanup', options.cleanupEveryMs ?? DEFAULT_CLEANUP_EVERY_MS, async () => {
    // A box claimed by a task that ended while the server was down is freed first.
    await pool.reconcile();
    return await pool.cleanup();
  });

  return {
    pool,
    close: async () => {
      stopped = true;
      for (const state of loops) {
        if (state.handle !== undefined) timers.clearTimeout(state.handle);
        state.handle = undefined;
      }
      pool.dispose();
      await Promise.all(loops.map((state) => state.running));
    },
  };
}
