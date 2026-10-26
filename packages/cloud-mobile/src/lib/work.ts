import {
  type ConversationState,
  displayText,
  stepsOf,
  TERMINAL,
  type TaskPanel,
  type TaskView,
} from '@maka-cloud/client';
import type { Steer } from './steer';
import type { Key } from './strings';

type Message = ConversationState['messages'][number];
type Say = (key: Key, params?: Record<string, string | number>) => string;

/**
 * What the chat shows, in time order: the messages, one work block per message the person sent
 * (the steps of the tasks that message started), a pill for each task, and each finished task's
 * result where it finished.
 */
export type ChatItem =
  | { type: 'message'; key: string; message: Message }
  | { type: 'work'; key: string; tasks: TaskView[]; last: boolean }
  | { type: 'task'; key: string; task: TaskView }
  | { type: 'result'; key: string; task: TaskView }
  | { type: 'steer'; key: string; steer: Steer };

/** Within the same moment: the person's message, its work, a task, a reply, a result, then a steer. */
const RANK = { user: 0, work: 1, task: 2, reply: 3, result: 4, steer: 5 } as const;

/**
 * The chat in time order. A task belongs to the latest message the person sent before it was
 * created; tasks from before any message (a standing duty's) share one block at the top. A message
 * without a time (none is sent without one) keeps its place after the one before it. What the
 * person told a running task (`steers`) sits where it was sent.
 */
export function chatTimeline(
  messages: readonly Message[],
  roots: readonly TaskView[],
  steers: readonly Steer[] = [],
): ChatItem[] {
  const placed: Array<{ item: ChatItem; at: number; rank: number; seq: number }> = [];
  let seq = 0;
  const put = (item: ChatItem, at: number, rank: number) =>
    placed.push({ item, at, rank, seq: seq++ });
  let clock = Number.NEGATIVE_INFINITY;
  const sent: Array<{ id: string; at: number }> = [];
  for (const message of messages) {
    clock = Math.max(clock, message.at ?? clock);
    const user = message.role === 'user';
    put({ type: 'message', key: message.id, message }, clock, user ? RANK.user : RANK.reply);
    if (user) sent.push({ id: message.id, at: clock });
  }
  const byTurn = new Map<string, TaskView[]>();
  const lead: TaskView[] = [];
  for (const task of [...roots].sort((a, b) => a.createdAt - b.createdAt)) {
    const turn = sent.filter((message) => message.at <= task.createdAt).at(-1);
    if (turn) byTurn.set(turn.id, [...(byTurn.get(turn.id) ?? []), task]);
    else lead.push(task);
    put({ type: 'task', key: `task-${task.taskId}`, task }, task.createdAt, RANK.task);
    if (TERMINAL.has(task.state))
      put(
        { type: 'result', key: `result-${task.taskId}`, task },
        task.finishedAt ?? task.createdAt,
        RANK.result,
      );
  }
  for (const steer of steers)
    put({ type: 'steer', key: `steer-${steer.id}`, steer }, steer.at, RANK.steer);
  const lastSent = sent.at(-1)?.id;
  if (lead.length > 0)
    put(
      { type: 'work', key: 'work-lead', tasks: lead, last: lastSent === undefined },
      lead[0]?.createdAt ?? 0,
      RANK.work,
    );
  for (const message of sent) {
    const tasks = byTurn.get(message.id) ?? [];
    // The latest message always has its block: it carries the "working" line before any task.
    if (tasks.length > 0 || message.id === lastSent)
      put(
        { type: 'work', key: `work-${message.id}`, tasks, last: message.id === lastSent },
        message.at,
        RANK.work,
      );
  }
  return placed
    .sort((a, b) => a.at - b.at || a.rank - b.rank || a.seq - b.seq)
    .map(({ item }) => item);
}

/** One row of a work block: a panel with its state, or a step the task noted (it has no outcome). */
export interface WorkStep {
  key: string;
  title: string;
  summary?: string;
  state: TaskPanel['state'] | 'noted';
}

const live = (task: TaskView) => !TERMINAL.has(task.state);

