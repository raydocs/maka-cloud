import { type FeedEvent, type InboxItem, type Question, TERMINAL, type TaskView } from './contract';

export interface ConversationState {
  messages: { id: string; role: 'user' | 'assistant' | 'notice'; text: string }[];
  tasks: Record<string, TaskView>;
  questions: Record<string, Question>;
  answers: Record<string, string>;
  /** The supervisor's inbox items of this conversation, by id; the highest version wins. */
  inbox: Record<string, InboxItem>;
}
export function emptyState(): ConversationState {
  return { messages: [], tasks: {}, questions: {}, answers: {}, inbox: {} };
}

/** A frame is only taken as an item when it has what the view relies on. */
function isInboxItem(value: unknown): value is InboxItem {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.itemId === 'string' &&
    typeof item.ask === 'string' &&
    typeof item.version === 'number' &&
    typeof item.preconditionHash === 'string' &&
    Array.isArray(item.options) &&
    (item.state === 'open' || item.state === 'answering' || item.state === 'closed')
  );
}

/** Takes an item the server sent into `held`, unless `held` already has a newer version of it. */
export function mergeInboxItem(
  held: Record<string, InboxItem>,
  item: unknown,
): Record<string, InboxItem> {
  if (!isInboxItem(item)) return held;
  const current = held[item.itemId];
  if (current && current.version > item.version) return held;
  return { ...held, [item.itemId]: item };
}

/** Takes an item the server sent, unless this view already holds a newer version of it. */
export function applyInboxItem(state: ConversationState, item: unknown): ConversationState {
  const inbox = mergeInboxItem(state.inbox, item);
  return inbox === state.inbox ? state : { ...state, inbox };
}

const MAX_PROGRESS_NOTES = 20;
/** Panels kept per task; the oldest go first. */
const MAX_PANELS = 12;

/**
 * The same rules as the orchestrator's reducer, applied to the events the feed
 * carries. A task keeps what it already knows when `task_created` is replayed.
 */
export function applyEvent(state: ConversationState, frame: FeedEvent): ConversationState {
  const next = { ...state };
  switch (frame.kind) {
    case 'message.posted':
      if (state.messages.some((m) => m.id === frame.data.messageId)) return state;
      next.messages = [
        ...state.messages,
        {
          id: frame.data.messageId,
          role: frame.data.role === 'assistant' ? 'assistant' : 'user',
          text: frame.data.text,
        },
      ];
      break;
    case 'conductor.notice': {
      const id = frame.data.noticeId ?? String(frame.id);
      if (state.messages.some((m) => m.id === id)) return state;
      next.messages = [...state.messages, { id, role: 'notice', text: frame.data.text }];
      break;
    }
    case 'conductor.question':
      next.questions = { ...state.questions, [frame.data.questionId]: frame.data };
      break;
    case 'inbox.item':
      return applyInboxItem(state, frame.data);
    case 'conductor.answered':
      next.answers = { ...state.answers, [frame.data.questionId]: frame.data.optionId };
      break;
    case 'task.event': {
      const { event, at } = frame.data;
      let task = state.tasks[event.taskId];
      if (event.type === 'task_created') {
        if (task) return state;
        task = {
          taskId: event.taskId,
          ...(event.parentTaskId === undefined ? {} : { parentTaskId: event.parentTaskId }),
          ...(event.title === undefined ? {} : { title: event.title }),
          ...(event.budgetUsd === undefined ? {} : { budgetUsd: event.budgetUsd }),
          state: 'queued',
          createdAt: at,
          progress: [],
          cancelRequested: false,
          pauseRequested: false,
        };
      } else if (!task) return state;
      else {
        task = { ...task };
        const ended = TERMINAL.has(task.state);
        switch (event.type) {
          // Spend and stops are recorded after a task ended too.
          case 'task_cost':
            if (
              typeof frame.data.totalCostUsd === 'number' &&
              Number.isFinite(frame.data.totalCostUsd) &&
              frame.data.totalCostUsd >= 0
            )
              task.costUsd = frame.data.totalCostUsd;
            break;
          case 'task_stop_pending':
            task.stopPending = true;
            break;
          case 'task_stopped':
            delete task.stopPending;
            break;
          default:
            if (ended) return state;
            applyLive(task, event, at);
            if (
              (event.type === 'task_pause_failed' || event.type === 'task_resume_failed') &&
              !state.messages.some((m) => m.id === `${frame.id}`)
            )
              next.messages = [
                ...state.messages,
                {
                  id: `${frame.id}`,
                  role: 'notice',
                  text:
                    event.type === 'task_pause_failed'
                      ? `Could not pause “${task.title ?? 'a task'}”. It keeps running. ${event.reason}`
                      : `Could not resume “${task.title ?? 'a task'}”. It stays paused. ${event.reason}`,
                },
              ];
        }
      }
      next.tasks = { ...state.tasks, [event.taskId]: task };
      break;
    }
  }
  return next;
}

