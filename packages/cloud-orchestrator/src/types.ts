import { z } from 'zod';

export type TaskId = string;
export type SessionId = string;

export const TASK_STATES = [
  'queued',
  'running',
  'paused',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
  'succeeded',
  'failed',
  'cancelled',
]);

export function isTerminal(state: TaskState): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * What a finished task hands back. This is the only thing a parent reads from a
 * child: never a chat transcript.
 */
export const ResultManifestSchema = z
  .object({
    summary: z.string().min(1),
    done: z.array(z.string()),
    notDone: z.array(z.string()),
    confidence: z.enum(['low', 'medium', 'high']),
    knownIssues: z.array(z.string()),
    artifacts: z.array(z.string()).optional(),
  })
  .strict();
export type ResultManifest = z.infer<typeof ResultManifestSchema>;

export type TaskMode = 'async' | 'wait';

export type TaskEvent =
  | {
      type: 'task_created';
      taskId: TaskId;
      sessionId: SessionId;
      /** The session that started this task's tree. Absent in older logs, where it is `sessionId`. */
      rootSessionId?: SessionId;
      parentTaskId?: TaskId;
      runner: string;
      title?: string;
      mode: TaskMode;
      /** Dollar cap of the tree this task starts. Only a task a root session delegated has one. */
      budgetUsd?: number;
      /** The caller's key for this delegation; the task id is derived from it. */
      idempotencyKey?: string;
    }
  | { type: 'task_started'; taskId: TaskId }
  /**
   * What the runner of `fromTaskId` has spent so far, in dollars, recorded on the top-level task
   * of its tree (`taskId`). Cumulative per run: within one attempt (`epoch`) each report replaces
   * that run's last one (the highest stands), and the attempts of a task add up, since a resumed
   * run starts counting from zero. An event without `epoch` (written before attempts were keyed)
   * counts as epoch 0.
   */
  | { type: 'task_cost'; taskId: TaskId; fromTaskId: TaskId; costUsd: number; epoch?: number }
  | { type: 'task_progress'; taskId: TaskId; note: string }
  | { type: 'task_succeeded'; taskId: TaskId; manifest: ResultManifest }
  | { type: 'task_failed'; taskId: TaskId; reason: string }
  | { type: 'task_cancel_requested'; taskId: TaskId; by: SessionId | 'system' }
  | { type: 'task_cancelled'; taskId: TaskId }
  /** Someone asked for the run to pause; the task stays `running` until `task_paused`. */
  | { type: 'task_pause_requested'; taskId: TaskId; by: SessionId }
  | { type: 'task_paused'; taskId: TaskId }
  /** The runner could not pause. The task keeps running. */
  | { type: 'task_pause_failed'; taskId: TaskId; reason: string }
  | { type: 'task_resume_requested'; taskId: TaskId; by: SessionId }
  | { type: 'task_resumed'; taskId: TaskId }
  /** The runner could not resume. The task stays paused. */
  | { type: 'task_resume_failed'; taskId: TaskId; reason: string }
  /**
   * The task's run may still be going somewhere (a remote sandbox) and nothing has
   * confirmed it stopped: a stop failed, or the task ended while its run was live.
   * Written before the task's terminal event whenever that is known by then. The
   * orchestrator retries the stop until `task_stopped`; an ended task is not a
   * stopped one until then.
   */
  | { type: 'task_stop_pending'; taskId: TaskId; cause: StopPendingCause }
  /** The runner confirmed nothing of the task is left running. */
  | { type: 'task_stopped'; taskId: TaskId }
  /**
   * A new attempt to drive the task. A task starts at epoch 1 (its creation is the first attempt);
   * `epoch` is the previous one plus one. The first writer wins, and from then on the store
   * refuses a write fenced with an older epoch.
   */
  | { type: 'task_attempt'; taskId: TaskId; epoch: number; cause: AttemptCause }
  /** Written, and durable, before a step with a side effect or a cost starts. */
  | ({ type: 'step_intent'; taskId: TaskId; epoch: number } & StepIntent)
  /** How a step ended. Applies only to a step still running. */
  | {
      type: 'step_outcome';
      taskId: TaskId;
      epoch: number;
      stepId: StepId;
      status: 'done' | 'failed';
      /** What a rerun would reuse: bounded text, only for a `done` step. */
      output?: string;
    }
  /** A new attempt found the step running: its driver is gone and it may or may not have finished. */
  | { type: 'step_interrupted'; taskId: TaskId; epoch: number; stepId: StepId };

/** Why a new attempt began: a restart of the server, or a resume after a lost box. */
export type AttemptCause = 'restart' | 'resume';

export type StepId = string;

/**
 * `safe` steps (reading, tests, building, a model call) run again after a crash. `never` steps
 * (push, open or merge a PR, send, pay) are not run again: an interrupted one is reported as "may
 * or may not have taken effect".
 */
