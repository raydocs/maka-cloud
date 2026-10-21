import type { StepLog } from './steps.js';
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
  /**
   * The top-level task of the tree, set with `budgetUsd`: runs of one tree share its cap, so a
   * model gateway can hold them to it together.
   */
  budgetRootId?: TaskId;
  /**
   * What this run alone may spend, when that is less than `budgetUsd` (the orchestrator's turn
   * limit). A run is one start or one resume after a restart. The smaller of the two binds.
   */
  turnBudgetUsd?: number;
  /** Orchestrator MCP endpoint scoped to this task's own session, so the executor can delegate too. */
  mcp?: { url: string; token: string };
  /**
   * The step log of this attempt: a runner that wants a step to survive a crash records its intent
   * here before it runs the step and its outcome after. Every write carries the attempt's epoch.
   */
  steps?: StepLog;
  /**
   * The model this run uses, instead of the runner's default. A runner that cannot validate it
   * refuses the run. Set by whoever applies a mode's roles (the coding runner today).
   */
  model?: string;
  /** How hard the model thinks (`low`, `medium`, `high` or `xhigh`); absent: the CLI's default. */
  effort?: string;
  /** Set when the run continues a task an earlier attempt was driving; see `Runner.recover`. */
  recovery?: Recovery;
  /**
   * The attempt (epoch) that drives this run: the one its usage reports and its model access are
   * booked under, so spend that a restart recovers lands on the same figure as the live report.
   */
  epoch?: number;
}

/** Why and how a task is being driven again after its previous attempt ended without an outcome. */
export interface Recovery {
  /** The epoch of this attempt (the task's creation is 1). */
  epoch: number;
  /** Resumes in a row without a step finished or spend recorded, this one included. */
  resumes: number;
  /**
   * What to tell the agent before anything else: the steps that finished, the `never` steps that
   * were cut off and may or may not have taken effect, and the `safe` ones that will run again.
   */
  note: string;
}

export type RunnerEvent =
  | { type: 'progress'; note: string }
  /** Dollars this run has spent so far, as its CLI reports them. Cumulative: each replaces the last. */
  | { type: 'usage'; costUsd: number }
  /** The runner wrote `resultPath`. The orchestrator validates it. */
  | { type: 'finished' }
  | { type: 'failed'; reason: string }
  /** The run put a message from `RunHandle.steer` in front of the agent. */
  | { type: 'steered'; steerId: string };

export interface RunHandle {
  /** Ends when the run is over. An iterator that ends without `finished` or `failed` fails the task. */
  readonly events: AsyncIterable<RunnerEvent>;
  /** Stop the run. Must be safe to call after the run has ended, and while the run is paused. */
  cancel(): Promise<void>;
  /**
   * Hold the run without losing its work. Resolves once the run no longer makes progress.
   * Optional: a runner that cannot do it leaves both out, and a pause request is refused.
   * Must be idempotent; `resume` undoes it.
   */
  pause?(): Promise<void>;
  resume?(): Promise<void>;
  /**
   * Hands the run a message for the agent. It reaches the agent at the next point the runner can
   * safely add to its conversation, which may be a while off (after the tool call under way); the
   * run reports `steered` when it has. Offering the same `steerId` again changes nothing.
   * Optional, and only for a runner with `Runner.steerable`.
   */
  steer?(message: { steerId: string; text: string }): void;
  /**
   * Drops a message from `steer` that the agent has not been given. True when it was still
   * waiting; false when it was handed over (or is being) and cannot be taken back.
   */
  unsteer?(steerId: string): boolean;
}

export interface Runner {
  readonly name: string;
  /** Its runs take `RunHandle.steer`. A message for a task whose runner is not is refused. */
  readonly steerable?: boolean;
  start(spec: RunSpec): Promise<RunHandle>;
  /**
   * Called on restart for every task the log shows as still running. The runner that started it
   * is gone from memory, but its work may still run somewhere else (a remote sandbox), so stop
   * whatever is left for `taskId`, finding it by id alone. Must be idempotent and may be a no-op
   * for an unknown task. `signal` aborts when the orchestrator stops waiting. `epoch` is the
   * attempt asking: a runner that can tell runs of different attempts apart must leave alone a
   * run started by a later attempt, since a slow stop can arrive after another process took the
   * task over.
   */
  stopOrphaned?(taskId: TaskId, options?: { signal?: AbortSignal; epoch?: number }): Promise<void>;
  /**
   * Continues a task after a restart instead of starting it again: the same session where the
   * runner kept one, told `spec.recovery.note` first. A runner without it has its unfinished
   * tasks ended as orphaned at restart. Called after `stopOrphaned` confirmed nothing of the
   * earlier attempt is left running. Throwing fails the task with the reason.
   */
  recover?(spec: RunSpec & { recovery: Recovery }): Promise<RunHandle>;
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
