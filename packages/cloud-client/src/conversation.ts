import { ApiError, type CloudClient } from './client';
import type { ArtifactListing, InboxItem, Mode, Question, TaskControl } from './contract';
import { errorText } from './errors';
import { randomId } from './ids';
import { inboxAnswerer } from './inboxAnswer';
import { type PendingSends, reusable } from './pending';
import { displayText } from './presentation';
import {
  applyEvent,
  applyInboxItem,
  type ConversationState,
  emptyState,
  mergeViews,
} from './state';
import { Store } from './store';

/** What the server listed for a finished task, or that it could not. */
export interface TaskArtifacts {
  listings: ArtifactListing[];
  failed?: boolean;
}

export interface ConversationSnapshot {
  state: ConversationState;
  /** 'Connecting…', 'Live', 'Disconnected' and the like, in words. */
  status: string;
  error: string;
  /** The key of the action in flight, or ''. One action runs at a time. */
  busy: string;
  artifacts: Record<string, TaskArtifacts>;
  /** Tasks whose runner said it cannot pause. */
  noPause: ReadonlySet<string>;
}

/** Events after which the server's own task list is read again (cost, budget, stops still owed). */
const REFRESH_AFTER = new Set([
  'task_succeeded',
  'task_failed',
  'task_cancelled',
  'task_cancel_requested',
  'task_stop_pending',
  'task_stopped',
]);

/**
 * One conversation, live: the event stream folded into state, the task list read again after the
 * events that change what only the server works out, the results of finished tasks listed once,
 * and the person's actions (a message, an answer, pause/resume/cancel) one at a time with a stable
 * id, so a retry is the server's duplicate and never a second one. Web and phone apps read it
 * through `subscribe` and `getSnapshot`.
 */
export class ConversationFeed extends Store<ConversationSnapshot> {
  private controller: AbortController | undefined;
  private refresh: ReturnType<typeof setTimeout> | undefined;
  private pending = false;
  private messageId: string | null = null;
  private readonly listed = new Set<string>();
  private readonly answerInboxItem: ReturnType<typeof inboxAnswerer>;

  constructor(
    private readonly client: CloudClient,
    readonly conversationId: string,
    private readonly reconcileDelayMs = 250,
    /** Where an unacknowledged send is kept across a reload; none keeps it in memory only. */
    private readonly sends?: PendingSends,
    private readonly now: () => number = Date.now,
  ) {
    super({
      state: emptyState(),
      status: 'Connecting…',
      error: '',
      busy: '',
      artifacts: {},
      noPause: new Set(),
    });
    this.answerInboxItem = inboxAnswerer(client, (item) =>
      this.update((s) => {
        const state = applyInboxItem(s.state, item);
        return state === s.state ? s : { ...s, state };
      }),
    );
  }

  /** Opens the stream; it replays the conversation from the start, and the folding is idempotent, so it is safe to call again after `stop`. It does not resume from a remembered event id: after a restored backup the server's ids restart lower, and a stale id would leave the stream silent. */
  start(): void {
    if (this.controller) return;
    const controller = new AbortController();
    this.controller = controller;
    this.patch({ status: 'Connecting…' });
    this.client
      .subscribe(
        this.conversationId,
        (event) => {
          if (event.data.conversationId !== this.conversationId) return;
          this.setState((previous) => applyEvent(previous, event));
          if (event.kind === 'task.event' && REFRESH_AFTER.has(event.data.event.type))
            this.reconcile(controller);
        },
        (status) => this.patch({ status }),
        controller.signal,
      )
      .catch(() => {
        if (!controller.signal.aborted)
          this.patch({ error: errorText(undefined), status: 'Disconnected' });
      });
  }

  stop(): void {
    this.controller?.abort();
    this.controller = undefined;
    clearTimeout(this.refresh);
  }

  private reconcile(controller: AbortController): void {
    clearTimeout(this.refresh);
    this.refresh = setTimeout(() => {
      this.client
        .listTasks(this.conversationId)
        .then((views) => {
          if (!controller.signal.aborted) this.setState((previous) => mergeViews(previous, views));
        })
        .catch(() => {});
    }, this.reconcileDelayMs);
  }

