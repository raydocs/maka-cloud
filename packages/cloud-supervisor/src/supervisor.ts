import { randomUUID } from 'node:crypto';
import { openDatabase } from './db.js';
import { buildDigest, type Digest } from './digest.js';
import { signalOf } from './events.js';
import type { Interrupt, SummaryModel, SupervisorHost } from './host.js';
import { applySignal, capSpec, openItem, type Reassessment, reassess, stallPass } from './rules.js';
import {
  dueDigestSlot,
  inQuietHours,
  localParts,
  type Settings,
  type SettingsPatch,
  SettingsPatchSchema,
  SettingsSchema,
} from './settings.js';
import { type AnswerRecord, type ItemRecord, Store } from './store.js';
import type { VerificationOptions } from './verification/ports.js';
import { VerificationRunner } from './verification/runner.js';
import { buildMessage } from './text.js';
import { type ItemKind, type ItemOption, type ItemView, ITEM_KINDS } from './types.js';
import { toView } from './view.js';

export const MAX_ANSWER_TEXT = 4000;
const HOUR_MS = 3_600_000;
const MAX_BACKOFF_MS = 5 * 60_000;

export interface SupervisorOptions {
  /** The supervisor's own SQLite file; ':memory:' for tests. One process opens it. */
  dbPath: string;
  host: SupervisorHost;
  /** Writes the digest summary. Without it the digest uses a template. */
  summary?: SummaryModel;
  /** Defaults for settings the human has not changed. */
  settings?: Partial<Settings>;
  now?: () => number;
  /** How often the maintenance pass runs. 0 starts no timer; tests call `tick()`. */
  tickMs?: number;
  feedPage?: number;
  summaryTimeoutMs?: number;
  /**
   * Turns on independent verification of finished tasks. Without it a finished
   * task is shown as finished at once, marked as not independently checked.
   */
  verification?: VerificationOptions;
  /** Replaces setInterval, so a test can see the timer is released. */
  schedule?: (fn: () => void, ms: number) => () => void;
}

export interface AnswerRequest {
  itemId: string;
  /** Chosen by the client, 1 to 64 letters, digits, "_" or "-". A retry reuses it. */
  answerId: string;
  optionId: string;
  text?: string;
  /** The `preconditionHash` of the item as the human saw it. */
  preconditionHash: string;
  /** Who answers, as the host names them. Stored with the answer and handed back on delivery. */
  caller?: string;
  /** When given, an item of any other conversation is `not_found`: the caller may act on these only. */
  conversations?: readonly string[];
}

export type AnswerResult =
  | { ok: true; duplicate: boolean; item: ItemView }
  | {
      ok: false;
      reason:
        | 'not_found'
        | 'invalid_request'
        | 'invalid_option'
        | 'text_not_allowed'
        | 'text_too_long'
        | 'stale'
        | 'closed'
        | 'already_answered'
        | 'question_open'
        | 'stopped';
      item?: ItemView;
    };

export interface SupervisorStats {
  /** Async work in progress: pumps, pushes, deliveries, digests. */
  inflight: number;
  feedSubscriptions: number;
  timers: number;
  /** Independent verifications running now. */
  verifications: number;
}

const ANSWER_ID = /^[A-Za-z0-9_-]{1,64}$/u;

type Claim =
  | { ok: true; item: ItemRecord; answer?: AnswerRecord; duplicate: boolean; local: boolean }
  | { ok: false; result: Extract<AnswerResult, { ok: false }> };

/**
 * The supervisor: reads the feed, applies the escalation rules, keeps the
 * inbox, delivers pushes under the noise limits, and routes answers.
 *
 * Every check-then-act on shared state (claiming an answer, the hourly cap, a
 * digest slot, deduplicating an item) happens inside one synchronous
 * transaction with no await between the check and the write. Anything slow
 * (notifying, delivering, the summary model) runs outside, from rows that were
 * claimed first.
 */
export class Supervisor {
  private readonly store: Store;
  private readonly host: SupervisorHost;
  private readonly now: () => number;
  private readonly abort = new AbortController();
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly historyBefore: number;
  private readonly verifier: VerificationRunner | undefined;
  private unsubscribe: (() => void) | undefined;
  private cancelTimer: (() => void) | undefined;
  private stopped = false;
  private stopping: Promise<void> | undefined;
  private pumping = false;
  private pumpAgain = false;

