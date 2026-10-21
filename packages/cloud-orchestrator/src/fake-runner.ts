import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Recovery, RunHandle, Runner, RunnerEvent, RunSpec } from './runner.js';
import type { ResultManifest } from './types.js';

export const DEFAULT_FAKE_MANIFEST: ResultManifest = {
  summary: 'fake run complete',
  done: ['everything the brief asked'],
  notDone: [],
  confidence: 'high',
  knownIssues: [],
};

/** Holds one pause or resume call open until the test lets it finish or fail. */
export interface FakeHold {
  release(): void;
  fail(error: Error): void;
}

function newHold(): { hold: FakeHold; settled: Promise<void> } {
  let release!: () => void;
  let fail!: (error: Error) => void;
  const settled = new Promise<void>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  return { hold: { release, fail }, settled };
}

/** One scripted run. Tests drive it with `progress`, `complete`, `fail` and `end`. */
export class FakeRun implements RunHandle {
  readonly events: AsyncIterable<RunnerEvent>;
  cancelCalls = 0;
  pauseCalls = 0;
  resumeCalls = 0;
  /** True between a pause that finished and the resume that undid it. */
  paused = false;
  /** Absent on a run whose runner is not pausable. */
  readonly pause?: () => Promise<void>;
  readonly resume?: () => Promise<void>;
  private pauseWait: Promise<void> | undefined;
  private resumeWait: Promise<void> | undefined;
  /** Absent on a run whose runner is not steerable. */
  readonly steer?: (message: { steerId: string; text: string }) => void;
  readonly unsteer?: (steerId: string) => boolean;
  /** The messages handed to the run and not yet read by the agent, in order. */
  readonly waiting: Array<{ steerId: string; text: string }> = [];
  /** Every message handed to the run, offers repeated included. */
  readonly offers: Array<{ steerId: string; text: string }> = [];
  private readonly queue: RunnerEvent[] = [];
  private crashed: Error | undefined;
  private wake: (() => void) | undefined;
  private ended = false;

  constructor(
    readonly spec: RunSpec,
    pausable = true,
    steerable = false,
  ) {
    this.events = this.iterate();
    if (steerable) {
      this.steer = (message) => {
        this.offers.push(message);
        if (!this.waiting.some((waiting) => waiting.steerId === message.steerId)) {
          this.waiting.push(message);
        }
      };
      this.unsteer = (steerId) => {
        const at = this.waiting.findIndex((waiting) => waiting.steerId === steerId);
        if (at < 0) return false;
        this.waiting.splice(at, 1);
        return true;
      };
    }
    if (pausable) {
      this.pause = async () => {
        this.pauseCalls += 1;
        const wait = this.pauseWait;
        this.pauseWait = undefined;
        await wait;
        this.paused = true;
      };
      this.resume = async () => {
        this.resumeCalls += 1;
        const wait = this.resumeWait;
        this.resumeWait = undefined;
        await wait;
        this.paused = false;
      };
    }
  }

  /** The next `pause` call stays open until the returned hold is released or failed. */
  holdPause(): FakeHold {
    const { hold, settled } = newHold();
    this.pauseWait = settled;
    return hold;
  }

  /** The same for the next `resume` call. */
  holdResume(): FakeHold {
    const { hold, settled } = newHold();
    this.resumeWait = settled;
    return hold;
  }

  get cancelled(): boolean {
    return this.cancelCalls > 0;
  }

  progress(note: string): void {
    this.push({ type: 'progress', note });
  }

  /** The agent reads every waiting message, as at its next tool call; the run reports it. */
  readWaiting(): Array<{ steerId: string; text: string }> {
    const read = this.waiting.splice(0);
    for (const message of read) this.push({ type: 'steered', steerId: message.steerId });
    return read;
  }

  /** Report what the run has spent so far, in dollars. */
  usage(costUsd: number): void {
    this.push({ type: 'usage', costUsd });
  }

