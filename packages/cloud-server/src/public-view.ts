import type { TaskEvent, TaskView } from '@maka-cloud/orchestrator';

/**
 * What the public API shows of a task. The runner id names the vendor behind a
 * run, so it never leaves the server. `costUsd` comes from the view: the
 * orchestrator's `task_cost` events add up there, and it is absent until the
 * first one.
 */
export type PublicTaskView = Omit<TaskView, 'runner'>;

export function toPublicView(view: TaskView): PublicTaskView {
  const { runner: _runner, ...rest } = view;
  return rest;
}

/** A logged event as clients see it: without the runner id. */
export function toPublicEvent(event: TaskEvent): unknown {
  if (event.type !== 'task_created') return event;
  const { runner: _runner, ...rest } = event;
  return rest;
}
