import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { RunHandle, Runner, RunnerEvent, RunSpec } from './runner.js';
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
  private readonly queue: RunnerEvent[] = [];
  private crashed: Error | undefined;
  private wake: (() => void) | undefined;
  private ended = false;

  constructor(
    readonly spec: RunSpec,
    pausable = true,
  ) {
    this.events = this.iterate();
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
  /** Gives the runner a `stopOrphaned` that calls this. Without it the runner has none. */
  stopOrphaned?: (taskId: string, options: { signal?: AbortSignal }) => Promise<void>;
}

/** A runner for tests: records every run and does nothing until a test drives it. */
export class FakeRunner implements Runner {
  readonly name: string;
  readonly runs: FakeRun[] = [];
  /** Task ids `stopOrphaned` was called for. Only filled when the runner has the method. */
  readonly orphanStops: string[] = [];
  stopOrphaned?: (taskId: string, options?: { signal?: AbortSignal }) => Promise<void>;

  constructor(private readonly options: FakeRunnerOptions = {}) {
    this.name = options.name ?? 'fake';
    const stop = options.stopOrphaned;
    if (stop) {
      this.stopOrphaned = async (taskId, callOptions = {}) => {
        this.orphanStops.push(taskId);
        await stop(taskId, callOptions);
      };
    }
  }

  async start(spec: RunSpec): Promise<RunHandle> {
    if (this.options.startError) throw this.options.startError;
    const run = new FakeRun(spec, this.options.pausable ?? true);
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
