import type { StoredEvent, TaskId, TaskRecord, TaskView } from './types.js';
import { isTerminal } from './types.js';

export type TaskMap = Map<TaskId, TaskRecord>;

/** Progress notes kept per task; older notes stay in the log. */
export const MAX_PROGRESS_NOTES = 20;
const VIEW_PROGRESS_NOTES = 10;

/**
 * Fold one log entry into `tasks`. This is the only place task state is
 * computed, for live updates and for replay alike. The first terminal event for
 * a task wins; anything after it (a runner finishing after a cancel) is ignored.
 */
export function applyEvent(tasks: TaskMap, { at, event }: StoredEvent): void {
  if (event.type === 'task_created') {
    tasks.set(event.taskId, {
      taskId: event.taskId,
      sessionId: event.sessionId,
      rootSessionId: event.rootSessionId ?? event.sessionId,
      ...(event.parentTaskId === undefined ? {} : { parentTaskId: event.parentTaskId }),
      runner: event.runner,
      ...(event.title === undefined ? {} : { title: event.title }),
      mode: event.mode,
      ...(event.budgetUsd === undefined ? {} : { budgetUsd: event.budgetUsd }),
      state: 'queued',
      createdAt: at,
      progress: [],
    });
    return;
  }
  const task = tasks.get(event.taskId);
  if (!task || isTerminal(task.state)) return;
  switch (event.type) {
    case 'task_started':
      task.state = 'running';
      task.startedAt = at;
      return;
    case 'task_cost': {
      const spend = (task.spendByTask ??= {});
      spend[event.fromTaskId] = Math.max(spend[event.fromTaskId] ?? 0, event.costUsd);
      const total = Object.values(spend).reduce((sum, usd) => sum + usd, 0);
      task.costUsd = Math.round(total * 1e9) / 1e9;
      return;
    }
    case 'task_progress':
      task.progress.push(event.note);
      if (task.progress.length > MAX_PROGRESS_NOTES) task.progress.shift();
      return;
    case 'task_succeeded':
      task.state = 'succeeded';
      task.finishedAt = at;
      task.manifest = event.manifest;
      return;
    case 'task_failed':
      task.state = 'failed';
      task.finishedAt = at;
      task.failureReason = event.reason;
      return;
    case 'task_cancel_requested':
      task.cancelRequestedBy ??= event.by;
      return;
    case 'task_cancelled':
      task.state = 'cancelled';
      task.finishedAt = at;
      return;
    case 'task_pause_requested':
      if (task.state === 'running') task.pauseRequested = true;
      return;
    case 'task_paused':
      if (task.state === 'running' && task.pauseRequested) task.state = 'paused';
      return;
    case 'task_pause_failed':
      if (task.state === 'running') delete task.pauseRequested;
      return;
    case 'task_resume_requested':
      if (task.state === 'paused') task.resumeRequested = true;
      return;
    case 'task_resume_failed':
      if (task.state === 'paused') delete task.resumeRequested;
      return;
    case 'task_resumed':
      if (task.state === 'paused') {
        task.state = 'running';
        delete task.pauseRequested;
        delete task.resumeRequested;
      }
      return;
  }
}

export function reduce(events: Iterable<StoredEvent>): TaskMap {
  const tasks: TaskMap = new Map();
  for (const stored of events) applyEvent(tasks, stored);
  return tasks;
}

export function toView(task: TaskRecord): TaskView {
  return {
    taskId: task.taskId,
    ...(task.parentTaskId === undefined ? {} : { parentTaskId: task.parentTaskId }),
    runner: task.runner,
    ...(task.title === undefined ? {} : { title: task.title }),
    state: task.state,
    createdAt: task.createdAt,
    ...(task.startedAt === undefined ? {} : { startedAt: task.startedAt }),
    ...(task.finishedAt === undefined ? {} : { finishedAt: task.finishedAt }),
    progress: task.progress.slice(-VIEW_PROGRESS_NOTES),
    ...(task.manifest === undefined ? {} : { manifest: structuredClone(task.manifest) }),
    ...(task.failureReason === undefined ? {} : { failureReason: task.failureReason }),
    cancelRequested: task.cancelRequestedBy !== undefined,
    pauseRequested: task.pauseRequested === true,
    ...(task.costUsd === undefined ? {} : { costUsd: task.costUsd }),
    ...(task.budgetUsd === undefined
      ? {}
      : {
          budgetUsd: task.budgetUsd,
          ...((task.costUsd ?? 0) >= task.budgetUsd ? { budgetExceeded: true } : {}),
        }),
  };
}