  private constructor(private readonly options: SupervisorOptions) {
    this.host = options.host;
    this.now = options.now ?? Date.now;
    this.store = new Store(openDatabase(options.dbPath));
    try {
      this.store.resetInFlight();
      this.store.tx(() => this.store.requeueRunning());
      const first = this.store.tx(() => this.store.firstStart(this.now()));
      this.historyBefore = first;
      this.verifier = options.verification
        ? new VerificationRunner({
            store: this.store,
            options: options.verification,
            now: this.now,
            settings: () => this.settings(),
            signal: this.abort.signal,
            isStopped: () => this.stopped,
            afterSettled: () => this.afterFeed(),
            track: (work) => this.track(work),
            warn: (message, detail) => this.warn(message, detail),
          })
        : undefined;
    } catch (error) {
      this.store.db.close();
      throw error;
    }
  }

  static async start(options: SupervisorOptions): Promise<Supervisor> {
    const supervisor = new Supervisor(options);
    supervisor.unsubscribe = options.host.feed.subscribe(() => supervisor.kick());
    const tickMs = options.tickMs ?? 15_000;
    if (tickMs > 0) {
      const schedule =
        options.schedule ??
        ((fn, ms) => {
          const timer = setInterval(fn, ms);
          timer.unref();
          return () => clearInterval(timer);
        });
      supervisor.cancelTimer = schedule(() => void supervisor.tick(), tickMs);
    }
    supervisor.kick();
    return supervisor;
  }

  // ------------------------------------------------------------ lifecycle

  stats(): SupervisorStats {
    return {
      inflight: this.inflight.size,
      feedSubscriptions: this.unsubscribe ? 1 : 0,
      timers: this.cancelTimer ? 1 : 0,
      verifications: this.verifier?.running ?? 0,
    };
  }