/**
 * The rows of a work block. A task's panels (tests, the change, the review) each have a state; a
 * task that reports no panels shows the steps it noted instead, and only its current one, while it
 * runs, is marked as running: a noted step says nothing about how it went.
 */
export function workSteps(tasks: readonly TaskView[]): WorkStep[] {
  return tasks.flatMap((task): WorkStep[] => {
    if (task.panels && task.panels.length > 0)
      return task.panels.map((panel) => ({
        key: `${task.taskId}-${panel.panelId}`,
        title: panel.title,
        summary: panel.summary,
        state: panel.state,
      }));
    const { steps } = stepsOf(task.progress);
    return steps.map((step, i) => ({
      key: `${task.taskId}-note-${i}`,
      title: displayText(step),
      state: live(task) && i === steps.length - 1 ? ('running' as const) : ('noted' as const),
    }));
  });
}

/** The line a working block shows: a running task's narration, else its current step. */
export function liveLine(tasks: readonly TaskView[]): string | undefined {
  for (const task of tasks.filter((task) => task.state === 'running')) {
    if (task.narration) return task.narration;
    const { current } = stepsOf(task.progress);
    if (current !== undefined) return displayText(current);
  }
  return undefined;
}

/** How long the tasks took, from the first start to the last finish; only once all have finished. */
export function workedFor(tasks: readonly TaskView[]): number | undefined {
  if (tasks.length === 0 || tasks.some((task) => task.finishedAt === undefined)) return undefined;
  const start = Math.min(...tasks.map((task) => task.startedAt ?? task.createdAt));
  const end = Math.max(...tasks.map((task) => task.finishedAt ?? 0));
  return end >= start ? end - start : undefined;
}

/**
 * When the work now running began: the earliest start of the tasks that are running. Undefined
 * when none runs (paused or waiting tasks have no clock) or none has said when it started.
 */
export function runningSince(tasks: readonly TaskView[]): number | undefined {
  const starts = tasks
    .filter((task) => task.state === 'running' && task.startedAt !== undefined)
    .map((task) => task.startedAt as number);
  return starts.length > 0 ? Math.min(...starts) : undefined;
}

/** A stopwatch reading: "0:07", "12:30", "1:02:03". */
export function clockOf(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
}

