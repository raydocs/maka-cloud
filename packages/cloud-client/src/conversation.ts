import { ApiError, type CloudClient, Unsupported } from './client';
import { type ConnectionState, connectionText } from './connection';
import type {
  ArtifactListing,
  InboxItem,
  Mode,
  Question,
  QuotaReason,
  TaskControl,
} from './contract';
import { type ErrorText, errorText } from './errors';
import { randomId } from './ids';
import { inboxAnswerer } from './inboxAnswer';
import { memoryOutbox, OUTBOX_KEEP_MS, type Outbox, type OutboxEntry } from './outbox';
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

/** Why a message was not sent. */
export type SendFailure =
  /** The server could not be reached. */
  | 'offline'
  /** The server was busy or failed; trying again may work. */
  | 'server'
  /** The server refused this message; trying again would be refused too. */
  | 'rejected'
  /** The server already has a different message under this id. */
  | 'conflict'
  /** This device's sign-in is no longer valid. */
  | 'signed_out'
  /** The app was closed or reloaded before the server confirmed it. It may have arrived. */
  | 'interrupted'
  /**
   * Kept unsent for longer than `OUTBOX_KEEP_MS` since its last try: shown this once (it can still be
   * sent again, or its words copied) and no longer kept on the device.
   */
  | 'expired'
  /**
   * A spending or service limit refused it (`quota` says which, when it resets and what to do).
   * Not retryable until the limit resets; then it may be sent again.
   */
  | 'quota';

/**
 * Where a message the person sent stands, until the conversation shows it: `queued` (kept on the
 * device, not posted yet), `sending`, `sent` (the server confirmed it) or `failed`.
 */
export type OutgoingStatus =
  | { state: 'queued' }
  | { state: 'sending' }
  | { state: 'sent'; messageId?: string }
  | { state: 'failed'; reason: SendFailure; retryable: boolean; quota?: QuotaReason };

export interface OutgoingMessage {
  /** The `clientMessageId`, the same on every try. */
  id: string;
  text: string;
  at: number;
  mode?: Mode;
  /**
   * The id of the last event the live stream had brought when this was sent. Only a message from a
   * later event can stand in for it by its words (see `showsMessage`); unset when the stream was
   * not live.
   */
  afterEvent?: number;
  status: OutgoingStatus;
}

export interface ConversationSnapshot {
  state: ConversationState;
  /** Where the live link stands. */
  connection: ConnectionState;
  /** The same in words (`connectionText`). */
  status: string;
  /**
   * The person's messages the conversation does not show yet, oldest first. One leaves this list
   * when the conversation shows it, or when the person discards it.
   */
  outgoing: OutgoingMessage[];
  /** Storage failed during this feed; one quiet notice stays by the composer. */
  unsentStorageFailed?: boolean;
  error: ErrorText;
  /** The key of the action in flight, or ''. One action runs at a time. */
  busy: string;
  artifacts: Record<string, TaskArtifacts>;
  /** Tasks whose runner said it cannot pause. */
  noPause: ReadonlySet<string>;
}

