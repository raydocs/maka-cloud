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
    }
  | { type: 'task_started'; taskId: TaskId }
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
  | { type: 'task_resume_failed'; taskId: TaskId; reason: string };

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
  /** A pause is under way or in effect (`state` is `running` while it is under way, `paused` once it holds). */
  pauseRequested: boolean;
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
