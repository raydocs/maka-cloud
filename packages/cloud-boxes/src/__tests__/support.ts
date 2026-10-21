import { BoxPool } from '../pool.js';
import type { BoxPoolOptions } from '../types.js';
import { FakeFleet } from './fake-fleet.js';

/** Timers a test fires by hand, so a wait runs out when the test says and never by the clock. */
export class ManualTimers {
  private next = 1;
  readonly pending = new Map<number, { callback: () => void; ms: number }>();
  /** Every limit a timer was ever set with, in order. */
  readonly history: number[] = [];
  setTimeout = (callback: () => void, ms: number): number => {
    const handle = this.next++;
    this.history.push(ms);
    this.pending.set(handle, { callback, ms });
    return handle;
  };
  clearTimeout = (handle: unknown): void => {
    this.pending.delete(handle as number);
  };
  /** The limits of the timers that are set, in the order they were set. */
  get limits(): number[] {
    return [...this.pending.values()].map((timer) => timer.ms);
  }
  fireAll(): void {
    const timers = [...this.pending.values()];
    this.pending.clear();
    for (const timer of timers) timer.callback();
  }
  /** Fires the timers set with exactly this limit. */
  fire(ms: number): void {
    for (const [handle, timer] of [...this.pending]) {
      if (timer.ms !== ms) continue;
      this.pending.delete(handle);
      timer.callback();
    }
  }
}

/** Lets every promise that can run, run: the fakes do no I/O, so nothing is left after this. */
export const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export const labelsOf = (fleet: FakeFleet, machineId: string) =>
  fleet.machines.get(machineId)?.metadata;

export function setup(overrides: Partial<BoxPoolOptions> = {}) {
  const fleet = new FakeFleet();
  const live = new Set<string>();
  const timers = new ManualTimers();
  const warnings: string[] = [];
  const guarded: { machineId: string; reason: string }[] = [];
  const clock = { now: 1_000_000 };
  const pool = new BoxPool({
    api: fleet,
    source: () => ({ templateId: 't_node' }),
    isTaskLive: (taskId) => live.has(taskId),
    onWarning: (message) => warnings.push(message),
    beforeUse: async (machineId, reason) => {
      guarded.push({ machineId, reason });
    },
    timers,
    now: () => clock.now,
    ...overrides,
  });
  return { fleet, live, timers, warnings, guarded, clock, pool };
}