/** Events after which the server's own task list is read again (cost, budget, stops still owed). */
const REFRESH_AFTER = new Set([
  'task_created',
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
  /** Cuts the wait before the stream's next try short, while it waits. */
  private wake: (() => void) | undefined;
  /** Timers that make a message refused by a limit sendable again once the limit resets. */
  private readonly resets = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly listed = new Set<string>();
  /** The newest event id the stream brought, and which event brought each message. */
  private lastEventId = 0;
  private readonly eventOf = new Map<string, number>();
  /** Messages already taken as some outgoing message by their words, so one never stands for two. */
  private readonly claimed = new Set<string>();
  private readonly answerInboxItem: ReturnType<typeof inboxAnswerer>;

  constructor(
    private readonly client: CloudClient,
    readonly conversationId: string,
    private readonly reconcileDelayMs = 250,
    /** Where an unacknowledged message is kept across a reload; the default keeps it in memory. */
    private readonly outbox: Outbox = memoryOutbox(),
    private readonly now: () => number = Date.now,
  ) {
    super({
      state: emptyState(),
      connection: { state: 'connecting' },
      status: connectionText({ state: 'connecting' }),
      outgoing: [],
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
    void this.restore();
  }

  /**
   * Messages kept from an earlier visit, a reload or a crash come back as failed ("interrupted"):
   * the person decides whether to send them again. They are never resent on their own, which could
   * post something hours after the person moved on. A message the conversation shows by then is
   * dropped instead. One kept past `OUTBOX_KEEP_MS` since its last try is shown this once, as
   * expired, and deleted from the device: its words are never dropped without being shown.
   */
  private async restore(): Promise<void> {
    let entries: OutboxEntry[];
    try {
      entries = await this.outbox.list(this.conversationId);
    } catch {
      return;
    }
    if (entries.length === 0) return;
    const now = this.now();
    const expired = (entry: OutboxEntry) => now - (entry.keptAt ?? entry.at) >= OUTBOX_KEEP_MS;
    const shown: string[] = [];
    this.update((s) => {
      const known = new Set(s.outgoing.map((message) => message.id));
      const back = entries
        .filter((entry) => !known.has(entry.id))
        .map((entry): OutgoingMessage => {
          shown.push(entry.id);
          return {
            ...outgoingOf(entry),
            // A message whose last try ended without an answer may still have been in flight.
            status:
              !expired(entry) && entry.failure === 'quota' && entry.quota
                ? quotaFailure(entry.quota, now)
                : {
                    state: 'failed',
                    reason: expired(entry)
                      ? 'expired'
                      : entry.failure === 'quota'
                        ? 'interrupted'
                        : (entry.failure ?? 'interrupted'),
                    retryable: true,
                  },
          };
        });
      return back.length === 0 ? s : { ...s, outgoing: [...back, ...s.outgoing] };
    });
    // Shown now, so no longer kept; sending it again keeps it anew.
    for (const entry of entries)
      if (expired(entry) && shown.includes(entry.id))
        void this.outbox.remove(this.conversationId, entry.id).catch(() => {});
    this.armResets();
    this.settle();
  }

  /** A message a limit refused becomes sendable again when the limit resets, while the feed runs. */
  private armResets(): void {
    for (const message of this.getSnapshot().outgoing) {
      const { status } = message;
      if (status.state !== 'failed' || status.reason !== 'quota' || status.retryable) continue;
      const resetsAt = status.quota?.resetsAt;
      if (resetsAt == null || this.resets.has(message.id)) continue;
      // Timers cannot wait longer than about 24 days at once: a longer wait is taken in steps.
      const wait = Math.min(Math.max(0, resetsAt - this.now()), 2_147_483_647);
      this.resets.set(
        message.id,
        setTimeout(() => {
          this.resets.delete(message.id);
          const now = this.getSnapshot().outgoing.find((m) => m.id === message.id)?.status;
          if (now?.state !== 'failed' || now.reason !== 'quota' || !now.quota) return;
          this.setOutgoing(message.id, quotaFailure(now.quota, this.now()));
          this.armResets();
        }, wait),
      );
    }
  }

  private setConnection(connection: ConnectionState): void {
    this.patch({ connection, status: connectionText(connection) });
  }

  /** "Retry now": while the stream waits to try again, it tries at once. */
  retryNow(): void {
    this.wake?.();
  }

  /** Opens the stream; it replays the conversation from the start, and the folding is idempotent, so it is safe to call again after `stop`. It does not resume from a remembered event id: after a restored backup the server's ids restart lower, and a stale id would leave the stream silent. */
  start(): void {
    if (this.controller) return;
    const controller = new AbortController();
    this.controller = controller;
    this.setConnection({ state: 'connecting' });
    this.armResets();
    this.client
      .subscribe(
        this.conversationId,
        (event) => {
          if (event.data.conversationId !== this.conversationId) return;
          this.lastEventId = Math.max(this.lastEventId, event.id);
          if (event.kind === 'message.posted' && !this.eventOf.has(event.data.messageId))
            this.eventOf.set(event.data.messageId, event.id);
          this.setState((previous) => applyEvent(previous, event));
          if (event.kind === 'task.event' && REFRESH_AFTER.has(event.data.event.type))
            this.reconcile(controller);
        },
        (connection) => {
          if (connection.state !== 'reconnecting' && connection.state !== 'offline')
            this.wake = undefined;
          this.setConnection(connection);
        },
        controller.signal,
        {
          onWait: (wake) => {
            this.wake = wake;
          },
        },
      )
      .catch(() => {
        if (!controller.signal.aborted) {
          this.patch({ error: errorText(undefined) });
          this.setConnection({ state: 'protocol_error' });
        }
      });
  }

  stop(): void {
    this.controller?.abort();
    this.controller = undefined;
    this.wake = undefined;
    for (const timer of this.resets.values()) clearTimeout(timer);
    this.resets.clear();
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
    this.settle();
    this.listResults();
  }

  /** A message the conversation now shows is no longer outgoing, and no longer kept. */
  private settle(): void {
    const { state, outgoing } = this.getSnapshot();
    if (outgoing.length === 0) return;
    const shown = outgoing.filter((message) =>
      showsMessage(state, message, this.eventOf, this.claimed),
    );
    if (shown.length === 0) return;
    const ids = new Set(shown.map((message) => message.id));
    this.update((s) => ({ ...s, outgoing: s.outgoing.filter((m) => !ids.has(m.id)) }));
    for (const id of ids) void this.outbox.remove(this.conversationId, id).catch(() => {});
  }

  private setOutgoing(id: string, status: OutgoingStatus): void {
    this.update((s) =>
      s.outgoing.some((message) => message.id === id)
        ? {
            ...s,
            outgoing: s.outgoing.map((message) =>
              message.id === id ? { ...message, status } : message,
            ),
          }
        : s,
    );
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
   * Sends a message: it is in `outgoing` at once, kept in the outbox before it is posted, and
   * posted under an id of its own. Resolves true when the server confirmed it; a failure stays in
   * `outgoing` as `failed`, with whether trying again can help. Like every action, it does nothing
   * while another one runs.
   */
  send(text: string, mode?: Mode): Promise<boolean> {
    const body = text.trim();
    if (!body || this.pending) return Promise.resolve(false);
    const live = this.getSnapshot().connection.state === 'live';
    const message: OutgoingMessage = {
      id: randomId(),
      text: body,
      at: this.now(),
      ...(mode === undefined ? {} : { mode }),
      ...(live ? { afterEvent: this.lastEventId } : {}),
      status: { state: 'queued' },
    };
    this.update((s) => ({ ...s, outgoing: [...s.outgoing, message] }));
    return this.deliver(message);
  }

  /** Sends a failed message again, under the same id: the server runs it once, however often it is tried. */
  retry(id: string): Promise<boolean> {
    const message = this.getSnapshot().outgoing.find((m) => m.id === id);
    if (!message || message.status.state !== 'failed' || !message.status.retryable)
      return Promise.resolve(false);
    if (this.pending) return Promise.resolve(false);
    return this.deliver(message);
  }

  /** Gives up on a failed message: it leaves the conversation and the outbox. */
  discard(id: string): void {
    const message = this.getSnapshot().outgoing.find((m) => m.id === id);
    if (!message || message.status.state !== 'failed') return;
    this.update((s) => ({ ...s, outgoing: s.outgoing.filter((m) => m.id !== id) }));
    void this.outbox.remove(this.conversationId, id).catch(() => {});
  }

  private async deliver(message: OutgoingMessage): Promise<boolean> {
    let sent = false;
    const ran = await this.act('message', async () => {
      // Kept before the post: a reload while it is in flight finds it.
      const kept = await this.outbox
        .put(entryOf(this.conversationId, message, this.now()))
        .catch(() => false);
      if (kept === false && !this.getSnapshot().unsentStorageFailed) {
        this.update((s) => ({ ...s, unsentStorageFailed: true }));
      }
      this.setOutgoing(message.id, { state: 'sending' });
      try {
        const answer: unknown = await this.client.postMessage(
          this.conversationId,
          message.text,
          message.id,
          message.mode,
        );
        const messageId = (answer as { messageId?: unknown } | undefined)?.messageId;
        this.setOutgoing(
          message.id,
          typeof messageId === 'string' ? { state: 'sent', messageId } : { state: 'sent' },
        );
        sent = true;
      } catch (e) {
        const failure = sendFailure(e, this.now());
        this.setOutgoing(message.id, { state: 'failed', ...failure });
        this.armResets();
        // Kept only while sending it again can help, with why it failed, for a later visit. One
        // the conversation showed meanwhile is gone from `outgoing` and is not kept again.
        const still = this.getSnapshot().outgoing.some((m) => m.id === message.id);
        // A limit's refusal is kept too: the words can be sent once it resets.
        if (
          failure.reason === 'offline' ||
          failure.reason === 'server' ||
          failure.reason === 'quota'
        ) {
          if (still)
            await this.outbox
              .put({
                ...entryOf(this.conversationId, message, this.now()),
                failure: failure.reason,
                ...(failure.quota ? { quota: failure.quota } : {}),
              })
              .catch(() => {});
          return;
        }
      }
      await this.outbox.remove(this.conversationId, message.id).catch(() => {});
      this.settle();
    });
    return ran && sent;
  }
}

function outgoingOf(entry: OutboxEntry): Omit<OutgoingMessage, 'status'> {
  return {
    id: entry.id,
    text: entry.text,
    at: entry.at,
    ...(entry.mode === undefined ? {} : { mode: entry.mode }),
  };
}

/** The outbox record of a message, kept from `keptAt` (its latest try). */
function entryOf(conversationId: string, message: OutgoingMessage, keptAt: number): OutboxEntry {
  return {
    id: message.id,
    conversationId,
    text: message.text,
    at: message.at,
    keptAt,
    ...(message.mode === undefined ? {} : { mode: message.mode }),
  };
}

/** A limit's refusal: sendable again only once the limit has reset. */
function quotaFailure(
  quota: QuotaReason,
  now: number,
): Extract<OutgoingStatus, { state: 'failed' }> {
  return {
    state: 'failed',
    reason: 'quota',
    retryable: quota.resetsAt !== null && quota.resetsAt <= now,
    quota,
  };
}

/** Why a post failed, and whether the same message sent again can succeed (`now`: for a limit's reset). */
export function sendFailure(
  error: unknown,
  now: number = Date.now(),
): { reason: SendFailure; retryable: boolean; quota?: QuotaReason } {
  if (error instanceof Unsupported) return { reason: 'rejected', retryable: false };
  if (!(error instanceof ApiError)) return { reason: 'offline', retryable: true };
  if (error.quota) {
    const { reason, retryable, quota } = quotaFailure(error.quota, now);
    return { reason, retryable, ...(quota ? { quota } : {}) };
  }
  if (error.status === 401) return { reason: 'signed_out', retryable: false };
  if (error.status === 409 && error.code === 'client_message_id_conflict')
    return { reason: 'conflict', retryable: false };
  if (error.status >= 500 || error.status === 408 || error.status === 429)
    return { reason: 'server', retryable: true };
  return { reason: 'rejected', retryable: false };
}

/**
 * Whether the conversation shows this outgoing message: by the server's id for it, or by the id it
 * was sent under. Only a message the server confirmed without naming its id (an older server) may
 * be matched by its words, and only by a message without a client id that a later event than the
 * last one seen live at sending brought, so a replayed older message with the same words never
 * stands in for it. A queued, sending or failed message is matched by id only: matching one wrongly
 * would drop words the server may never have had.
 */
function showsMessage(
  state: ConversationState,
  message: OutgoingMessage,
  eventOf: ReadonlyMap<string, number>,
  claimed: Set<string>,
): boolean {
  const mine = state.messages.filter((m) => m.role === 'user');
  const { status } = message;
  if (status.state === 'sent' && status.messageId)
    return mine.some((m) => m.id === status.messageId || m.clientMessageId === message.id);
  if (mine.some((m) => m.clientMessageId === message.id)) return true;
  const boundary = message.afterEvent;
  if (status.state !== 'sent' || boundary === undefined) return false;
  const match = mine.find(
    (m) =>
      m.clientMessageId === undefined &&
      !claimed.has(m.id) &&
      (eventOf.get(m.id) ?? 0) > boundary &&
      m.text.trim() === message.text,
  );
  if (match) claimed.add(match.id);
  return match !== undefined;
}

/** Why a message was not sent, in words the apps translate (shown after their own "Not sent"). */
export function sendFailureText(reason: SendFailure): string {
  switch (reason) {
    case 'offline':
      return 'Check your connection and send it again.';
    case 'server':
      return 'The server did not answer. Send it again.';
    case 'rejected':
      return 'The server refused this message.';
    case 'conflict':
      return 'A different message was already sent under this id.';
    case 'signed_out':
      return 'Sign in again to send it.';
    case 'quota':
      // The apps show the limit itself (`quotaText`); this is the words when it is not known.
      return 'A spending limit was reached.';
    case 'expired':
      return 'Kept unsent for 30 days, so no longer saved on this device. Send it again or copy the words.';
    case 'interrupted':
      return 'The app closed before the server confirmed it. It may have arrived.';
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
