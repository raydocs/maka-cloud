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

/** One scripted run. Tests drive it with `progress`, `complete`, `fail` and `end`. */
export class FakeRun implements RunHandle {
  readonly events: AsyncIterable<RunnerEvent>;
  cancelCalls = 0;
  private readonly queue: RunnerEvent[] = [];
  private crashed: Error | undefined;
  private wake: (() => void) | undefined;
  private ended = false;

  constructor(readonly spec: RunSpec) {
    this.events = this.iterate();
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
}

/** A runner for tests: records every run and does nothing until a test drives it. */
export class FakeRunner implements Runner {
  readonly name: string;
  readonly runs: FakeRun[] = [];

  constructor(private readonly options: FakeRunnerOptions = {}) {
    this.name = options.name ?? 'fake';
  }

  async start(spec: RunSpec): Promise<RunHandle> {
    if (this.options.startError) throw this.options.startError;
    const run = new FakeRun(spec);
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
