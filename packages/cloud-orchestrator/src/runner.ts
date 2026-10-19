import type { TaskId } from './types.js';

/** Everything a runner is given to start one task. */
export interface RunSpec {
  taskId: TaskId;
  runner: string;
  /** Markdown brief the runner is told to follow. */
  briefPath: string;
  /** Where the runner must write its result manifest (JSON) before it reports `finished`. */
  resultPath: string;
  /**
   * Dollars this run may spend: what is left of its tree's cap when it starts. The runner stops
   * itself when it spends this much; the orchestrator also cancels the tree when the tree's
   * reported spend reaches the cap. Absent: the tree has no cap.
   */
  budgetUsd?: number;
  /** Orchestrator MCP endpoint scoped to this task's own session, so the executor can delegate too. */
  mcp?: { url: string; token: string };
}

export type RunnerEvent =
  | { type: 'progress'; note: string }
  /** Dollars this run has spent so far, as its CLI reports them. Cumulative: each replaces the last. */
  | { type: 'usage'; costUsd: number }
  /** The runner wrote `resultPath`. The orchestrator validates it. */
  | { type: 'finished' }
  | { type: 'failed'; reason: string };

export interface RunHandle {
  /** Ends when the run is over. An iterator that ends without `finished` or `failed` fails the task. */
  readonly events: AsyncIterable<RunnerEvent>;
  /** Stop the run. Must be safe to call after the run has ended. */
  cancel(): Promise<void>;
}

export interface Runner {
  readonly name: string;
  start(spec: RunSpec): Promise<RunHandle>;
  /**
   * Called on restart for every task the log shows as still running. The runner that started it
   * is gone from memory, but its work may still run somewhere else (a remote sandbox), so stop
   * whatever is left for `taskId`, finding it by id alone. Must be idempotent and may be a no-op
   * for an unknown task. `signal` aborts when the orchestrator stops waiting.
   */
  stopOrphaned?(taskId: TaskId, options?: { signal?: AbortSignal }): Promise<void>;
}

export class RunnerRegistry {
  private readonly runners = new Map<string, Runner>();

  constructor(runners: Iterable<Runner> = []) {
    for (const runner of runners) this.register(runner);
  }

  register(runner: Runner): void {
    if (this.runners.has(runner.name)) throw new Error(`Runner already registered: ${runner.name}`);
    this.runners.set(runner.name, runner);
  }

  get(name: string): Runner | undefined {
    return this.runners.get(name);
  }

  names(): string[] {
    return [...this.runners.keys()];
  }
}

export class RunnerNotImplementedError extends Error {
  constructor(runner: string) {
    super(`Runner "${runner}" is not implemented yet`);
    this.name = 'RunnerNotImplementedError';
  }
}

function stub(name: string): Runner {
  return {
    name,
    async start() {
      throw new RunnerNotImplementedError(name);
    },
  };
}

/** Typed placeholder for the Claude Agent SDK runner. Starting it fails the task with a clear reason. */
export const claudeAgentSdkRunner: Runner = stub('claude-agent-sdk');
/** Typed placeholder for the Codex runner. */
export const codexRunner: Runner = stub('codex');
