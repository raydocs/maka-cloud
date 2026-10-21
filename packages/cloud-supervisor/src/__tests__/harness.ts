import type {
  FeedEntry,
  Interrupt,
  QuestionDelivery,
  QuestionOutcome,
  SummaryModel,
  SupervisorHost,
} from '../host.js';
import { Supervisor, type SupervisorOptions } from '../supervisor.js';
import type { Settings } from '../settings.js';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

export class Clock {
  constructor(public t = Date.UTC(2026, 9, 19, 12, 0, 0)) {}
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

/** A promise a test settles by hand: the handshake that replaces a sleep. */
export class Gate<T = void> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (error: unknown) => void;
  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

export class FakeFeed {
  readonly entries: FeedEntry[] = [];
  private readonly listeners = new Set<() => void>();
  listening(): number {
    return this.listeners.size;
  }
  read = (after: number, limit: number): FeedEntry[] =>
    this.entries.filter((entry) => entry.id > after).slice(0, limit);
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  append(
    kind: string,
    conversationId: string | null,
    data: unknown,
    at: number,
    options: { notify?: boolean } = {},
  ): FeedEntry {
    const entry: FeedEntry = { id: this.entries.length + 1, kind, conversationId, at, data };
    this.entries.push(entry);
    if (options.notify !== false) for (const listener of [...this.listeners]) listener();
    return entry;
  }
}

export interface HostScript {
  /** Called for each question delivery; returns the outcome, or throws. */
  deliver?: (delivery: QuestionDelivery, signal: AbortSignal) => Promise<QuestionOutcome>;
  post?: (
    message: { conversationId: string; text: string; clientMessageId: string },
    signal: AbortSignal,
  ) => Promise<void>;
  interrupt?: (interrupt: Interrupt) => Promise<void>;
  publish?: (event: { kind: string; data: unknown }) => Promise<void>;
}

/** The server side, faked. Messages are idempotent on the client id, as the T4 route is. */
export class FakeHost implements SupervisorHost {
  readonly feed = new FakeFeed();
  readonly script: HostScript = {};
  readonly interrupts: Interrupt[] = [];
  readonly published: Array<{ kind: string; conversationId: string | null; data: any }> = [];
  readonly deliveries: QuestionDelivery[] = [];
  readonly posted: Array<{
    conversationId: string;
    text: string;
    clientMessageId: string;
    caller?: string;
  }> = [];
  /** Callers the host no longer takes messages from, as the server does for a revoked invite. */
  readonly refusedCallers = new Set<string>();
  readonly warnings: string[] = [];
  private readonly seenClientIds = new Set<string>();
  /** Deliveries the "conductor" accepted, by question: what it would have applied. */
  readonly applied = new Map<string, string>();

  notifier = {
    interrupt: async (interrupt: Interrupt): Promise<void> => {
      this.interrupts.push(interrupt);
      await this.script.interrupt?.(interrupt);
    },
  };

  answers = {
    deliver: async (delivery: QuestionDelivery, signal: AbortSignal): Promise<QuestionOutcome> => {
      this.deliveries.push(delivery);
      if (this.script.deliver) return this.script.deliver(delivery, signal);
      return this.conductor(delivery);
    },
  };

  messages = {
    post: async (
      message: { conversationId: string; text: string; clientMessageId: string; caller?: string },
      signal: AbortSignal,
    ): Promise<{ messageId: string } | { refused: string }> => {
      await this.script.post?.(message, signal);
      if (message.caller !== undefined && this.refusedCallers.has(message.caller)) {
        return { refused: 'not_found' };
      }
      if (!this.seenClientIds.has(message.clientMessageId)) {
        this.seenClientIds.add(message.clientMessageId);
        this.posted.push(message);
      }
      return { messageId: `msg_${message.clientMessageId}` };
    },
  };

  /** Behaves like T5's answers route: idempotent per question, a different option conflicts. */
  conductor(delivery: QuestionDelivery): QuestionOutcome {
    const earlier = this.applied.get(delivery.questionId);
    if (earlier !== undefined) {
      return earlier === delivery.optionId
        ? { accepted: true, duplicate: true }
        : { accepted: false, reason: 'conflict' };
    }
    this.applied.set(delivery.questionId, delivery.optionId);
    return { accepted: true, duplicate: false };
  }

  publish = async (event: {
    kind: 'inbox.item' | 'inbox.digest';
    conversationId: string | null;
    data: unknown;
  }): Promise<void> => {
    await this.script.publish?.(event);
    this.published.push(event as never);
  };