/** "Worked for 4 min · 6 steps": only the parts that are known. */
export function doneSummary(tasks: readonly TaskView[], say: Say): string {
  const ms = workedFor(tasks);
  const minutes = ms === undefined ? undefined : Math.round(ms / 60_000);
  const time =
    minutes === undefined
      ? undefined
      : minutes < 1
        ? say('work.underMinute')
        : minutes < 60
          ? say('work.minutes', { count: minutes })
          : say('work.hours', { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
  const count = workSteps(tasks).length;
  const steps =
    count === 0 ? undefined : count === 1 ? say('work.step') : say('work.steps', { count });
  return [time, steps].filter(Boolean).join(' · ');
}

/**
 * The coding runner's fixed narration lines and panel titles (packages/cloud-playbooks/src/coding):
 * product words, shown in the app's language. Any other line is shown as sent.
 */
export const RUNNER_WORDS: ReadonlyArray<readonly [english: string, key: Key]> = [
  ['Fetching the repository', 'runner.fetch'],
  ['An agent is working on the change', 'runner.change'],
  ['The agent is fixing what the checks found', 'runner.fixChecks'],
  ['A second agent is reviewing the change', 'runner.reviewing'],
  ['Fixing the problems the review found', 'runner.fixReview'],
  ['Running the reproduction test with the change', 'runner.reproWith'],
  ["Running the repository's tests", 'runner.tests'],
  ['Running the reproduction test without the change, where it must fail', 'runner.reproWithout'],
  ['Repository tests', 'runner.title.tests'],
  ['Reproduction test with the change', 'runner.title.reproWith'],
  ['Reproduction test without the change', 'runner.title.reproWithout'],
  ['Change', 'runner.title.change'],
  ['Second review', 'runner.title.review'],
];
const RUNNER = new Map(RUNNER_WORDS);

export function runnerWords(text: string, say: Say): string {
  const key = RUNNER.get(text);
  return key ? say(key) : text;
}

/**
 * A panel's summary in the app's language. Summaries come in fixed shapes only (the orchestrator
 * takes nothing else, `cleanPanel`), so each shape has its words; anything else is shown as sent.
 */
export function panelSummary(summary: string, say: Say): string {
  const fixed: Record<string, Key> = {
    running: 'panel.running',
    stopped: 'panel.stopped',
    passed: 'panel.passed',
    failed: 'panel.failed',
    'timed out': 'panel.timedOut',
    'could not run': 'panel.couldNotRun',
    'not available': 'panel.notAvailable',
    'no changes': 'panel.noChanges',
    '1 file': 'panel.file',
    '1 result': 'panel.result',
  };
  const key = Object.prototype.hasOwnProperty.call(fixed, summary) ? fixed[summary] : undefined;
  if (key) return say(key);
  let m: RegExpExecArray | null;
  if ((m = /^exit (\d{1,3})$/u.exec(summary))) return say('panel.exit', { code: m[1] ?? '' });
  if ((m = /^failed \(exit (\d{1,3})\)$/u.exec(summary)))
    return say('panel.failedExit', { code: m[1] ?? '' });
  if ((m = /^(\d{1,6}) passed$/u.exec(summary)))
    return say('panel.passedCount', { count: m[1] ?? '' });
  if ((m = /^(\d{1,6}) failed$/u.exec(summary)))
    return say('panel.failedCount', { count: m[1] ?? '' });
  if ((m = /^(\d{1,6}) passed, (\d{1,6}) failed$/u.exec(summary)))
    return say('panel.passedFailed', { passed: m[1] ?? '', failed: m[2] ?? '' });
  if ((m = /^(\d{1,5}) files$/u.exec(summary))) return say('panel.files', { count: m[1] ?? '' });
  if ((m = /^\+(\d{1,7}) −(\d{1,7}) in 1 file$/u.exec(summary)))
    return say('panel.linesFile', { added: m[1] ?? '', removed: m[2] ?? '' });
  if ((m = /^\+(\d{1,7}) −(\d{1,7}) in (\d{1,5}) files$/u.exec(summary)))
    return say('panel.linesFiles', { added: m[1] ?? '', removed: m[2] ?? '', count: m[3] ?? '' });
  if ((m = /^(\d{1,4}) P1, (\d{1,4}) P2, (\d{1,4}) P3$/u.exec(summary)))
    return say('panel.review', { p1: m[1] ?? '', p2: m[2] ?? '', p3: m[3] ?? '' });
  if ((m = /^(\d{1,4}) results$/u.exec(summary)))
    return say('panel.results', { count: m[1] ?? '' });
  return summary;
}

/**
 * What an approval card touches, read from the labelled lines the card itself carries
 * (`Repository: …`, `Branch: …`, `Base branch: …`, as the pull request tool writes them). A label
 * counts only when exactly one line starts with it, so text quoted elsewhere on the card cannot
 * pose as one. The values are the card's own words, never rewritten.
 */
export function touchesOf(card: string): { repository?: string; branch?: string; base?: string } {
  const one = (label: string) => {
    const found = card.split('\n').filter((line) => line.startsWith(`${label}: `));
    const value = found.length === 1 ? found[0]?.slice(label.length + 2).trim() : undefined;
    return value ? value : undefined;
  };
  const repository = one('Repository');
  const branch = one('Branch');
  const base = one('Base branch');
  return {
    ...(repository && !repository.startsWith('unknown') ? { repository } : {}),
    ...(branch ? { branch } : {}),
    ...(base ? { base } : {}),
  };
}

/** The tool a card's exact text asks to allow (`Allow tool(…)? …`), when it has that shape. */
export function heldToolOf(card: string): string | undefined {
  return /^Allow ([A-Za-z0-9_.-]{1,64})\(/u.exec(card)?.[1];
}
