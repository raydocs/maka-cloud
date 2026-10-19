import { z } from 'zod';

export type TaskId = string;
export type SessionId = string;

export const TASK_STATES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
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
  | { type: 'task_cancelled'; taskId: TaskId };

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
  /** Set by waiting calls that returned because the timeout elapsed, not because the task ended. */
  waitTimedOut?: boolean;
}

export type OrchestratorErrorCode =
  | 'not_found'
  | 'invalid_request'
  | 'unknown_runner'
  | 'depth_exceeded'
  | 'unauthorized'
  | 'quota_exceeded'
  | 'budget_exceeded'
  | 'cancelled';

export class OrchestratorError extends Error {
  constructor(
    readonly code: OrchestratorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OrchestratorError';
  }
}