function applyLive(
  task: TaskView,
  event: Extract<FeedEvent, { kind: 'task.event' }>['data']['event'],
  at: number,
) {
  switch (event.type) {
    case 'task_started':
      task.state = 'running';
      task.startedAt = at;
      // The task's story starts here, so a replay of the stream rebuilds its notes instead of doubling them.
      task.progress = [];
      delete task.narration;
      delete task.panels;
      break;
    case 'task_narration':
      task.narration = event.line;
      break;
    case 'task_panel': {
      const { type: _type, taskId: _taskId, ...panel } = event;
      const panels = task.panels ?? [];
      const at = panels.findIndex((shown) => shown.panelId === panel.panelId);
      // Replaced where it stands, so a chip does not move when it updates.
      const next =
        at < 0 ? [...panels, panel] : panels.map((shown, i) => (i === at ? panel : shown));
      task.panels = next.slice(-MAX_PANELS);
      break;
    }
    case 'task_progress':
      task.progress = [...task.progress, event.note].slice(-MAX_PROGRESS_NOTES);
      break;
    case 'task_restarted':
      // The client keeps no partial reply of a task, only its notes, so the text is the note.
      task.progress = [...task.progress, event.text].slice(-MAX_PROGRESS_NOTES);
      // The cut-off run's panels are no longer running; the new run reports its own.
      settlePanels(task);
      break;
    case 'task_succeeded':
      task.state = 'succeeded';
      settlePanels(task);
      task.manifest = event.manifest;
      task.finishedAt = at;
      break;
    case 'task_failed':
      task.state = 'failed';
      settlePanels(task);
      task.failureReason = event.reason;
      if (event.kept !== undefined) task.kept = event.kept;
      task.finishedAt = at;
      break;
    case 'task_cancel_requested':
      task.cancelRequested = true;
      break;
    case 'task_cancelled':
      task.state = 'cancelled';
      settlePanels(task);
      if (event.kept !== undefined) task.kept = event.kept;
      task.finishedAt = at;
      break;
    case 'task_pause_requested':
      if (task.state === 'running') task.pauseRequested = true;
      break;
    case 'task_paused':
      if (task.state === 'running' && task.pauseRequested) task.state = 'paused';
      break;
    case 'task_pause_failed':
      if (task.state === 'running') task.pauseRequested = false;
      break;
    case 'task_resumed':
      if (task.state === 'paused') {
        task.state = 'running';
        task.pauseRequested = false;
      }
      break;
  }
}

/** A task that ended or restarted shows no panel as running and no "doing now" line. */
function settlePanels(task: TaskView): void {
  delete task.narration;
  if (task.panels?.some((panel) => panel.state === 'running'))
    task.panels = task.panels.map((panel) =>
      panel.state === 'running' ? { ...panel, state: 'stopped' } : panel,
    );
}

/**
 * Takes what only the server's view knows from a fresh task list: the flags
 * that say a stopped-looking tree may still run, and the cost and budget it
 * worked out. Task state and progress stay as the event stream built them.
 */
export function mergeViews(state: ConversationState, views: TaskView[]): ConversationState {
  const tasks = { ...state.tasks };
  for (const view of views) {
    const task = tasks[view.taskId];
    if (!task) continue;
    const merged: TaskView = { ...task };
    for (const key of [
      'costUsd',
      'budgetUsd',
      'budgetExceeded',
      'stopPending',
      'treeStopPending',
    ] as const) {
      if (view[key] === undefined) delete merged[key];
      else (merged as unknown as Record<string, unknown>)[key] = view[key];
    }
    tasks[view.taskId] = merged;
  }
  return { ...state, tasks };
}

/** What the tree of top-level tasks reported spending. `complete` is false while some task has not reported. */
export function totalCost(tasks: TaskView[]): { usd: number | undefined; complete: boolean } {
  const roots = tasks.filter((task) => task.parentTaskId === undefined);
  const reported = roots.filter((task) => task.costUsd !== undefined);
  if (reported.length === 0) return { usd: undefined, complete: roots.length === 0 };
  return {
    usd: reported.reduce((sum, task) => sum + (task.costUsd ?? 0), 0),
    complete: reported.length === roots.length,
  };
}