  /** Write the result manifest, then report `finished`. Pass `raw` to write arbitrary bytes instead. */
  async complete(manifest: ResultManifest = DEFAULT_FAKE_MANIFEST, raw?: string): Promise<void> {
    await mkdir(dirname(this.spec.resultPath), { recursive: true });
    await writeFile(this.spec.resultPath, raw ?? JSON.stringify(manifest));
    this.push({ type: 'finished' });
    this.end();
  }

  /** Report `finished` without writing a manifest, as a misbehaving runner would. */
  finishWithoutManifest(): void {
    this.push({ type: 'finished' });
    this.end();
  }

  fail(reason: string): void {
    this.push({ type: 'failed', reason });
    this.end();
  }

  /** Make the event stream throw, as a runner whose connection broke would. */
  crash(error: Error): void {
    this.crashed = error;
    this.wake?.();
  }

  /** Close the event stream without a terminal event. */
  end(): void {
    this.ended = true;
    this.wake?.();
  }

  async cancel(): Promise<void> {
    this.cancelCalls += 1;
    this.end();
  }

  private push(event: RunnerEvent): void {
    this.queue.push(event);
    this.wake?.();
  }

  private async *iterate(): AsyncGenerator<RunnerEvent> {
    for (;;) {
      if (this.crashed) throw this.crashed;
      const next = this.queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = undefined;
    }
  }
}

export interface FakeRunnerOptions {
  name?: string;
  /** Called with each new run, before `start` resolves. Use it to script behavior. */
  onStart?: (run: FakeRun) => void | Promise<void>;
  /** Make `start` reject. */
  startError?: Error;
  /** Whether runs offer `pause` and `resume`. Default true. */
  pausable?: boolean;
  /** Whether the runner takes messages for the agent (`steer`). Default false. */
  steerable?: boolean;
  /** Gives the runner a `stopOrphaned` that calls this. Without it the runner has none. */
  stopOrphaned?: (
    taskId: string,
    options: { signal?: AbortSignal; epoch?: number },
  ) => Promise<void>;
  /**
   * Gives the runner a `recover`, so a restart resumes its tasks instead of ending them: it
   * returns a new run, after `onStart`. `error` makes it reject.
   */
  recover?: boolean | { error?: Error };
}

/** A runner for tests: records every run and does nothing until a test drives it. */
export class FakeRunner implements Runner {
  readonly name: string;
  readonly steerable: boolean;
  readonly runs: FakeRun[] = [];
  /** Task ids `stopOrphaned` was called for. Only filled when the runner has the method. */
  readonly orphanStops: string[] = [];
  stopOrphaned?: (
    taskId: string,
    options?: { signal?: AbortSignal; epoch?: number },
  ) => Promise<void>;
  /** Present only when the runner was built with the `recover` option. */
  recover?: (spec: RunSpec & { recovery: Recovery }) => Promise<RunHandle>;
  /** The specs `recover` was called with. */
  readonly recoveries: Array<RunSpec & { recovery: Recovery }> = [];

  constructor(private readonly options: FakeRunnerOptions = {}) {
    this.name = options.name ?? 'fake';
    this.steerable = options.steerable ?? false;
    const stop = options.stopOrphaned;
    if (stop) {
      this.stopOrphaned = async (taskId, callOptions = {}) => {
        this.orphanStops.push(taskId);
        await stop(taskId, callOptions);
      };
    }
    const recover = options.recover;
    if (recover) {
      this.recover = async (spec) => {
        this.recoveries.push(spec);
        if (typeof recover === 'object' && recover.error) throw recover.error;
        const run = new FakeRun(spec, this.options.pausable ?? true, this.steerable);
        this.runs.push(run);
        await this.options.onStart?.(run);
        return run;
      };
    }
  }

  async start(spec: RunSpec): Promise<RunHandle> {
    if (this.options.startError) throw this.options.startError;
    const run = new FakeRun(spec, this.options.pausable ?? true, this.steerable);
    this.runs.push(run);
    await this.options.onStart?.(run);
    return run;
  }

  runFor(taskId: string): FakeRun {
    const run = this.runs.find((candidate) => candidate.spec.taskId === taskId);
    if (!run) throw new Error(`No fake run for ${taskId}`);
    return run;
  }
}
