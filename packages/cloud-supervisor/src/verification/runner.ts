import { settleVerification } from '../rules.js';
import { localParts, type Settings } from '../settings.js';
import type { Store, VerificationRecord } from '../store.js';
import { type SpendGate, runCheck } from './engine.js';
import { verificationKindOf } from './kind.js';
import type { Outcome, VerificationOptions } from './ports.js';

const DEFAULTS = { concurrency: 2, deadlineMs: 300_000, maxAttempts: 3, backoffMs: 60_000 };

export interface RunnerDeps {
  store: Store;
  options: VerificationOptions;
  now: () => number;
  settings: () => Settings;
  /** Aborted when the supervisor stops. */
  signal: AbortSignal;
  isStopped: () => boolean;
  /** Keeps the supervisor's own bookkeeping (pushes, outbox) current after a verification ended. */
  afterSettled: () => Promise<void>;
  /** Registers background work so `settled()` and `stop()` can wait for it. */
  track: <T>(work: Promise<T>) => Promise<T>;
  warn: (message: string, detail?: unknown) => void;
}

/**
 * Runs the independent checks of finished tasks. A verification is claimed in
 * the feed transaction that saw the task finish (one per task), started here
 * under a concurrency cap, and ended in one transaction that records the
 * outcome and raises the item. The slot, the deadline timer and the abort
 * handle are released on every exit: done, deadline, stop, throw.
 */
export class VerificationRunner {
  private readonly active = new Map<string, AbortController>();
  private recovered = false;

  constructor(private readonly deps: RunnerDeps) {}

  /** Verifications running now. */
  get running(): number {
    return this.active.size;
  }

  private get concurrency(): number {
    return this.deps.options.concurrency ?? DEFAULTS.concurrency;
  }

  // ------------------------------------------------------------- spend

  private dayOf(at: number): string {
    return localParts(this.deps.settings().timeZone, at).date;
  }

  private readonly gate: SpendGate = {
    reserve: (key, usd, conversationId, taskId) => {
      const { store, options } = this.deps;
      const at = this.deps.now();
      const day = this.dayOf(at);
      const cap = this.deps.settings().verifierDailyCapUsd;
      if (!store.tx(() => store.reserveVerifierSpend(key, day, usd, cap, at))) return 'daily_cap';
      let accepted: boolean;
      try {
        accepted = options.budget.reserve({ key, conversationId, taskId, maxUsd: usd }).ok;
      } catch (error) {
        store.tx(() => store.recordSpend(key, day, 'release', 0, this.deps.now()));
        throw error;
      }
      if (!accepted) {
        store.tx(() => store.recordSpend(key, day, 'release', 0, this.deps.now()));
        return 'conversation_budget';
      }
      store.tx(() => store.recordSpend(key, day, 'armed', usd, this.deps.now()));
      return undefined;
    },
    settle: (key, usd) => {
      const { store, options } = this.deps;
      const held = store.spendOf(key);
      if (!held || held.stage === 'settle' || held.stage === 'release') return;
      try {
        options.budget.settle(key, usd);
      } catch (error) {
        this.deps.warn('Settling a verification charge failed; the reservation stands', error);
        return;
      }
      store.tx(() => store.recordSpend(key, held.day, 'settle', usd, this.deps.now()));
    },
  };

  /**
   * A process that stopped between reserving and settling left an open
   * reservation. One that was never armed made no model request: it is
   * released. An armed one may have: it is charged at its reserved bound.
   */
  private recoverSpend(): void {
    const { store, options } = this.deps;
    for (const open of store.openSpends()) {
      try {
        if (open.stage === 'reserve') {
          options.budget.settle(open.key, 0);
          store.tx(() => store.recordSpend(open.key, open.day, 'release', 0, this.deps.now()));
        } else {
          options.budget.settle(open.key, open.usd);
          store.tx(() =>
            store.recordSpend(open.key, open.day, 'settle', open.usd, this.deps.now()),
          );
        }
      } catch (error) {
        this.deps.warn('Recovering a verification charge failed; it stays reserved', error);
      }
    }
  }

  // -------------------------------------------------------------- loop

  /** Starts what is due, up to the concurrency cap. Does not wait for it. */
  pass(): void {
    const { store } = this.deps;
    if (this.deps.isStopped()) return;
    if (!this.recovered) {
      this.recovered = true;
      this.recoverSpend();
    }
    const due = store.tx(() =>
      store.claimDueVerifications(this.deps.now(), this.concurrency - this.active.size),
    );
    for (const row of due) {
      const controller = new AbortController();
      this.active.set(row.verificationId, controller);
      void this.deps.track(this.runOne(row, controller));
    }
  }

  private async runOne(row: VerificationRecord, controller: AbortController): Promise<void> {
    const { store, options } = this.deps;
    const timer = setTimeout(
      () => controller.abort(new Error('deadline')),
      options.deadlineMs ?? DEFAULTS.deadlineMs,
    );
    let outcome: Outcome;
    try {
      const task = store.task(row.taskId);
      const manifest = task?.manifest;
      const kind = manifest ? verificationKindOf(manifest) : undefined;
      if (!task || !manifest || kind === undefined) {
        outcome = {
          state: 'could_not_check',
          code: 'unavailable',
          reason: 'the task record is incomplete',
          transient: false,
        };
      } else {
        outcome = await runCheck({
          task: { taskId: task.taskId, conversationId: task.conversationId, runner: task.runner },
          manifest,
          kind,
          attemptKey: `${row.verificationId}:${row.epoch}:${row.attempt}`,
          options,
          spend: this.gate,
          signal: AbortSignal.any([this.deps.signal, controller.signal]),
        });
      }
    } catch (error) {
      if (!this.deps.isStopped()) this.deps.warn('A verification failed unexpectedly', error);
      outcome = {
        state: 'could_not_check',
        code: 'unavailable',
        reason: 'the check failed unexpectedly',
        transient: true,
      };
    } finally {
      clearTimeout(timer);
      this.active.delete(row.verificationId);
    }
    // Stopped: the row stays running and is queued again at the next start.
    if (this.deps.isStopped()) return;
    if (outcome.state === 'could_not_check' && outcome.code === 'aborted') {
      outcome = {
        ...outcome,
        code: 'unavailable',
        reason: 'the check took too long',
        transient: true,
      };
    }
    this.finish(row, outcome);
    await this.deps.afterSettled();
  }

  private finish(row: VerificationRecord, outcome: Outcome): void {
    const { store, options } = this.deps;
    const maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts;
    const backoffMs = options.backoffMs ?? DEFAULTS.backoffMs;
    store.tx(() => {
      const at = this.deps.now();
      const current = store.verification(row.taskId);
      // A person re-queued it, or it was settled by another path, while this ran.
      if (
        !current ||
        current.state !== 'running' ||
        current.epoch !== row.epoch ||
        current.attempt !== row.attempt
      )
        return;
      if (outcome.state === 'passed') return settleVerification(store, current, outcome, at);
      if (outcome.state === 'failed') return settleVerification(store, current, outcome, at);
      if (outcome.transient && row.attempt < maxAttempts) {
        return settleVerification(
          store,
          current,
          {
            state: 'retry',
            reason: outcome.reason,
            nextAttemptAt: at + backoffMs * 2 ** (row.attempt - 1),
          },
          at,
        );
      }
      settleVerification(store, current, outcome, at);
    });
  }
}