  /** Set by a test that has a duties engine: where `proposal` options are delivered. */
  proposals?: SupervisorHost['proposals'];

  /** Set by a test that has a cards service: where proposed cards are checked and decided. */
  suggestions?: SupervisorHost['suggestions'];

  /** Set by a test that knows owners: the host then builds a digest per owner. */
  ownerOf?: (conversationId: string) => string | undefined;

  onWarning = (message: string): void => {
    this.warnings.push(message);
  };
}

export interface Rig {
  host: FakeHost;
  clock: Clock;
  supervisor: Supervisor;
  /** Feed helpers: each appends an entry stamped with the clock and lets the supervisor process it. */
  taskCreated(
    taskId: string,
    options?: { conversation?: string; parent?: string; title?: string; runner?: string },
  ): Promise<void>;
  taskEvent(event: Record<string, unknown>, conversation?: string): Promise<void>;
  question(
    questionId: string,
    reason?: 'taste' | 'budget_overrun' | 'irreversible',
    conversation?: string,
  ): Promise<void>;
  answered(questionId: string, optionId: string, conversation?: string): Promise<void>;
  userMessage(conversation?: string): Promise<void>;
  stop(): Promise<void>;
}

export const CONVERSATION = 'cnv_1';

export async function rig(
  options: Partial<SupervisorOptions> & {
    host?: FakeHost;
    clock?: Clock;
    settings?: Partial<Settings>;
  } = {},
): Promise<Rig> {
  const host = options.host ?? new FakeHost();
  const clock = options.clock ?? new Clock();
  const supervisor = await Supervisor.start({
    dbPath: ':memory:',
    tickMs: 0,
    ...options,
    host,
    now: clock.now,
    settings: { digestAt: null, ...options.settings },
  });
  const append = async (kind: string, conversation: string, data: unknown) => {
    host.feed.append(kind, conversation, data, clock.t);
    await supervisor.settled();
  };
  let seq = 0;
  return {
    host,
    clock,
    supervisor,
    taskCreated: (taskId, o = {}) =>
      append('task.event', o.conversation ?? CONVERSATION, {
        seq: ++seq,
        at: clock.t,
        event: {
          type: 'task_created',
          taskId,
          sessionId: 'ses_1',
          runner: o.runner ?? 'claude-agent-sdk',
          mode: 'async',
          ...(o.parent ? { parentTaskId: o.parent } : {}),
          ...(o.title === undefined ? {} : { title: o.title }),
        },
      }),
    taskEvent: (event, conversation = CONVERSATION) =>
      append('task.event', conversation, { seq: ++seq, at: clock.t, event }),
    question: (questionId, reason = 'taste', conversation = CONVERSATION) =>
      append('conductor.question', conversation, {
        questionId,
        reason,
        question: `Which one for ${questionId}?`,
        options: [
          { id: 'a', label: 'Option A' },
          { id: 'b', label: 'Option B' },
        ],
        recommended: 'a',
      }),
    answered: (questionId, optionId, conversation = CONVERSATION) =>
      append('conductor.answered', conversation, { questionId, optionId }),
    userMessage: (conversation = CONVERSATION) =>
      append('message.posted', conversation, {
        messageId: `msg_${clock.t}_${seq++}`,
        role: 'user',
        text: 'hello',
        at: clock.t,
      }),
    stop: () => supervisor.stop(),
  };
}

export const MANIFEST = {
  summary: 'Did the thing.',
  done: ['did it'],
  notDone: [],
  confidence: 'high' as const,
  knownIssues: [],
};

/** A summary model that answers from a script. */
export class ScriptedSummary implements SummaryModel {
  calls = 0;
  /** What each call was given: whose items, and which. */
  readonly seen: Array<{ owner: string | undefined; ids: string[] }> = [];
  constructor(private readonly answer: (input: { items: Array<{ id: string }> }) => unknown) {}
  async summarize(
    input: {
      items: Array<{ id: string; kind: string; ask: string; ageMs: number }>;
    },
    _signal?: AbortSignal,
    owner?: string,
  ) {
    this.calls += 1;
    this.seen.push({ owner, ids: input.items.map((item) => item.id) });
    return this.answer(input) as { order: string[]; summary: string };
  }
}

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

/** A database file that is removed when the test file ends. */
export function tmpDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'supervisor-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'supervisor.db');
}

export async function firstItem(
  r: Rig,
  predicate: (item: { kind: string }) => boolean = () => true,
) {
  const item = r.supervisor.listItems({ state: 'all' }).items.find(predicate);
  assert.ok(item, 'an item exists');
  return item;
}

import assert from 'node:assert/strict';