export type ReplayClass = 'safe' | 'never';

export interface StepIntent {
  /** The memo key: the first intent with this id wins. */
  stepId: StepId;
  /** What kind of step, in a few words (`model`, `tool`, `push`, `pr`, `message`, `box`). */
  kind: string;
  replay: ReplayClass;
  /** One printable line saying what the step does, without secrets. */
  label: string;
}

export type StepState = 'running' | 'done' | 'failed' | 'interrupted';

export interface StepRecord extends StepIntent {
  state: StepState;
  /** The epoch that wrote the intent (the latest one to, for a `safe` step run again). */
  epoch: number;
}

/**
 * Why a stop is owed: `restart` (a restart could not stop a leftover run),
 * `cancel_failed` (the runner refused a cancel) or `run_live` (the task ended
 * while its run was still registered or starting).
 */
export type StopPendingCause = 'restart' | 'cancel_failed' | 'run_live';

export interface StoredEvent {
  /** Position in the log, starting at 1 and strictly increasing. */
  seq: number;
  /** Epoch milliseconds from the orchestrator clock. */
  at: number;
  event: TaskEvent;
}

export interface TaskRecord {
  taskId: TaskId;
  /** Session that created the task. Visibility is derived from this and `parentTaskId`. */
  sessionId: SessionId;
  /** The session that started the tree this task belongs to; quotas are counted against it. */
  rootSessionId: SessionId;
  parentTaskId?: TaskId;
  runner: string;
  title?: string;
  mode: TaskMode;
  /** Set on a top-level task: the cap its whole tree shares. */
  budgetUsd?: number;
  /**
   * On a top-level task: what the runners of its tree reported spending, by task and attempt
   * (key `<epoch>:<taskId>`).
   */
  spendByRun?: Record<string, number>;
  /** On a top-level task: the sum of `spendByRun`. */
  costUsd?: number;
  state: TaskState;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  /**
   * Time the task has spent running, in milliseconds: the intervals between a start (or a resume
   * from a pause) and the next pause or end. A server that is down while the task runs counts, the
   * sandbox keeps going. `runSince` is when the interval under way began.
   */
  runMs: number;
  runSince?: number;
  progress: string[];
  manifest?: ResultManifest;
  failureReason?: string;
  cancelRequestedBy?: SessionId | 'system';
  /** A pause was asked for and has neither happened nor failed yet, or has happened. Cleared by a failed pause or a resume. */
  pauseRequested?: boolean;
  /** A resume was asked for and has neither happened nor failed yet. */
  resumeRequested?: boolean;
  /** A `task_stop_pending` with no `task_stopped` after it: the run is not known to have stopped. */
  stopPending?: boolean;
  /** The latest attempt's epoch: 1 from creation, one more for each `task_attempt`. */
  epoch: number;
  /** Every step in the order of its first intent, without outputs (those stay in the log). */
  steps: Map<StepId, StepRecord>;
}

/** What a tool caller sees. Paths and session ids stay inside the server. */
export interface TaskView {
  taskId: TaskId;
  parentTaskId?: TaskId;
  runner: string;
  title?: string;
  state: TaskState;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  progress: string[];
  manifest?: ResultManifest;
  failureReason?: string;
  cancelRequested: boolean;
  /** On a top-level task: what its whole tree reported spending. Absent when no runner reported any. */
  costUsd?: number;
  /** The cap of the tree this task starts, on a top-level task delegated with a budget. */
  budgetUsd?: number;
  /** The tree's spend reached its cap, so the tree was cancelled. */
  budgetExceeded?: boolean;
  /** A pause is under way or in effect (`state` is `running` while it is under way, `paused` once it holds). */
  pauseRequested: boolean;
  /** Set by waiting calls that returned because the timeout elapsed, not because the task ended. */
  waitTimedOut?: boolean;
  /**
   * The task's run is not known to have stopped, whatever `state` says: stopping it
   * failed and is retried until the runner confirms. A finished task with this set
   * may still be running (and spending) somewhere.
   */
  stopPending?: boolean;
  /**
   * This task's runner is still starting, its cancel is being retried or its run's
   * stream is still being read, or a task below it has not ended, is still starting,
   * owes a stop, has its cancel retried or its stream still read: the tree may still
   * be running (and spending), or have spend not recorded yet, though this task ended.
   */
  treeStopPending?: boolean;
}

export type OrchestratorErrorCode =
  | 'not_found'
  | 'invalid_request'
  | 'unknown_runner'
  | 'depth_exceeded'
  | 'unauthorized'
  | 'quota_exceeded'
  | 'budget_exceeded'
  | 'cancelled'
  /** The task is not in a state the request applies to (finished, not started, not paused). */
  | 'invalid_state'
  /** The run's runner cannot do this (it has no pause). */
  | 'unsupported';

export class OrchestratorError extends Error {
  constructor(
    readonly code: OrchestratorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OrchestratorError';
  }
}
