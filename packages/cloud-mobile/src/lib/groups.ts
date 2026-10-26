import {
  type Conversation,
  type InboxItem,
  splitSuggestions,
  TERMINAL,
  type TaskView,
} from '@maka-cloud/client';

/**
 * What a conversation's row says under its title: its state, from the decisions and tasks the
 * phone read. Absent when its tasks were not read (an older conversation, or a failed read).
 */
export type RowState =
  | 'needs'
  | 'working'
  | 'paused'
  | 'queued'
  | 'finished'
  | 'failed'
  | 'stopped'
  | 'talk';

export interface SheetRow {
  conversation: Conversation;
  state: RowState | undefined;
  /** The latest thing known to have happened in it, for the order within a group. */
  at: number;
}

export interface SheetGroups {
  needs: SheetRow[];
  working: SheetRow[];
  recent: SheetRow[];
}

const ENDED: Record<string, RowState> = {
  succeeded: 'finished',
  failed: 'failed',
  cancelled: 'stopped',
};

/**
 * The conversations in three groups, each newest first: what needs the person (an open decision,
 * not a suggestion), what is working (a top-level task running, paused or waiting to start), and
 * the rest. `tasks` holds the conversations whose tasks were read.
 */
export function groupConversations(
  conversations: readonly Conversation[],
  open: readonly InboxItem[],
  tasks: Readonly<Record<string, readonly TaskView[]>>,
): SheetGroups {
  const { waiting } = splitSuggestions(open.filter((item) => item.state === 'open'));
  const groups: SheetGroups = { needs: [], working: [], recent: [] };
  for (const conversation of conversations) {
    const id = conversation.conversationId;
    const asks = waiting.filter((item) => item.conversationId === id);
    const read = tasks[id];
    const roots = (read ?? []).filter((task) => task.parentTaskId === undefined);
    const at = Math.max(
      conversation.createdAt,
      ...asks.map((item) => item.updatedAt),
      ...roots.map((task) => task.finishedAt ?? task.startedAt ?? task.createdAt),
    );
    if (asks.length > 0) {
      groups.needs.push({ conversation, state: 'needs', at });
      continue;
    }
    const going = roots.filter((task) => !TERMINAL.has(task.state));
    if (going.length > 0) {
      const state = going.some((task) => task.state === 'running')
        ? 'working'
        : going.some((task) => task.state === 'paused')
          ? 'paused'
          : 'queued';
      groups.working.push({ conversation, state, at });
      continue;
    }
    const last = [...roots].sort(
      (a, b) => (a.finishedAt ?? a.createdAt) - (b.finishedAt ?? b.createdAt),
    )[roots.length - 1];
    const state = read === undefined ? undefined : last ? ENDED[last.state] : 'talk';
    groups.recent.push({ conversation, state, at });
  }
  const newest = (a: SheetRow, b: SheetRow) => b.at - a.at;
  groups.needs.sort(newest);
  groups.working.sort(newest);
  groups.recent.sort(newest);
  return groups;
}
