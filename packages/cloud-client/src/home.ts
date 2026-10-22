import { TERMINAL, type ProjectView, type TaskView } from './contract';
import { failureWords } from './failure';
import { firstSentence } from './presentation';

export const DAY_MS = 86_400_000;
const DONE_LINES = 8;

export interface DoneEntry {
  conversationId: string;
  taskId: string;
  title: string;
  state: TaskView['state'];
  outcome: string;
  costUsd: number | undefined;
  finishedAt: number;
  task: TaskView;
}

/** What finished since `since`: top-level tasks only (a subtask is part of its parent's story), newest first. */
export function doneSince(
  byConversation: ReadonlyMap<string, readonly TaskView[]>,
  since: number,
): DoneEntry[] {
  const entries: DoneEntry[] = [];
  for (const [conversationId, tasks] of byConversation) {
    for (const task of tasks) {
      if (task.parentTaskId !== undefined || !TERMINAL.has(task.state)) continue;
      if (task.finishedAt === undefined || task.finishedAt <= since) continue;
      const outcome =
        task.state === 'succeeded'
          ? firstSentence(task.manifest?.summary ?? 'Finished.')
          : task.state === 'cancelled'
            ? 'Stopped before it finished.'
            : task.failureReason === undefined
              ? 'It did not finish.'
              : failureWords(task.failureReason).sentence;
      entries.push({
        conversationId,
        taskId: task.taskId,
        title: task.title ?? 'Task',
        state: task.state,
        outcome,
        costUsd: task.costUsd,
        finishedAt: task.finishedAt,
        task,
      });
    }
  }
  return entries.sort((a, b) => b.finishedAt - a.finishedAt).slice(0, DONE_LINES);
}

export interface NextRun {
  dutyId: string;
  name: string;
  repo: string;
  at: number;
}

/**
 * Scheduled duties that are on, soonest first. A schedule runs every `everyMinutes`, counted from the
 * moment the duty was approved; duties that wake on a GitHub event have no time, so they are counted.
 */
export function nextRuns(
  projects: readonly ProjectView[],
  now: number,
): { scheduled: NextRun[]; watching: number } {
  const scheduled: NextRun[] = [];
  let watching = 0;
  for (const project of projects) {
    for (const duty of project.duties) {
      if (duty.state !== 'active') continue;
      const period = (duty.trigger.everyMinutes ?? 0) * 60_000;
      if (duty.trigger.kind !== 'schedule' || period <= 0 || duty.activatedAt === null) {
        if (duty.trigger.kind !== 'schedule') watching += 1;
        continue;
      }
      const slots = Math.max(0, Math.floor((now - duty.activatedAt) / period)) + 1;
      scheduled.push({
        dutyId: duty.dutyId,
        name: duty.name,
        repo: project.repo,
        at: duty.activatedAt + slots * period,
      });
    }
  }
  return { scheduled: scheduled.sort((a, b) => a.at - b.at), watching };
}

/** "in 5 min", "in 3 h", "in 2 days": a time ahead, in the words a person would use. */
export function relativeTime(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((at - now) / 60_000));
  if (minutes < 1) return 'any moment now';
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours} h`;
  return `in ${Math.round(hours / 24)} days`;
}

const VERB: Record<string, string> = {
  approval: 'Approve',
  budget: 'Decide',
  decision: 'Decide',
  blocked: 'Unblock',
  verification_failed: 'Review',
  finished: 'Review',
  suggestion: 'Suggested',
};
export const verbOf = (kind: string) => VERB[kind] ?? 'Decide';
