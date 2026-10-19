import type { RunHandle, Runner, RunnerEvent, RunSpec } from '@maka-cloud/orchestrator';
import {
  CHANGES_SCRIPT,
  CLONE_SCRIPT,
  PATCH_CHUNK_SCRIPT,
  type CodingSandbox,
  type ExecOptions,
  type ExecResult,
  type SandboxWorkspace,
} from '@maka-cloud/playbooks/coding';

export interface Deferred<T = void> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export const BASE_SHA = 'a'.repeat(40);

export interface FakeChangedFile {
  path: string;
  mode?: string;
  status?: string;
  size?: number;
}

/** The text CHANGES_SCRIPT prints for a change. */
export function changesOutput(files: FakeChangedFile[], patchBytes: number): string {
  const raw = Buffer.from(
    files
      .map(
        (file, index) =>
          `:100644 ${file.mode ?? '100644'} ${'0'.repeat(40)} ${String(index + 1).padStart(40, '0')} ${file.status ?? 'M'}\0${file.path}\0`,
      )
      .join(''),
  ).toString('base64');
  const sizes = files.map(
    (file, index) => `SIZE ${String(index + 1).padStart(40, '0')} ${file.size ?? 10}`,
  );
  return [`RAW ${raw}`, `PATCH ${patchBytes}`, ...sizes].join('\n');
}

export interface FakeWorkspaceOptions {
  log: string[];
  patch?: string;
  files?: FakeChangedFile[];
  changesStdout?: string;
  cloneStdout?: string;
  /** Held open until released; lets a test pin the order of events. */
  stopGate?: Deferred;
  stopFails?: boolean;
}

export class FakeSandbox implements CodingSandbox {
  opened = 0;
  released = 0;
  stopAlls = 0;
  stopTasks = 0;
  openFails: Error | undefined;
  readonly workspaces: FakeWorkspace[] = [];
  /** Every script and env value that was sent to the sandbox. */
  readonly sent: string[] = [];

  constructor(readonly options: FakeWorkspaceOptions) {}

  async open(): Promise<SandboxWorkspace> {
    if (this.openFails) throw this.openFails;
    this.opened += 1;
    this.options.log.push('open');
    const ws = new FakeWorkspace(this);
    this.workspaces.push(ws);
    return ws;
  }

  async stopTask(): Promise<void> {
    this.stopTasks += 1;
    this.options.log.push('stopTask');
    if (this.options.stopFails) throw new Error('survivors');
  }
}

class FakeWorkspace implements SandboxWorkspace {
  readonly dir = '/data/work/tsk_fake';
  readonly controlDir = '/dev/shm/maka-logs/tsk_fake/checks';
  private done = false;

  constructor(private readonly sandbox: FakeSandbox) {}

  async exec(script: string, options: ExecOptions = {}): Promise<ExecResult> {
    const { sandbox } = this;
    const o = sandbox.options;
    sandbox.sent.push(script, ...Object.values(options.envs ?? {}), options.stdin ?? '');
    if (script === CLONE_SCRIPT) {
      o.log.push('clone');
      return { stdout: o.cloneStdout ?? `BASE ${BASE_SHA}\n`, stderr: '', exitCode: 0 };
    }
    if (script === CHANGES_SCRIPT) {
      o.log.push('collect');
      const patch = o.patch ?? 'diff --git a/x b/x\n+1\n';
      return {
        stdout:
          o.changesStdout ??
          changesOutput(o.files ?? [{ path: 'src/x.py' }], Buffer.byteLength(patch)),
        stderr: '',
        exitCode: 0,
      };
    }
    if (script === PATCH_CHUNK_SCRIPT) {
      const patch = Buffer.from(o.patch ?? 'diff --git a/x b/x\n+1\n');
      const offset = Number(options.envs?.MAKA_OFF);
      const length = Number(options.envs?.MAKA_LEN);
      return {
        stdout: patch.subarray(offset, offset + length).toString('base64'),
        stderr: '',
        exitCode: 0,
      };
    }
    throw new Error('unexpected script');
  }

  async stopAll(): Promise<void> {
    const o = this.sandbox.options;
    this.sandbox.stopAlls += 1;
    o.log.push('stopAll:start');
    await o.stopGate?.promise;
    if (o.stopFails) {
      o.log.push('stopAll:failed');
      throw new Error('survivors');
    }
    o.log.push('stopAll:done');
  }

  async stopRuns(): Promise<void> {
    throw new Error('unexpected stopRuns');
  }

  async agentOnSameMachine(): Promise<boolean> {
    return true;
  }

  async release(): Promise<void> {
    if (this.done) return;
    this.done = true;
    this.sandbox.released += 1;
    this.sandbox.options.log.push('release');
  }
}

export type Script = (queue: ScriptedRun) => void | Promise<void>;

/** A run the test drives by hand. */
export class ScriptedRun implements RunHandle {
  readonly events: AsyncIterable<RunnerEvent>;
  cancels = 0;
  private readonly queue: RunnerEvent[] = [];
  private wake: (() => void) | undefined;
  private closed = false;

  constructor(readonly spec: RunSpec) {
    const self = this;
    this.events = {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const item = self.queue.shift();
          if (item) {
            yield item;
            continue;
          }
          if (self.closed) return;
          await new Promise<void>((resolve) => {
            self.wake = resolve;
          });
          self.wake = undefined;
        }
      },
    };
  }

  push(event: RunnerEvent): void {
    this.queue.push(event);
    this.wake?.();
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  async cancel(): Promise<void> {
    this.cancels += 1;
    this.close();
  }
}

export class FakeRunner implements Runner {
  readonly runs: ScriptedRun[] = [];
  startFails: Error | undefined;
  /** Called with each run as it starts, to script its events. */
  onStart: ((run: ScriptedRun) => void | Promise<void>) | undefined;
  readonly started = deferred<ScriptedRun>();

  constructor(
    readonly name: string,
    private readonly log: string[] = [],
  ) {}

  async start(spec: RunSpec): Promise<RunHandle> {
    this.log.push('start');
    if (this.startFails) throw this.startFails;
    const run = new ScriptedRun(spec);
    this.runs.push(run);
    this.started.resolve(run);
    await this.onStart?.(run);
    return run;
  }
}

export function finishWith(costUsd: number | null): (run: ScriptedRun) => void {
  return (run) => {
    if (costUsd !== null) run.push({ type: 'usage', costUsd });
    run.push({ type: 'finished' });
  };
}
