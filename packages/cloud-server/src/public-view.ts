import type { TaskEvent, TaskView } from '@maka-cloud/orchestrator';

/**
 * What the public API shows of a task. The runner id names the vendor behind a
 * run, so it never leaves the server; cost is left out when it is not known.
 */
export type PublicTaskView = Omit<TaskView, 'runner'> & { costUsd?: number };

export function toPublicView(view: TaskView, costUsd?: number): PublicTaskView {
  const { runner: _runner, ...rest } = view;
  return costUsd === undefined ? rest : { ...rest, costUsd };
}

/** A logged event as clients see it: without the runner id. */
export function toPublicEvent(event: TaskEvent): unknown {
  if (event.type !== 'task_created') return event;
  const { runner: _runner, ...rest } = event;
  return rest;
}