  /** Resolves when no feed pass, push, delivery or digest is in progress. For tests and orderly shutdown. */
  async settled(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  /** Stops every loop, aborts what is in flight, waits for it, closes the database. Safe to call twice. */
  stop(): Promise<void> {
    this.stopping ??= this.shutdown();
    return this.stopping;
  }

  private async shutdown(): Promise<void> {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.abort.abort();
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
    this.store.db.close();
  }

  /**
   * Waits for work the host does without a signal (a push, a publish), but not
   * past `stop()`: a channel that hangs must not keep the supervisor from closing.
   */
  private untilStopped<T>(work: void | Promise<T>): Promise<void | T> {
    const pending = Promise.resolve(work);
    pending.catch(() => {});
    if (this.abort.signal.aborted) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onAbort = () => resolve();
      this.abort.signal.addEventListener('abort', onAbort, { once: true });
      pending.then(
        (value) => {
          this.abort.signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error) => {
          this.abort.signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.inflight.add(work);
    const done = () => {
      this.inflight.delete(work);
    };
    work.then(done, done);
    return work;
  }

  private warn(message: string, detail?: unknown): void {
    try {
      this.host.onWarning?.(message, detail);
    } catch {
      // A reporter that throws must not stop the supervisor.
    }
  }

  // ----------------------------------------------------------- feed loop

  private kick(): void {
    if (this.stopped) return;
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    void this.track(this.pump());
  }

  /** Drains the feed a page at a time, yielding between pages so a long history does not block the process. */
  private async pump(): Promise<void> {
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        while (!this.stopped && this.processPage() > 0) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        if (this.stopped) return;
        await this.afterFeed();
      } while (this.pumpAgain && !this.stopped);
    } catch (error) {
      this.warn('The supervisor feed loop failed', error);
    } finally {
      this.pumping = false;
    }
  }

  /** Reads one page, applies it and advances the cursor in one transaction. Returns how many entries it read. */
  private processPage(): number {
    const page = this.options.feedPage ?? 200;
    const entries = this.host.feed.read(this.store.cursor(), page);
    if (entries.length === 0) return 0;
    this.store.tx(() => {
      const settings = this.store.settings(this.options.settings);
      for (const entry of entries) {
        const signal = signalOf(entry);
        if (signal) {
          const result = this.store.scope(() =>
            applySignal(this.store, signal, {
              settings,
              historyBefore: this.historyBefore,
              verification: this.options.verification !== undefined,
            }),
          );
          if (!result.ok) this.warn(`The supervisor skipped feed entry ${entry.id}`, result.error);
        }
        this.store.setCursor(entry.id);
      }
    });
    return entries.length;
  }

  /** Processes the feed up to its current end, synchronously. */
  private catchUp(): void {
    while (!this.stopped && this.processPage() > 0) {
      // Keep reading until a page is empty.
    }
  }

  private async afterFeed(): Promise<void> {
    this.verifier?.pass();
    await this.flushPushes();
    await this.publishDirty();
  }

  // ---------------------------------------------------------------- tick

  /** The periodic pass: stalls, held pushes, answer retries, outbox, digest. */
  tick(): Promise<void> {
    return this.track(this.runTick());
  }

  private async runTick(): Promise<void> {
    if (this.stopped) return;
    try {
      this.catchUp();
      const at = this.now();
      this.store.tx(() => stallPass(this.store, this.store.settings(this.options.settings), at));
      this.verifier?.pass();
      await this.flushPushes();
      if (this.stopped) return;
      await this.flushHeld();
      if (this.stopped) return;
      await this.retryAnswers();
      if (this.stopped) return;
      await this.digestPass();
      if (this.stopped) return;
      await this.publishDirty();
    } catch (error) {
      this.warn('The supervisor maintenance pass failed', error);
    }
  }

  // ------------------------------------------------------------- pushes

  private settings(): Settings {
    return this.store.settings(this.options.settings);
  }

  private capReached(at: number): boolean {
    return this.store.deliveriesSince(at - HOUR_MS) >= this.settings().maxInterruptsPerHour;
  }

  /**
   * Decides each pending interrupt, one transaction per item: the hourly count
   * and the record of the push are the same write, so items arriving together
   * cannot exceed the cap. Holding back changes the push, never the item.
   */
  private async flushPushes(): Promise<void> {
    for (const pending of this.store.pendingPushes()) {
      if (this.stopped) return;
      const decision = this.store.tx((): 'send' | 'skip' => {
        const item = this.store.item(pending.itemId);
        if (!item || item.pushState !== 'pending' || item.state === 'closed') return 'skip';
        const settings = this.settings();
        const at = this.now();
        if (settings.mutedKinds.includes(item.kind)) {
          this.store.setPushState(item.itemId, 'muted');
          return 'skip';
        }
        if (inQuietHours(settings, at) || this.capReached(at)) {
          this.store.setPushState(item.itemId, 'held');
          return 'skip';
        }
        this.store.recordDelivery(at, 'interrupt', 1);
        this.store.setPushState(item.itemId, 'sent');
        this.store.logItem(item.itemId, 'pushed', at);
        return 'send';
      });
      if (decision === 'send') await this.notify({ items: [interruptItem(pending)], batch: false });
    }
  }

  /** Releases held interrupts as one batched push once quiet hours end and the cap has room. */
  private async flushHeld(): Promise<void> {
    const released = this.store.tx((): ItemRecord[] => {
      const held = this.store.heldPushes();
      if (held.length === 0) return [];
      const settings = this.settings();
      const at = this.now();
      const send: ItemRecord[] = [];
      for (const item of held) {
        if (settings.mutedKinds.includes(item.kind)) this.store.setPushState(item.itemId, 'muted');
        else send.push(item);
      }
      if (send.length === 0 || inQuietHours(settings, at) || this.capReached(at)) return [];
      this.store.recordDelivery(at, 'batch', send.length);
      for (const item of send) {
        this.store.setPushState(item.itemId, 'sent');
        this.store.logItem(item.itemId, 'pushed', at, 'batch');
      }
      return send;
    });
    if (released.length > 0) await this.notify({ items: released.map(interruptItem), batch: true });
  }

  /** At most once per item: a push that fails is reported and not repeated; the inbox and digest still list the item. */
  private async notify(interrupt: Interrupt): Promise<void> {
    try {
      await this.untilStopped(this.host.notifier.interrupt(interrupt));
    } catch (error) {
      this.warn('Notifying the human failed', error);
    }
  }

  // ------------------------------------------------------------- outbox

  /** Appends each changed item to the feed clients stream, at least once per version. */
  private async publishDirty(): Promise<void> {
    for (const dirty of this.store.dirtyItems(100)) {
      if (this.stopped) return;
      const item = this.store.item(dirty.itemId);
      if (!item) continue;
      try {
        const done = await this.untilStopped(
          Promise.resolve(
            this.host.publish({
              kind: 'inbox.item',
              conversationId: item.conversationId,
              data: toView(item, this.store.answerOfItem(item.itemId)),
            }),
          ).then(() => true),
        );
        if (done) this.store.clearDirty(item.itemId, item.version);
      } catch (error) {
        this.warn('Publishing an inbox item failed', error);
        return;
      }
    }
    for (const digest of this.store.unpublishedDigests()) {
      if (this.stopped) return;
      try {
        const done = await this.untilStopped(
          Promise.resolve(
            this.host.publish({ kind: 'inbox.digest', conversationId: null, data: digest.body }),
          ).then(() => true),
        );
        if (done) this.store.setDigestPublished(digest.digestId);
      } catch (error) {
        this.warn('Publishing a digest failed', error);
        return;
      }
    }
  }

  // ------------------------------------------------------------- digest

  private async digestPass(): Promise<void> {
    const at = this.now();
    const slot = dueDigestSlot(this.settings(), at);
    if (slot !== undefined) {
      const digestId = `dig_${randomUUID().replaceAll('-', '')}`;
      const claimed = this.store.tx(() => this.store.claimDigestSlot(digestId, slot, at));
      if (claimed) await this.completeDigest(digestId, at);
    }
    // A slot claimed by a process that stopped before it finished.
    for (const empty of this.store.emptySlots()) await this.completeDigest(empty.digestId, at);
  }

  private async completeDigest(digestId: string, at: number): Promise<void> {
    if (this.stopped) return;
    const digest = await this.compose(digestId, at);
    if (this.stopped) return;
    this.store.tx(() => this.store.setDigestBody(digestId, digest));
  }

  private async compose(digestId: string, at: number): Promise<Digest> {
    const since = this.store.lastDigestAt();
    return buildDigest({
      digestId,
      at,
      since,
      active: this.store.listItems({ states: ['open', 'answering'], afterN: 0, limit: 500 }),
      recent: this.store.itemsClosedSince(since).concat(this.store.itemsCreatedSince(since)),
      ...(this.options.summary ? { model: this.options.summary } : {}),
      timeoutMs: this.options.summaryTimeoutMs ?? 20_000,
      signal: this.abort.signal,
      onWarning: (message, detail) => this.warn(message, detail),
    });
  }

  /** Builds a digest now, for a request. It is stored and published like a scheduled one. */
  async digest(): Promise<Digest> {
    return this.track(
      (async () => {
        this.catchUp();
        const at = this.now();
        const digestId = `dig_${randomUUID().replaceAll('-', '')}`;
        const digest = await this.compose(digestId, at);
        this.store.tx(() => this.store.insertDigest(digestId, digest, at));
        await this.publishDirty();
        return digest;
      })(),
    );
  }

  // -------------------------------------------------------------- reads

  /** Items in creation order after `afterN`; `state` picks the open inbox (default) or history. */
  listItems(
    query: {
      state?: 'open' | 'closed' | 'all';
      after?: number;
      limit?: number;
      /** When given, only items of these conversations. */
      conversations?: readonly string[];
    } = {},
  ): {
    items: Array<ItemView & { n: number }>;
    next: number | null;
  } {
    this.catchUp();
    const states =
      query.state === 'closed'
        ? (['closed'] as const)
        : query.state === 'all'
          ? (['open', 'answering', 'closed'] as const)
          : (['open', 'answering'] as const);
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const rows = this.store.listItems({
      states: [...states],
      afterN: query.after ?? 0,
      limit,
      ...(query.conversations === undefined ? {} : { conversations: query.conversations }),
    });
    return {
      items: rows.map((row) => ({ ...toView(row, this.store.answerOfItem(row.itemId)), n: row.n })),
      next: rows.length === limit ? (rows.at(-1)?.n ?? null) : null,
    };
  }

  /**
   * Raises a budget item for a spending limit that stopped work, which stays until the human
   * acknowledges it. One open item per `key`: more hits on the same limit change nothing. Durable
   * when this returns; the push and the stream follow from the supervisor's own pass.
   */
  raiseCapHit(input: { conversationId: string; taskId?: string; key: string; ask: string }): void {
    if (this.stopped) return;
    this.store.tx(() =>
      openItem(
        this.store,
        capSpec(this.store, { ...input, taskId: input.taskId ?? null }),
        this.now(),
      ),
    );
    this.kick();
  }

  getItem(itemId: string): ItemView | undefined {
    const item = this.store.item(itemId);
    return item ? toView(item, this.store.answerOfItem(itemId)) : undefined;
  }

  /** What the model checks have charged today (in the configured time zone), reservations included. */
  verifierSpentToday(): number {
    const day = localParts(this.settings().timeZone, this.now()).date;
    return this.store.spentOn(day);
  }

  // ----------------------------------------------------------- settings

  getSettings(): Settings {
    return this.settings();
  }

  setSettings(patch: SettingsPatch): Settings {
    const parsed = SettingsPatchSchema.parse(patch);
    return this.store.tx(() => {
      const next = { ...this.settings(), ...parsed };
      this.store.putSettings(SettingsSchema.parse(next));
      return this.settings();
    });
  }

  /** Mutes or unmutes a kind's pushes. The inbox and the digest keep listing it. */
  setMute(kind: ItemKind, muted: boolean): Settings {
    if (!ITEM_KINDS.includes(kind)) throw new Error(`Unknown kind ${kind}`);
    const current = this.settings().mutedKinds.filter((candidate) => candidate !== kind);
    return this.setSettings({ mutedKinds: muted ? [...current, kind] : current });
  }

  // ------------------------------------------------------------ answers

  /**
   * Applies the human's answer once, to the state they saw. The feed is caught
   * up first, then check and claim are one synchronous transaction; delivery
   * to the conversation follows, keyed by the answer id so a retry or a crash
   * between delivery and close cannot act twice.
   */
  async answer(request: AnswerRequest): Promise<AnswerResult> {
    if (this.stopped) return { ok: false, reason: 'stopped' };
    if (!ANSWER_ID.test(request.answerId)) return { ok: false, reason: 'invalid_request' };
    const claim = this.claim(request);
    if (!claim.ok) return claim.result;
    if (claim.duplicate || claim.local) {
      if (!claim.duplicate) this.verifier?.pass();
      return this.reply(claim.item.itemId, claim.duplicate);
    }
    const answer = claim.answer as AnswerRecord;
    await this.track(this.attemptDelivery(answer.answerId));
    return this.reply(claim.item.itemId, false);
  }

  private reply(itemId: string, duplicate: boolean): AnswerResult {
    const item = this.store.item(itemId) as ItemRecord;
    return { ok: true, duplicate, item: toView(item, this.store.answerOfItem(itemId)) };
  }

  private claim(request: AnswerRequest): Claim {
    const text = request.text === '' ? undefined : request.text;
    this.catchUp();
    return this.store.tx((): Claim => {
      const at = this.now();
      const fail = (
        reason: Extract<AnswerResult, { ok: false }>['reason'],
        item?: ItemRecord,
      ): Claim => ({
        ok: false,
        result: {
          ok: false,
          reason,
          ...(item ? { item: toView(item, this.store.answerOfItem(item.itemId)) } : {}),
        },
      });
      let item = this.store.item(request.itemId);
      if (!item) return fail('not_found');
      // Another caller's item is not found, and nothing about it is shown.
      if (request.conversations && !request.conversations.includes(item.conversationId)) {
        return fail('not_found');
      }
      const earlier = this.store.answerOfItem(item.itemId);
      if (earlier) {
        const same =
          earlier.answerId === request.answerId &&
          earlier.optionId === request.optionId &&
          earlier.text === (text ?? null);
        return same
          ? { ok: true, item, answer: earlier, duplicate: true, local: false }
          : fail('already_answered', item);
      }
      if (item.state === 'closed') return fail('closed', item);
      const option = item.options.find((candidate) => candidate.id === request.optionId);
      if (!option) return fail('invalid_option', item);
      if (text !== undefined && !item.allowText) return fail('text_not_allowed', item);
      if (text !== undefined && text.length > MAX_ANSWER_TEXT) return fail('text_too_long', item);

      // The answer applies to the state the human saw, and that state must still be true.
      const verdict: Reassessment = reassess(this.store, item, at);
      if (verdict.action === 'close') {
        this.store.closeItem(item.itemId, verdict.reason, at);
      } else if (verdict.action === 'refresh') {
        this.store.refreshItem(item.itemId, verdict.spec, at);
      }
      item = this.store.item(item.itemId) as ItemRecord;
      if (verdict.action !== 'keep' || item.precondition !== request.preconditionHash) {
        return fail('stale', item);
      }
      // A user message dismisses the conductor's open question, so one is never posted over it.
      if (option.effect === 'message' && this.store.openQuestions(item.conversationId).length > 0) {
        return fail('question_open', item);
      }

      this.store.insertAnswer({
        answerId: request.answerId,
        itemId: item.itemId,
        optionId: option.id,
        text: text ?? null,
        delivery: option.effect === 'local' ? 'closed_without_delivery' : 'pending',
        caller: request.caller ?? null,
        at,
      });
      if (option.effect === 'local') {
        if (option.localAction === 'recheck') this.store.requeueVerification(item.taskId ?? '', at);
        this.store.closeItem(item.itemId, option.closeReason ?? 'acknowledged', at);
        return {
          ok: true,
          item: this.store.item(item.itemId) as ItemRecord,
          duplicate: false,
          local: true,
        };
      }
      this.store.setItemState(item.itemId, 'answering', at);
      return {
        ok: true,
        item: this.store.item(item.itemId) as ItemRecord,
        answer: this.store.answer(request.answerId) as AnswerRecord,
        duplicate: false,
        local: false,
      };
    });
  }

  /** One delivery attempt. Only one runs per answer at a time; a failed one is retried by the tick. */
  private async attemptDelivery(answerId: string): Promise<void> {
    const started = this.store.tx(() => {
      if (!this.store.beginAttempt(answerId)) return undefined;
      const answer = this.store.answer(answerId) as AnswerRecord;
      const item = this.store.item(answer.itemId) as ItemRecord;
      return { answer, item };
    });
    if (!started) return;
    const { answer, item } = started;
    const option = item.options.find((candidate) => candidate.id === answer.optionId) as ItemOption;
    try {
      if (option.effect === 'answer_question') {
        const outcome = await this.host.answers.deliver(
          {
            conversationId: item.conversationId,
            questionId: item.context.questionId ?? '',
            optionId: option.id,
            ...(answer.text === null ? {} : { text: answer.text }),
            ...(answer.caller === null ? {} : { caller: answer.caller }),
          },
          this.abort.signal,
        );
        this.store.tx(() => {
          const at = this.now();
          if (outcome.accepted) {
            this.store.finishAnswer(answerId, 'delivered', at);
            this.store.closeItem(item.itemId, 'answered', at);
            return;
          }
          this.store.finishAnswer(answerId, 'closed_without_delivery', at);
          this.store.logAnswer(answerId, `refused:${outcome.reason}`, at);
          // Someone answered differently, or the question is no longer open: nothing was applied here.
          this.store.closeItem(
            item.itemId,
            outcome.reason === 'conflict' ? 'handled_elsewhere' : 'condition_cleared',
            at,
          );
        });
        return;
      }
      const posted = await this.host.messages.post(
        {
          conversationId: item.conversationId,
          ...(answer.caller === null ? {} : { caller: answer.caller }),
          text: buildMessage(
            option.messageKey ?? '',
            {
              ...(item.context.taskId === undefined ? {} : { taskId: item.context.taskId }),
              ...(item.context.taskTitle === undefined
                ? {}
                : { taskTitle: item.context.taskTitle }),
              ...(item.context.detail === undefined ? {} : { detail: item.context.detail }),
              ...(item.context.count === undefined ? {} : { count: item.context.count }),
              ...(item.context.idleMinutes === undefined
                ? {}
                : { idleMinutes: item.context.idleMinutes }),
            },
            answer.text ?? undefined,
          ),
          clientMessageId: `inbox-${answerId}`,
        },
        this.abort.signal,
      );
      this.store.tx(() => {
        const at = this.now();
        if ('refused' in posted) {
          // The host no longer takes this caller's word: nothing was posted.
          this.store.finishAnswer(answerId, 'closed_without_delivery', at);
          this.store.logAnswer(answerId, `refused:${posted.refused}`, at);
          this.store.closeItem(item.itemId, 'condition_cleared', at);
          return;
        }
        this.store.finishAnswer(answerId, 'delivered', at);
        this.store.closeItem(item.itemId, 'answered', at);
      });
    } catch (error) {
      if (!this.stopped) this.warn('Delivering an inbox answer failed; it will be retried', error);
      if (this.store.db.isOpen) {
        const attempts = this.store.answer(answerId)?.attempts ?? 1;
        const backoff = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(attempts, 12));
        this.store.tx(() => {
          this.store.endAttempt(answerId, this.now() + backoff);
          this.store.logAnswer(answerId, 'attempt_failed', this.now());
        });
      }
    }
  }

  private async retryAnswers(): Promise<void> {
    for (const due of this.store.dueAnswers(this.now())) {
      if (this.stopped) return;
      await this.attemptDelivery(due.answerId);
    }
  }
}

function interruptItem(item: ItemRecord): Interrupt['items'][number] {
  return {
    itemId: item.itemId,
    conversationId: item.conversationId,
    kind: item.kind,
    ask: item.ask,
  };
}
