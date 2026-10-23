import {
  type Conversation,
  displayText,
  doneSince,
  type HomeSnapshot,
  type InboxItem,
  type NextRun,
  nextRuns,
  splitSuggestions,
  TERMINAL,
  type TaskView,
} from '@maka-cloud/client';

/** A task that is running, waiting to start or paused, and the conversation it belongs to. */
export interface WorkingRow {
  conversationId: string;
  task: TaskView;
}

/** One line under "since you were last here": a task that ended, or a note in the server's words. */
export type SinceRow =
  | {
      kind: 'task';
      key: string;
      conversationId: string;
      /** The task's title, else its conversation's; absent when neither has one. */
      title: string | undefined;
      /** The task's own summary (`ownWords`), or the app's sentence for how it ended. */
      outcome: string;
      ownWords: boolean;
      tone: 'ok' | 'bad' | 'idle';
      /** Only when the server reported a spend. */
      costUsd: number | undefined;
    }
  | { kind: 'note'; key: string; text: string };

/**
 * Home as a day's page, in a fixed order: what needs the person, what is working now, what happened
 * since the last visit, and what runs next. A part with nothing in it is empty, never a dash.
 * `shown` names the server's cards this page shows, in its order, so the server is told exactly those.
 */
export interface Today {
  needs: InboxItem[];
  working: WorkingRow[];
  since: SinceRow[];
  next: NextRun[];
  /** Duties that wake on a GitHub event rather than a time. */
  watching: number;
  shown: string[];
}

const ENDED_WORDS = {
  succeeded: 'Finished.',
  failed: 'It did not finish.',
  cancelled: 'Stopped before it finished.',
} as const;

const TONE = { succeeded: 'ok', failed: 'bad', cancelled: 'idle' } as const;

/**
 * Builds the page from the feed. Where the server keeps Home (`cards`), its cards and their order
 * decide what is waiting, what finished and what runs next; a card whose thing this phone has not
 * read is left out (and not reported as seen). On an older server, the feed's own parts do.
 */
export function todayOf(
  snapshot: Pick<HomeSnapshot, 'items' | 'since' | 'done' | 'projects' | 'cards'>,
  conversations: readonly Conversation[],
  now: number,
): Today {
  const { items, since, done, projects, cards } = snapshot;
  const titleOf = (conversationId: string) => {
    const title = conversations.find((c) => c.conversationId === conversationId)?.title;
    return title ? displayText(title) : undefined;
  };
  const runs = projects === undefined ? undefined : nextRuns(projects, now);
  const working = workingNow(done);

  if (cards === undefined) {
    const open = Object.values(items)
      .filter((item) => item.state !== 'closed')
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const { waiting, suggested } = splitSuggestions(open);
    const finished = since === undefined || done === undefined ? [] : doneSince(done, since);
    return {
      needs: [...waiting, ...suggested],
      working,
      since: finished.map((entry) => ({
        kind: 'task' as const,
        key: entry.taskId,
        conversationId: entry.conversationId,
        title: entry.task.title ? displayText(entry.task.title) : titleOf(entry.conversationId),
        outcome: entry.outcome,
        ownWords: entry.state === 'succeeded' && entry.task.manifest !== undefined,
        tone: TONE[entry.state as keyof typeof TONE] ?? 'idle',
        costUsd: entry.costUsd,
      })),
      next: runs?.scheduled ?? [],
      watching: runs?.watching ?? 0,
      shown: [],
    };
  }

  const needs: InboxItem[] = [];
  const sinceRows: SinceRow[] = [];
  const next: NextRun[] = [];
  const shown: string[] = [];
  for (const card of cards) {
    const { ref } = card;
    if ((card.kind === 'waiting' || card.kind === 'suggestion') && ref.type === 'inbox') {
      const item = items[ref.id];
      if (item === undefined || item.state === 'closed') continue;
      needs.push(item);
    } else if (card.kind === 'finished' && ref.type === 'task') {
      const task = done?.get(ref.conversationId)?.find((t) => t.taskId === ref.id);
      // The task as this phone read it, when it has; else how the server says it ended.
      const entry =
        task === undefined
          ? undefined
          : doneSince(new Map([[ref.conversationId, [task]]]), Number.NEGATIVE_INFINITY)[0];
      const state = entry?.state ?? card.state;
      if (state === undefined || !TERMINAL.has(state)) continue;
      const ended = state as keyof typeof ENDED_WORDS;
      sinceRows.push({
        kind: 'task',
        key: card.cardId,
        conversationId: ref.conversationId,
        title: task?.title ? displayText(task.title) : titleOf(ref.conversationId),
        outcome: entry?.outcome ?? ENDED_WORDS[ended],
        ownWords: entry !== undefined && ended === 'succeeded' && task?.manifest !== undefined,
        tone: TONE[ended],
        costUsd: entry?.costUsd,
      });
    } else if (card.kind === 'note' && card.text) {
      sinceRows.push({ kind: 'note', key: card.cardId, text: card.text });
    } else if (card.kind === 'scheduled' && ref.type === 'duty') {
      const project = projects?.find((p) => p.projectId === ref.projectId);
      const duty = project?.duties.find((d) => d.dutyId === ref.id);
      if (project === undefined || duty === undefined) continue;
      next.push({ dutyId: duty.dutyId, name: duty.name, repo: project.repo, at: card.at });
    } else {
      continue;
    }
    shown.push(card.cardId);
  }
  return { needs, working, since: sinceRows, next, watching: runs?.watching ?? 0, shown };
}

/** Top-level tasks not yet ended, the most recently started first. */
function workingNow(done: HomeSnapshot['done']): WorkingRow[] {
  if (done === undefined) return [];
  const rows: WorkingRow[] = [];
  for (const [conversationId, tasks] of done)
    for (const task of tasks)
      if (task.parentTaskId === undefined && !TERMINAL.has(task.state))
        rows.push({ conversationId, task });
  const started = (row: WorkingRow) => row.task.startedAt ?? row.task.createdAt;
  return rows.sort((a, b) => started(b) - started(a));
}

/** Morning until noon, afternoon until six, evening after, by the phone's clock. */
export function partOfDay(at: number): 'morning' | 'afternoon' | 'evening' {
  const hour = new Date(at).getHours();
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 18) return 'afternoon';
  return 'evening';
}