  private setState(change: (state: ConversationState) => ConversationState): void {
    this.update((s) => {
      const state = change(s.state);
      return state === s.state ? s : { ...s, state };
    });
    this.listResults();
  }

  /** A finished task with results: ask the server what they are, once. */
  private listResults(): void {
    for (const task of Object.values(this.getSnapshot().state.tasks)) {
      if (
        (task.state !== 'succeeded' && !task.kept) ||
        !(task.manifest ?? task.kept)?.artifacts?.length ||
        this.listed.has(task.taskId)
      )
        continue;
      this.listed.add(task.taskId);
      this.client
        .listArtifacts(task.taskId)
        .then(({ artifacts: listings }) => this.setArtifacts(task.taskId, { listings }))
        .catch(() => this.setArtifacts(task.taskId, { listings: [], failed: true }));
    }
  }

  private setArtifacts(taskId: string, entry: TaskArtifacts): void {
    this.update((s) => ({ ...s, artifacts: { ...s.artifacts, [taskId]: entry } }));
  }

  /**
   * Runs one action at a time. A second call while one is in flight does nothing. Resolves true
   * when the work finished; a failure becomes `error` in words and resolves false.
   */
  async act(key: string, work: () => Promise<unknown>): Promise<boolean> {
    if (this.pending) return false;
    this.pending = true;
    this.patch({ busy: key, error: '' });
    try {
      await work();
      return true;
    } catch (e) {
      this.patch({ error: errorText(e) });
      return false;
    } finally {
      this.pending = false;
      this.patch({ busy: '' });
    }
  }

  async control(taskId: string, action: TaskControl): Promise<void> {
    try {
      await this.client.control(taskId, action);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'pause_unsupported')
        this.update((s) => ({ ...s, noPause: new Set(s.noPause).add(taskId) }));
      throw e;
    }
  }

  answerItem(item: InboxItem, optionId: string, text?: string): Promise<boolean> {
    return this.act('inbox', () => this.answerInboxItem(item, optionId, text));
  }

  answerQuestion(question: Question, optionId: string, text?: string): Promise<boolean> {
    return this.act('answer', async () => {
      // 200 means the server recorded it (a repeat of the same answer is a duplicate).
      await this.client.answer(this.conversationId, {
        questionId: question.questionId,
        optionId,
        ...(text ? { text } : {}),
      });
      this.setState((previous) => ({
        ...previous,
        answers: { ...previous.answers, [question.questionId]: optionId },
      }));
    });
  }

  /**
   * Posts a message. A retry of the same text (after a failed post) reuses its id; see
   * `draftEdited`. With `sends`, so does the same text sent again after a reload, while the first
   * post was never acknowledged: the server dedupes on the id, so it runs once.
   */
  send(text: string, mode?: Mode): Promise<boolean> {
    const body = text.trim();
    if (!body) return Promise.resolve(false);
    return this.act('message', async () => {
      const kept = reusable(this.sends?.read(this.conversationId), body, this.now());
      this.messageId ??= kept?.id ?? randomId();
      // Kept before the post: a reload while it is in flight finds it.
      this.sends?.write(this.conversationId, {
        id: this.messageId,
        text: body,
        at: kept?.at ?? this.now(),
      });
      await this.client.postMessage(this.conversationId, body, this.messageId, mode);
      this.messageId = null;
      this.sends?.clear(this.conversationId);
    });
  }

  /** Call when the draft changes: a different text is a different message. */
  draftEdited(): void {
    // Editing away from a send that failed in this page makes the next send a new message, kept
    // record included. After a reload there is no such send in memory, so typing the same words
    // again still finds the kept one.
    if (this.messageId !== null) this.sends?.clear(this.conversationId);
    this.messageId = null;
  }
}

/** The numbers and sets a conversation view shows, worked out from a snapshot. */
export function conversationSummary(snapshot: ConversationSnapshot) {
  const { state } = snapshot;
  const tasks = Object.values(state.tasks);
  const questions = Object.values(state.questions);
  return {
    tasks,
    questions,
    running: tasks.filter((task) => task.state === 'running').length,
    withResults: tasks.filter((task) => snapshot.artifacts[task.taskId]),
    openQuestions: new Set(
      questions
        .filter((question) => state.answers[question.questionId] === undefined)
        .map((question) => displayText(question.question).trim()),
    ),
  };
}
