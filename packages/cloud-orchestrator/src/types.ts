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
   * of its tree (`taskId`). Cumulative per runner: each report replaces that runner's last one.
   */
  | { type: 'task_cost'; taskId: TaskId; fromTaskId: TaskId; costUsd: number }
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
  | { type: 'task_stopped'; taskId: TaskId };

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
  /** On a top-level task: what the runners of its tree reported spending, by task. */
  spendByTask?: Record<TaskId, number>;
  /** On a top-level task: the sum of `spendByTask`. */
  costUsd?: number;
  state: TaskState;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
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
