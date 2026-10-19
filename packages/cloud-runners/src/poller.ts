import { POLL_SCRIPT } from './scripts.js';
import { errorMessage } from './shell.js';
import type { RemoteMachine } from './machine.js';

export type RunState = 'starting' | 'running' | 'dead' | 'none' | { exit: number };

export interface PollUpdate {
  state: RunState;
  /** Size of the output file when it was read. */
  size: number;
  /** New output bytes, starting at the watch's offset. */
  data: Buffer;
}

export interface Watch {
  /** Next update, with the bytes after the previous one. Rejects once the machine has been unreachable for too long. */
  next(): Promise<PollUpdate>;
  stop(): void;
}

interface WatchInternal {
  dir: string;
  run: string;
  offset: number;
  waiter: { resolve(update: PollUpdate): void; reject(error: Error): void } | undefined;
  pending: PollUpdate | Error | undefined;
  stopped: boolean;
}

export interface PollerOptions {
  intervalMs: number;
  /** Consecutive failed polls before every watch on the machine fails. */
  maxFailures?: number;
  sleep?: (ms: number) => Promise<void>;
}

const RAW_BUDGET = 450_000;
const RAW_CAP = 262_144;

/**
 * One exec per machine per tick for every run watched on it, instead of one per task. Each tick
 * asks for the bytes after every watch's offset and routes the answer back by task and run.
 */
export class MachinePoller {
  private readonly machines = new Map<
    string,
    { machine: RemoteMachine; watches: Set<WatchInternal>; running: boolean }
  >();
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxFailures: number;
  /** Watches still registered, across machines. Zero when every run has let go. */
  watchCount(): number {
    let count = 0;
    for (const entry of this.machines.values()) count += entry.watches.size;
    return count;
  }

  /** Number of poll execs sent, for tests that check batching. */
  pollCount = 0;

  constructor(private readonly options: PollerOptions) {
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxFailures = options.maxFailures ?? 5;
  }

  watch(machine: RemoteMachine, target: { dir: string; run: string; offset?: number }): Watch {
    let entry = this.machines.get(machine.machineId);
    if (!entry) {
      entry = { machine, watches: new Set(), running: false };
      this.machines.set(machine.machineId, entry);
    }
    const watch: WatchInternal = {
      dir: target.dir,
      run: target.run,
      offset: target.offset ?? 0,
      waiter: undefined,
      pending: undefined,
      stopped: false,
    };
    entry.watches.add(watch);
    if (!entry.running) {
      entry.running = true;
      void this.loop(machine.machineId);
    }
    const poller = this;
    return {
      next() {
        if (watch.pending) {
          const pending = watch.pending;
          watch.pending = undefined;
          return pending instanceof Error ? Promise.reject(pending) : Promise.resolve(pending);
        }
        return new Promise<PollUpdate>((resolve, reject) => {
          watch.waiter = { resolve, reject };
        });
      },
      stop() {
        watch.stopped = true;
        watch.waiter?.reject(new Error('watch stopped'));
        watch.waiter = undefined;
        poller.machines.get(machine.machineId)?.watches.delete(watch);
      },
    };
  }

  private async loop(machineId: string): Promise<void> {
    const entry = this.machines.get(machineId);
    if (!entry) return;
    let failures = 0;
    try {
      while (entry.watches.size > 0) {
        const active = [...entry.watches].filter((w) => !w.stopped && !w.pending);
        if (active.length > 0) {
          try {
            await this.tick(entry.machine, active);
            failures = 0;
          } catch (error) {
            failures++;
            if (failures >= this.maxFailures) {
              const failure = new Error(`sandbox unreachable: ${errorMessage(error)}`);
              for (const w of active) this.deliver(w, failure);
              failures = 0;
            }
          }
        }
        await this.sleep(this.options.intervalMs);
      }
    } finally {
      entry.running = false;
      if (entry.watches.size === 0) this.machines.delete(machineId);
    }
  }

  private async tick(machine: RemoteMachine, active: WatchInternal[]): Promise<void> {
    const cap = Math.max(4096, Math.min(RAW_CAP, Math.floor(RAW_BUDGET / active.length)));
    // `read` skips a last line that has no newline.
    const stdin = `${active.map((w) => `${w.dir} ${w.run} ${w.offset} ${cap}`).join('\n')}\n`;
    this.pollCount++;
    const out = await machine.execOk(POLL_SCRIPT, {
      envs: { MAKA_ROOT: machine.root, MAKA_LOG_ROOT: machine.logRoot },
      stdin,
      timeoutSeconds: 30,
    });
    const byKey = new Map(active.map((w) => [`${w.dir} ${w.run}`, w]));
    for (const line of out.split('\n')) {
      if (!line.startsWith('T ')) continue;
      const [, dir = '', run = '', state = '', size = '0', data = ''] = line.split(' ');
      const watch = byKey.get(`${dir} ${run}`);
      if (!watch || watch.stopped) continue;
      const bytes = Buffer.from(data, 'base64');
      // The read position moves when the bytes are handed over, so the next tick never repeats them.
      watch.offset += bytes.length;
      this.deliver(watch, { state: parseState(state), size: Number(size), data: bytes });
    }
  }

  private deliver(watch: WatchInternal, update: PollUpdate | Error): void {
    const waiter = watch.waiter;
    if (waiter) {
      watch.waiter = undefined;
      if (update instanceof Error) waiter.reject(update);
      else waiter.resolve(update);
    } else {
      watch.pending = update;
    }
  }
}

function parseState(state: string): RunState {
  if (state.startsWith('exit:')) return { exit: Number.parseInt(state.slice(5), 10) || 0 };
  if (state === 'running' || state === 'dead' || state === 'starting') return state;
  return 'none';
}
