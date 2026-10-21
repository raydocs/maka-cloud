import type { StoredEvent, TaskId, TaskRecord, TaskView } from './types.js';
import { isTerminal } from './types.js';

export type TaskMap = Map<TaskId, TaskRecord>;

/** Progress notes kept per task; older notes stay in the log. */
export const MAX_PROGRESS_NOTES = 20;
const VIEW_PROGRESS_NOTES = 10;

/**
 * Fold one log entry into `tasks`. This is the only place task state is
 * computed, for live updates and for replay alike. The first terminal event for
 * a task wins; anything after it (a runner finishing after a cancel) is ignored,
 * except whether its run is known to have stopped and what its tree spent.
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
      runMs: 0,
      progress: [],
      epoch: 1,
      steps: new Map(),
      steers: new Map(),
    });
    return;
  }
  const task = tasks.get(event.taskId);
  if (!task) return;
  // Whether the run stopped is tracked past the task's end.
  if (event.type === 'task_stop_pending') {
    task.stopPending = true;
    return;
  }
  if (event.type === 'task_stopped') {
    delete task.stopPending;
    return;
  }
  // Spend settles after a cancel or an end too (a request in flight when the run stopped).
  if (event.type === 'task_cost') {
    const spend = (task.spendByRun ??= {});
    const run = spendKey(event);
    spend[run] = Math.max(spend[run] ?? 0, event.costUsd);
    const total = Object.values(spend).reduce((sum, usd) => sum + usd, 0);
    task.costUsd = Math.round(total * 1e9) / 1e9;
    return;
  }
  if (isTerminal(task.state)) return;
  switch (event.type) {
    case 'task_started':
      task.state = 'running';
      task.startedAt = at;
      task.runSince = at;
      return;
    case 'task_progress':
    case 'task_restarted':
      task.progress.push(event.type === 'task_progress' ? event.note : event.text);
      if (task.progress.length > MAX_PROGRESS_NOTES) task.progress.shift();
      return;
    case 'task_succeeded':
      task.state = 'succeeded';
      task.finishedAt = at;
      stopClock(task, at);
      task.manifest = event.manifest;
      return;
    case 'task_failed':
      task.state = 'failed';
      task.finishedAt = at;
      stopClock(task, at);
      task.failureReason = event.reason;
      return;
    case 'task_cancel_requested':
      task.cancelRequestedBy ??= event.by;
      return;
    case 'task_cancelled':
      task.state = 'cancelled';
      task.finishedAt = at;
      stopClock(task, at);
      return;
    case 'task_pause_requested':
      if (task.state === 'running') task.pauseRequested = true;
      return;
    case 'task_paused':
      if (task.state === 'running' && task.pauseRequested) {
        task.state = 'paused';
        stopClock(task, at);
      }
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
        task.runSince = at;
        delete task.pauseRequested;
        delete task.resumeRequested;
      }
      return;
    case 'task_attempt':
      // The store lets only the next epoch in; a log that somehow holds another is not followed.
      if (event.epoch === task.epoch + 1) {
        task.epoch = event.epoch;
        // What the agent was told in the attempt before is in its conversation; what it is told
        // now waits until the resumed turn has done one thing, so it is not read among the replay.
        task.steersHeld = true;
      }
      return;
    case 'step_intent': {
      if (event.epoch !== task.epoch) return;
      const known = task.steps.get(event.stepId);
      // The first intent per memo key wins. Only a `safe` step that an attempt found running
      // (interrupted) runs again, by the attempt after it.
      if (known && !(known.state === 'interrupted' && known.replay === 'safe')) return;
      task.steps.set(event.stepId, {
        stepId: event.stepId,
        kind: event.kind,
        replay: known?.replay ?? event.replay,
        label: event.label,
        state: 'running',
        epoch: event.epoch,
      });
      return;
    }
    case 'step_outcome': {
      const step = task.steps.get(event.stepId);
      // An outcome applies only to a step still running, from the epoch that started it.
      if (step?.state !== 'running' || step.epoch !== event.epoch) return;
      step.state = event.status;
      delete task.steersHeld;
      return;
    }
    case 'task_steer':
      if (!task.steers.has(event.steerId)) {
        task.steers.set(event.steerId, {
          steerId: event.steerId,
          text: event.text,
          state: 'pending',
        });
      }
      return;
    case 'task_steer_delivered':
    case 'task_steer_withdrawn':
    case 'task_steer_unseen': {
      const steer = task.steers.get(event.steerId);
      if (steer?.state !== 'pending') return;
      steer.state =
        event.type === 'task_steer_delivered'
          ? 'delivered'
          : event.type === 'task_steer_withdrawn'
            ? 'withdrawn'
            : 'unseen';
      return;
    }
    case 'step_interrupted': {
      const step = task.steps.get(event.stepId);
      if (step?.state === 'running' && step.epoch < event.epoch) step.state = 'interrupted';
      return;
    }
  }
}

/** Adds the running interval under way to the time the task has run. */
function stopClock(task: TaskRecord, at: number): void {
  if (task.runSince === undefined) return;
  task.runMs += Math.max(0, at - task.runSince);
  delete task.runSince;
}

/** How long the task has run as of `now`, the interval under way included. */
export function runTimeMs(task: Pick<TaskRecord, 'runMs' | 'runSince'>, now: number): number {
  return task.runMs + (task.runSince === undefined ? 0 : Math.max(0, now - task.runSince));
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
    ...(task.stopPending === true ? { stopPending: true } : {}),
    ...(task.costUsd === undefined ? {} : { costUsd: task.costUsd }),
    ...(task.budgetUsd === undefined
      ? {}
      : {
          budgetUsd: task.budgetUsd,
          ...((task.costUsd ?? 0) >= task.budgetUsd ? { budgetExceeded: true } : {}),
        }),
  };
}

/** The run a `task_cost` event reports on: one task's runner in one attempt. */
export function spendKey(event: { fromTaskId: TaskId; epoch?: number }): string {
  return `${event.epoch ?? 0}:${event.fromTaskId}`;
}
