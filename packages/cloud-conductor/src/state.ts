import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { OutboxKind } from './outbox.js';

/**
 * The conductor's own state in one SQLite file. Every method is synchronous,
 * so a check and the write it guards run in one transaction with no await in
 * between (the budget reservation, question and approval rules depend on it).
 */

/**
 * `delivering`: the run ended with a final message that the outbox has not
 * acked yet; it becomes `done` when it is.
 */
export type RunState =
  | 'active'
  | 'waiting'
  | 'delivering'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'interrupted';
export const OPEN_RUN_STATES: readonly RunState[] = ['active', 'waiting'];

export interface RunRow {
  runId: string;
  conversationId: string;
  state: RunState;
  playbook: string | null;
  budgetUsd: number;
  createdAt: number;
  endedAt: number | null;
  endReason: string | null;
}

export type SessionKind = 'conductor' | 'planner';

export interface SessionRow {
  makaSessionId: string;
  kind: SessionKind;
  systemPrompt: string;
  runId: string | null;
}

export type QuestionReason = 'taste' | 'budget_overrun' | 'irreversible';

export interface QuestionOption {
  id: string;
  label: string;
}

export interface QuestionRow {
  questionId: string;
  runId: string;
  conversationId: string;
  reason: QuestionReason;
  question: string;
  options: QuestionOption[];
  recommended: string;
  /** budget_overrun: the budget the "raise" option sets. irreversible: the held action. */
  raiseToUsd: number | null;
  actionRef: string | null;
  /** irreversible: the held call, as it will run. The question text is built from it by code. */
  action: HeldCall | null;
  /** The model's own words, shown under the code-built question. */
  note: string | null;
  state: 'open' | 'answered' | 'dismissed' | 'closed';
  answer: string | null;
}

export interface HeldCall {
  tool: string;
  args: Record<string, unknown>;
}

export type HeldState = 'held' | 'approved' | 'rejected' | 'used' | 'expired';

export interface BudgetView {
  budgetUsd: number;
  spentUsd: number;
  reservedUsd: number;
  modelUsd: number;
  /** Settled spend charged by callers outside the conductor (the supervisor's verification). */
  externalUsd: number;
  /** What delegated tasks really spent, settled when each one ended. */
  taskUsd: number;
  remainingUsd: number;
  /**
   * Why spend is blocked, if it is: something spent more than was reserved for
   * it. Nothing more is spent until the user answers a budget question.
   */
  blockedReason: string | null;
}

/** A reservation by a caller outside the conductor, keyed by the caller's idempotency key. */
export interface ExternalCharge {
  key: string;
  runId: string;
  conversationId: string;
  taskId: string | null;
  maxUsd: number;
  state: 'reserved' | 'settled';
  actualUsd: number | null;
}

export type ExternalReserveResult =
  | { ok: true; charge: ExternalCharge; duplicate: boolean }
  /** `budget`: the run's budget cannot cover maxUsd. The caller treats it as a budget refusal. */
  | { ok: false; reason: 'budget'; budget: BudgetView }
  | { ok: false; reason: 'no_run' | 'conflict' | 'invalid_amount' };

export type ExternalSettleResult =
  /** `overrunUsd`: how far the actual amount went past the reservation; above 0, spend is blocked. */
  | { ok: true; charge: ExternalCharge; duplicate: boolean; overrunUsd: number }
  | { ok: false; reason: 'not_found' | 'conflict' | 'invalid_amount' };

export type ReserveResult =
  | { ok: true; reservation: number }
  | { ok: false; reason: 'question_open' }
  | { ok: false; reason: 'over_budget'; budget: BudgetView };

/**
 * One delegate_task call. It is stored before the call is sent, under the
 * idempotency key the orchestrator gets, so a stop can cancel the task even
 * when the call's response never arrived.
 */
export interface DelegationRow {
  key: string;
  runId: string;
  conversationId: string;
  taskId: string | null;
  reservedUsd: number;
  /** pending: sent, no task id yet. bound: the task id is known. settled: charged, nothing left to stop. */
  state: 'pending' | 'bound' | 'settled';
  actualUsd: number | null;
  /** A cancel was asked for and has not succeeded yet; retried on start and when access returns. */
  cancelPending: boolean;
}

export interface SettleResult {
  /** False when it was settled already. */
  settled: boolean;
  overrunUsd: number;
}

export interface OutboxRow {
  eventId: string;
  conversationId: string;
  kind: OutboxKind;
  payload: Record<string, unknown>;
  attempts: number;
}

export type AdmitResult =
  | { duplicate: true }
  | { duplicate: false; run: RunRow; newRun: boolean; dismissedQuestion: string | null };

export type AnswerResult =
  | { accepted: false; reason: 'not_found' | 'not_open' | 'unknown_option' | 'conflict' }
  | {
      accepted: true;
      duplicate: boolean;
      question: QuestionRow;
      option: QuestionOption;
      run: RunRow;
    };

export type OpenQuestionResult =
  | { ok: true; question: QuestionRow }
  | { ok: false; code: string; message: string };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  conversation_id TEXT PRIMARY KEY,
  maka_session_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS maka_sessions (
  maka_session_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  run_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  n INTEGER NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL,
  state TEXT NOT NULL,
  playbook TEXT,
  budget_usd REAL NOT NULL,
  notices INTEGER NOT NULL DEFAULT 0,
  blocked_reason TEXT,
  created_at INTEGER NOT NULL,
  ended_at INTEGER,
  end_reason TEXT
);
CREATE INDEX IF NOT EXISTS runs_by_conversation ON runs (conversation_id, n);
CREATE TABLE IF NOT EXISTS inputs (
  input_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger (
  n INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  usd REAL NOT NULL,
  ref TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_by_run ON ledger (run_id);
CREATE UNIQUE INDEX IF NOT EXISTS ledger_model_once ON ledger (ref) WHERE kind = 'model';
CREATE TRIGGER IF NOT EXISTS ledger_no_update BEFORE UPDATE ON ledger
  BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_no_delete BEFORE DELETE ON ledger
  BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
CREATE TABLE IF NOT EXISTS external_charges (
  key TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  task_id TEXT,
  max_usd REAL NOT NULL,
  reservation INTEGER NOT NULL,
  actual_usd REAL
);
CREATE TABLE IF NOT EXISTS delegations (
  key TEXT PRIMARY KEY,
  task_id TEXT UNIQUE,
  run_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  reservation INTEGER NOT NULL,
  state TEXT NOT NULL,
  actual_usd REAL,
  cancel_pending INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS delegations_by_run ON delegations (run_id);
CREATE TABLE IF NOT EXISTS outbox (
  n INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  completes_run TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  acked_at INTEGER
);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox (conversation_id, n) WHERE acked_at IS NULL;
CREATE TABLE IF NOT EXISTS questions (
  question_id TEXT PRIMARY KEY,
  n INTEGER NOT NULL UNIQUE,
  run_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  question TEXT NOT NULL,
  options TEXT NOT NULL,
  recommended TEXT NOT NULL,
  raise_to_usd REAL,
  action_ref TEXT,
  action TEXT,
  note TEXT,
  state TEXT NOT NULL,
  answer TEXT,
  created_at INTEGER NOT NULL,
  closed_at INTEGER
);
CREATE TABLE IF NOT EXISTS held_actions (
  action_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  args TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

type Row = Record<string, unknown>;

export class ConductorState {
  readonly db: DatabaseSync;
  private depth = 0;

  constructor(
    path: string,
    private readonly now: () => number = Date.now,
  ) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  /** Runs `fn` in one transaction; a call inside another transaction joins it. */
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.depth += 1;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.depth -= 1;
    }
  }

  // Conversations and Maka sessions

  conversationSession(conversationId: string): string | undefined {
    const row = this.db
      .prepare('SELECT maka_session_id FROM conversations WHERE conversation_id = ?')
      .get(conversationId) as Row | undefined;
    return row ? String(row.maka_session_id) : undefined;
  }

  bindConversation(conversationId: string, makaSessionId: string): void {
    this.db
      .prepare(
        'INSERT INTO conversations (conversation_id, maka_session_id, created_at) VALUES (?, ?, ?)',
      )
      .run(conversationId, makaSessionId, this.now());
  }

  registerSession(row: SessionRow): void {
    this.db
      .prepare(
        'INSERT INTO maka_sessions (maka_session_id, kind, system_prompt, run_id, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(row.makaSessionId, row.kind, row.systemPrompt, row.runId, this.now());
  }

  session(makaSessionId: string): SessionRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM maka_sessions WHERE maka_session_id = ?')
      .get(makaSessionId) as Row | undefined;
    if (!row) return undefined;
    return {
      makaSessionId: String(row.maka_session_id),
      kind: row.kind as SessionKind,
      systemPrompt: String(row.system_prompt),
      runId: row.run_id === null ? null : String(row.run_id),
    };
  }

  // Runs and inputs

  run(runId: string): RunRow | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId) as
      | Row
      | undefined;
    return row ? toRun(row) : undefined;
  }

  /** The conversation's run that is still active or waiting for an answer, if any. */
  openRun(conversationId: string): RunRow | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM runs WHERE conversation_id = ? AND state IN ('active', 'waiting') ORDER BY n DESC LIMIT 1",
      )
      .get(conversationId) as Row | undefined;
    return row ? toRun(row) : undefined;
  }

  runsInState(state: RunState): RunRow[] {
    return (
      this.db.prepare('SELECT * FROM runs WHERE state = ? ORDER BY n').all(state) as Row[]
    ).map(toRun);
  }

  /**
   * Admits a user message once. It joins the conversation's open run (a
   * message sent instead of answering dismisses the open question) or starts
   * a new run with the default budget.
   */
  admitMessage(conversationId: string, messageId: string, budgetUsd: number): AdmitResult {
    return this.transaction((): AdmitResult => {
      if (this.db.prepare('SELECT 1 FROM inputs WHERE input_id = ?').get(messageId)) {
        return { duplicate: true };
      }
      let run = this.openRun(conversationId);
      let newRun = false;
      let dismissedQuestion: string | null = null;
      if (run) {
        dismissedQuestion = this.dismissQuestion(run.runId);
        this.setRunState(run.runId, 'active');
        run = { ...run, state: 'active' };
      } else {
        run = this.createRun(conversationId, budgetUsd);
        newRun = true;
      }
      this.db
        .prepare(
          "INSERT INTO inputs (input_id, conversation_id, run_id, kind, at) VALUES (?, ?, ?, 'message', ?)",
        )
        .run(messageId, conversationId, run.runId, this.now());
      return { duplicate: false, run, newRun, dismissedQuestion };
    });
  }

  private createRun(conversationId: string, budgetUsd: number): RunRow {
    const runId = `run_${randomUUID().replaceAll('-', '')}`;
    const n = (this.db.prepare('SELECT COALESCE(MAX(n), 0) + 1 AS n FROM runs').get() as Row).n;
    const createdAt = this.now();
    this.db
      .prepare(
        "INSERT INTO runs (run_id, n, conversation_id, state, budget_usd, created_at) VALUES (?, ?, ?, 'active', ?, ?)",
      )
      .run(runId, n as number, conversationId, budgetUsd, createdAt);
    return {
      runId,
      conversationId,
      state: 'active',
      playbook: null,
      budgetUsd,
      createdAt,
      endedAt: null,
      endReason: null,
    };
  }

  setRunState(runId: string, state: 'active' | 'waiting'): void {
    this.db
      .prepare("UPDATE runs SET state = ? WHERE run_id = ? AND state IN ('active', 'waiting')")
      .run(state, runId);
  }

  /**
   * Ends a run that is still open; an ended run keeps its first outcome.
   * Open questions close and held actions expire with it. A notice for the
   * user goes into the outbox in the same transaction. Returns whether this
   * call ended it.
   */
  endRun(
    runId: string,
    state: Exclude<RunState, 'active' | 'waiting' | 'delivering'>,
    reason: string,
    notice?: string,
  ): boolean {
    return this.transaction(() => {
      if (!this.closeRun(runId, state, reason)) return false;
      if (notice !== undefined) this.enqueueNotice(this.run(runId) as RunRow, notice);
      return true;
    });
  }

  /**
   * Ends an open run with its final message. The run is `delivering` until the
   * outbox acks the message, and only then `done` (see ackOutbox).
   */
  deliverRun(runId: string, text: string): boolean {
    return this.transaction(() => {
      if (!this.closeRun(runId, 'delivering', null)) return false;
      const run = this.run(runId) as RunRow;
      this.enqueueOutbox(
        'message',
        run.conversationId,
        { conversationId: run.conversationId, runId, text },
        runId,
      );
      return true;
    });
  }

  private closeRun(runId: string, state: RunState, reason: string | null): boolean {
    const changed = this.db
      .prepare(
        "UPDATE runs SET state = ?, ended_at = ?, end_reason = ? WHERE run_id = ? AND state IN ('active', 'waiting')",
      )
      .run(state, this.now(), reason, runId).changes;
    if (Number(changed) === 0) return false;
    this.db
      .prepare(
        "UPDATE questions SET state = 'closed', closed_at = ? WHERE run_id = ? AND state = 'open'",
      )
      .run(this.now(), runId);
    this.expireHeld(runId);
    return true;
  }

  /** Sets the run's playbook once. */
  setPlaybook(runId: string, playbook: string): boolean {
    const changed = this.db
      .prepare('UPDATE runs SET playbook = ? WHERE run_id = ? AND playbook IS NULL')
      .run(playbook, runId).changes;
    return Number(changed) === 1;
  }

  /** Counts a notice against the run's cap; false once the cap is reached. */
  takeNotice(runId: string, cap: number): boolean {
    const changed = this.db
      .prepare('UPDATE runs SET notices = notices + 1 WHERE run_id = ? AND notices < ?')
      .run(runId, cap).changes;
    return Number(changed) === 1;
  }

  // Budget

  budget(runId: string): BudgetView {
    const run = this.run(runId);
    if (!run) throw new Error(`Unknown run ${runId}`);
    const sums = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN kind = 'model' THEN usd END), 0) AS model,
           COALESCE(SUM(CASE WHEN kind = 'reserve' THEN usd END), 0) AS reserved,
           COALESCE(SUM(CASE WHEN kind = 'release' THEN usd END), 0) AS released,
           COALESCE(SUM(CASE WHEN kind = 'raise' THEN usd END), 0) AS raised,
           COALESCE(SUM(CASE WHEN kind = 'external' THEN usd END), 0) AS external,
           COALESCE(SUM(CASE WHEN kind = 'task' THEN usd END), 0) AS task
         FROM ledger WHERE run_id = ?`,
      )
      .get(runId) as {
      model: number;
      reserved: number;
      released: number;
      raised: number;
      external: number;
      task: number;
    };
    const reservedUsd = roundUsd(sums.reserved - sums.released);
    const spentUsd = sums.model + sums.external + sums.task + reservedUsd;
    const budgetUsd = run.budgetUsd + sums.raised;
    return {
      budgetUsd,
      spentUsd,
      reservedUsd,
      modelUsd: sums.model,
      externalUsd: sums.external,
      taskUsd: sums.task,
      remainingUsd: budgetUsd - spentUsd,
      blockedReason: this.blockedReason(runId),
    };
  }

  private blockedReason(runId: string): string | null {
    const row = this.db.prepare('SELECT blocked_reason FROM runs WHERE run_id = ?').get(runId) as
      | Row
      | undefined;
    return row?.blocked_reason == null ? null : String(row.blocked_reason);
  }

  /**
   * Charges `actualUsd` for a reservation, in full even above it: the ledger
   * is never truncated. Above the reservation the run's spend is blocked until
   * the user answers a budget question. Runs inside the caller's transaction.
   */
  private settleReservation(
    runId: string,
    reservation: number,
    kind: 'task' | 'external',
    actualUsd: number,
    ref: string,
    what: string,
  ): number {
    const row = this.db
      .prepare("SELECT usd FROM ledger WHERE n = ? AND run_id = ? AND kind = 'reserve'")
      .get(reservation, runId) as { usd: number } | undefined;
    if (!row) throw new Error(`Unknown reservation ${reservation}`);
    this.appendLedger(runId, 'release', row.usd, String(reservation));
    if (actualUsd > 0) this.appendLedger(runId, kind, actualUsd, ref);
    const overrunUsd = roundUsd(actualUsd - row.usd);
    if (overrunUsd <= 0) return 0;
    this.appendLedger(runId, 'overrun', overrunUsd, ref);
    this.db
      .prepare('UPDATE runs SET blocked_reason = ? WHERE run_id = ?')
      .run(
        `${what} spent ${money(actualUsd)}, more than the ${money(row.usd)} reserved for it.`,
        runId,
      );
    return overrunUsd;
  }

  /**
   * Reserves `usd` of the run's budget for a delegation. The check and the
   * reservation are one transaction: two delegations at the limit cannot both
   * pass.
   */
  tryReserve(runId: string, usd: number, ref: string): ReserveResult {
    return this.transaction((): ReserveResult => {
      if (this.openQuestion(runId)) return { ok: false, reason: 'question_open' };
      const budget = this.budget(runId);
      if (budget.blockedReason !== null || budget.spentUsd + usd > budget.budgetUsd + 1e-9) {
        return { ok: false, reason: 'over_budget', budget };
      }
      const reservation = this.appendLedger(runId, 'reserve', usd, ref);
      return { ok: true, reservation };
    });
  }

  /**
   * Reserves `usd` for a delegation and stores it under `key` before the call
   * is sent, in one transaction.
   */
  reserveDelegation(runId: string, usd: number, key: string): ReserveResult {
    return this.transaction((): ReserveResult => {
      const reserved = this.tryReserve(runId, usd, `delegate:${key}`);
      if (!reserved.ok) return reserved;
      const run = this.run(runId) as RunRow;
      this.db
        .prepare(
          "INSERT INTO delegations (key, run_id, conversation_id, reservation, state, created_at) VALUES (?, ?, ?, ?, 'pending', ?)",
        )
        .run(key, runId, run.conversationId, reserved.reservation, this.now());
      return reserved;
    });
  }

  /** The orchestrator answered with the task's id. */
  bindTask(key: string, taskId: string): void {
    this.db
      .prepare(
        "UPDATE delegations SET task_id = ?, state = 'bound' WHERE key = ? AND state = 'pending'",
      )
      .run(taskId, key);
  }

  /**
   * Charges a delegation what its task tree really spent, once. Called when
   * the task is seen ended, or with 0 when the orchestrator refused the call
   * or a cancel by key found that it was never created.
   */
  settleDelegation(key: string, actualUsd: number): SettleResult {
    return this.transaction((): SettleResult => {
      const delegation = this.delegation(key);
      if (!delegation || delegation.state === 'settled') return { settled: false, overrunUsd: 0 };
      const row = this.db
        .prepare('SELECT reservation FROM delegations WHERE key = ?')
        .get(key) as Row;
      const overrunUsd = this.settleReservation(
        delegation.runId,
        Number(row.reservation),
        'task',
        actualUsd,
        `task:${delegation.taskId ?? key}`,
        'A delegated task',
      );
      this.db
        .prepare(
          "UPDATE delegations SET state = 'settled', actual_usd = ?, cancel_pending = 0 WHERE key = ?",
        )
        .run(actualUsd, key);
      return { settled: true, overrunUsd };
    });
  }

  delegation(key: string): DelegationRow | undefined {
    const row = this.db
      .prepare(
        "SELECT d.*, l.usd AS reserved FROM delegations d JOIN ledger l ON l.n = d.reservation AND l.kind = 'reserve' WHERE d.key = ?",
      )
      .get(key) as Row | undefined;
    return row ? toDelegation(row) : undefined;
  }

  delegationOfTask(taskId: string): DelegationRow | undefined {
    const row = this.db.prepare('SELECT key FROM delegations WHERE task_id = ?').get(taskId) as
      | Row
      | undefined;
    return row ? this.delegation(String(row.key)) : undefined;
  }

  /** Delegations not settled yet, of one run or (without a run) of one conversation or all. */
  unsettledDelegations(filter: { runId?: string; conversationId?: string } = {}): DelegationRow[] {
    const where = ["d.state <> 'settled'"];
    const params: string[] = [];
    if (filter.runId !== undefined) {
      where.push('d.run_id = ?');
      params.push(filter.runId);
    }
    if (filter.conversationId !== undefined) {
      where.push('d.conversation_id = ?');
      params.push(filter.conversationId);
    }
    return (
      this.db
        .prepare(
          `SELECT d.*, l.usd AS reserved FROM delegations d JOIN ledger l ON l.n = d.reservation AND l.kind = 'reserve' WHERE ${where.join(' AND ')} ORDER BY d.created_at, d.rowid`,
        )
        .all(...params) as Row[]
    ).map(toDelegation);
  }

  /** Marks delegations whose tasks must be cancelled, before the cancel is tried. */
  markCancelPending(keys: readonly string[]): void {
    const mark = this.db.prepare(
      "UPDATE delegations SET cancel_pending = 1 WHERE key = ? AND state <> 'settled'",
    );
    for (const key of keys) mark.run(key);
  }

  /** Conversations with a cancel that has not succeeded yet. */
  conversationsWithPendingCancels(): string[] {
    return (
      this.db
        .prepare(
          "SELECT DISTINCT conversation_id FROM delegations WHERE cancel_pending = 1 AND state <> 'settled'",
        )
        .all() as Row[]
    ).map((row) => String(row.conversation_id));
  }

  hasPendingCancels(conversationId: string): boolean {
    return (
      this.db
        .prepare(
          "SELECT 1 FROM delegations WHERE conversation_id = ? AND cancel_pending = 1 AND state <> 'settled' LIMIT 1",
        )
        .get(conversationId) !== undefined
    );
  }

  /** Records one model call's spend once (`ref` is the call attempt id); returns the budget after it. */
  addModelSpend(runId: string, usd: number, ref: string): BudgetView {
    return this.transaction(() => {
      if (usd > 0) {
        this.db
          .prepare(
            "INSERT OR IGNORE INTO ledger (run_id, kind, usd, ref, at) VALUES (?, 'model', ?, ?, ?)",
          )
          .run(runId, usd, ref, this.now());
      }
      return this.budget(runId);
    });
  }

  /**
   * Reserves up to `maxUsd` of a conversation's budget for a caller outside the
   * conductor, idempotent by `key`. The run charged is the one that delegated
   * `taskId`, else the conversation's latest run; it may have ended already,
   * since a task can finish after its turn. The check and the reservation are
   * one transaction, shared with delegations, so neither can overdraw the other.
   */
  reserveExternal(
    key: string,
    conversationId: string,
    taskId: string | undefined,
    maxUsd: number,
  ): ExternalReserveResult {
    if (!Number.isFinite(maxUsd) || maxUsd < 0) return { ok: false, reason: 'invalid_amount' };
    return this.transaction((): ExternalReserveResult => {
      const existing = this.externalCharge(key);
      if (existing) {
        const same =
          existing.conversationId === conversationId &&
          existing.taskId === (taskId ?? null) &&
          existing.maxUsd === maxUsd;
        return same
          ? { ok: true, charge: existing, duplicate: true }
          : { ok: false, reason: 'conflict' };
      }
      const runId = this.chargedRun(conversationId, taskId);
      if (!runId) return { ok: false, reason: 'no_run' };
      const budget = this.budget(runId);
      if (budget.blockedReason !== null || budget.spentUsd + maxUsd > budget.budgetUsd + 1e-9)
        return { ok: false, reason: 'budget', budget };
      const reservation = this.appendLedger(runId, 'reserve', maxUsd, `external:${key}`);
      this.db
        .prepare(
          'INSERT INTO external_charges (key, run_id, conversation_id, task_id, max_usd, reservation) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(key, runId, conversationId, taskId ?? null, maxUsd, reservation);
      return { ok: true, charge: this.externalCharge(key) as ExternalCharge, duplicate: false };
    });
  }

  /**
   * Replaces an external reservation with what was actually spent, idempotent
   * by `key`. The actual amount is charged in full even above the reservation;
   * above it, the overrun is flagged and the run's spend is blocked until the
   * user answers a budget question.
   */
  settleExternal(key: string, actualUsd: number): ExternalSettleResult {
    if (!Number.isFinite(actualUsd) || actualUsd < 0)
      return { ok: false, reason: 'invalid_amount' };
    return this.transaction((): ExternalSettleResult => {
      const charge = this.externalCharge(key);
      if (!charge) return { ok: false, reason: 'not_found' };
      if (charge.state === 'settled') {
        return charge.actualUsd === actualUsd
          ? {
              ok: true,
              charge,
              duplicate: true,
              overrunUsd: roundUsd(Math.max(0, actualUsd - charge.maxUsd)),
            }
          : { ok: false, reason: 'conflict' };
      }
      const row = this.db
        .prepare('SELECT reservation FROM external_charges WHERE key = ?')
        .get(key) as Row;
      const overrunUsd = this.settleReservation(
        charge.runId,
        Number(row.reservation),
        'external',
        actualUsd,
        `external:${key}`,
        'Verification',
      );
      this.db
        .prepare('UPDATE external_charges SET actual_usd = ? WHERE key = ?')
        .run(actualUsd, key);
      return {
        ok: true,
        charge: this.externalCharge(key) as ExternalCharge,
        duplicate: false,
        overrunUsd,
      };
    });
  }

  externalCharge(key: string): ExternalCharge | undefined {
    const row = this.db.prepare('SELECT * FROM external_charges WHERE key = ?').get(key) as
      | Row
      | undefined;
    if (!row) return undefined;
    return {
      key: String(row.key),
      runId: String(row.run_id),
      conversationId: String(row.conversation_id),
      taskId: row.task_id === null ? null : String(row.task_id),
      maxUsd: Number(row.max_usd),
      state: row.actual_usd === null ? 'reserved' : 'settled',
      actualUsd: row.actual_usd === null ? null : Number(row.actual_usd),
    };
  }

  private chargedRun(conversationId: string, taskId: string | undefined): string | undefined {
    if (taskId !== undefined) {
      const row = this.db
        .prepare(
          'SELECT r.run_id FROM delegations t JOIN runs r ON r.run_id = t.run_id WHERE t.task_id = ? AND r.conversation_id = ?',
        )
        .get(taskId, conversationId) as Row | undefined;
      if (row) return String(row.run_id);
    }
    const latest = this.db
      .prepare('SELECT run_id FROM runs WHERE conversation_id = ? ORDER BY n DESC LIMIT 1')
      .get(conversationId) as Row | undefined;
    return latest ? String(latest.run_id) : undefined;
  }

  /** Ids of the tasks the run delegated, in order. */
  tasksOf(runId: string): string[] {
    return (
      this.db
        .prepare(
          'SELECT task_id FROM delegations WHERE run_id = ? AND task_id IS NOT NULL ORDER BY created_at, rowid',
        )
        .all(runId) as Row[]
    ).map((row) => String(row.task_id));
  }

  private appendLedger(runId: string, kind: string, usd: number, ref: string | null): number {
    const result = this.db
      .prepare('INSERT INTO ledger (run_id, kind, usd, ref, at) VALUES (?, ?, ?, ?, ?)')
      .run(runId, kind, usd, ref, this.now());
    return Number(result.lastInsertRowid);
  }

  // Questions

  openQuestion(runId: string): QuestionRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM questions WHERE run_id = ? AND state = 'open'")
      .get(runId) as Row | undefined;
    return row ? toQuestion(row) : undefined;
  }

  question(questionId: string): QuestionRow | undefined {
    const row = this.db.prepare('SELECT * FROM questions WHERE question_id = ?').get(questionId) as
      | Row
      | undefined;
    return row ? toQuestion(row) : undefined;
  }

  /**
   * Opens a question if the run allows one now: one open question at a time,
   * and the per-reason rules checked in `check`, all in one transaction.
   */
  openQuestionIf(
    runId: string,
    draft: Omit<
      QuestionRow,
      'questionId' | 'runId' | 'conversationId' | 'state' | 'answer' | 'action' | 'note'
    > &
      Partial<Pick<QuestionRow, 'action' | 'note'>>,
    check: () => { code: string; message: string } | undefined,
  ): OpenQuestionResult {
    return this.transaction((): OpenQuestionResult => {
      const run = this.run(runId);
      if (!run || !OPEN_RUN_STATES.includes(run.state)) {
        return { ok: false, code: 'run_ended', message: 'The run has ended.' };
      }
      if (this.openQuestion(runId)) {
        return {
          ok: false,
          code: 'question_open',
          message: 'A question is already waiting for the user. End your turn now.',
        };
      }
      const refused = check();
      if (refused) return { ok: false, ...refused };
      const questionId = `q_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
      const n = (this.db.prepare('SELECT COALESCE(MAX(n), 0) + 1 AS n FROM questions').get() as Row)
        .n as number;
      this.db
        .prepare(
          `INSERT INTO questions (question_id, n, run_id, conversation_id, reason, question, options,
             recommended, raise_to_usd, action_ref, action, note, state, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
        )
        .run(
          questionId,
          n,
          runId,
          run.conversationId,
          draft.reason,
          draft.question,
          JSON.stringify(draft.options),
          draft.recommended,
          draft.raiseToUsd,
          draft.actionRef,
          draft.action ? JSON.stringify(draft.action) : null,
          draft.note ?? null,
          this.now(),
        );
      const question: QuestionRow = {
        ...draft,
        action: draft.action ?? null,
        note: draft.note ?? null,
        questionId,
        runId,
        conversationId: run.conversationId,
        state: 'open',
        answer: null,
      };
      this.enqueueOutbox('question', run.conversationId, {
        conversationId: run.conversationId,
        runId,
        questionId,
        reason: question.reason,
        question: question.question,
        options: question.options,
        recommended: question.recommended,
        ...(question.note === null ? {} : { note: question.note }),
        ...(question.action === null ? {} : { action: question.action }),
      });
      return { ok: true, question };
    });
  }

  countQuestions(runId: string, reason: QuestionReason): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS c FROM questions WHERE run_id = ? AND reason = ?')
      .get(runId, reason) as { c: number };
    return row.c;
  }

  /**
   * Accepts an answer once and applies what code owns: a budget raise, an
   * approval or rejection of the held action. The caller then appends the
   * answer to the conversation (or stops the run).
   */
  answer(
    conversationId: string,
    questionId: string,
    optionId: string,
    text?: string,
  ): AnswerResult {
    return this.transaction((): AnswerResult => {
      const question = this.question(questionId);
      if (!question || question.conversationId !== conversationId) {
        return { accepted: false, reason: 'not_found' };
      }
      const option = question.options.find((candidate) => candidate.id === optionId);
      if (question.state === 'answered') {
        // Idempotent per question: the same answer again is a no-op, a different one a conflict.
        if (question.answer !== optionId || !option) return { accepted: false, reason: 'conflict' };
        const run = this.run(question.runId) as RunRow;
        return { accepted: true, duplicate: true, question, option, run };
      }
      if (question.state !== 'open') return { accepted: false, reason: 'not_open' };
      if (!option) return { accepted: false, reason: 'unknown_option' };
      const inputId = `answer:${questionId}`;
      this.db
        .prepare(
          "UPDATE questions SET state = 'answered', answer = ?, closed_at = ? WHERE question_id = ?",
        )
        .run(optionId, this.now(), questionId);
      if (question.reason === 'budget_overrun' && optionId === 'raise' && question.raiseToUsd) {
        const budget = this.budget(question.runId);
        const raise = question.raiseToUsd - budget.budgetUsd;
        if (raise > 0) this.appendLedger(question.runId, 'raise', raise, questionId);
        // The user saw what was overspent and chose to go on.
        this.db
          .prepare('UPDATE runs SET blocked_reason = NULL WHERE run_id = ?')
          .run(question.runId);
      }
      if (question.reason === 'irreversible' && question.actionRef) {
        this.db
          .prepare("UPDATE held_actions SET state = ? WHERE action_id = ? AND state = 'held'")
          .run(optionId === 'approve' ? 'approved' : 'rejected', question.actionRef);
      }
      this.db
        .prepare(
          "INSERT INTO inputs (input_id, conversation_id, run_id, kind, at) VALUES (?, ?, ?, 'answer', ?)",
        )
        .run(inputId, conversationId, question.runId, this.now());
      this.enqueueOutbox('answered', conversationId, {
        conversationId,
        runId: question.runId,
        questionId,
        optionId,
        ...(text ? { text } : {}),
      });
      const run = this.run(question.runId) as RunRow;
      if (run.state === 'waiting') this.setRunState(run.runId, 'active');
      return {
        accepted: true,
        duplicate: false,
        question: { ...question, state: 'answered', answer: optionId },
        option,
        run: { ...run, state: run.state === 'waiting' ? 'active' : run.state },
      };
    });
  }

  /**
   * Dismisses the run's open question, if any, as a message sent instead of an
   * answer does, and expires its held actions. Returns the dismissed question.
   */
  dismissQuestion(runId: string): string | null {
    const open = this.openQuestion(runId);
    if (!open) return null;
    this.closeQuestion(open.questionId, 'dismissed');
    this.expireHeld(runId);
    return open.questionId;
  }

  private closeQuestion(questionId: string, state: 'dismissed' | 'closed'): void {
    this.db
      .prepare(
        "UPDATE questions SET state = ?, closed_at = ? WHERE question_id = ? AND state = 'open'",
      )
      .run(state, this.now(), questionId);
  }

  // Held irreversible actions

  /** The held call behind `actionRef`, exactly as it will run if approved. */
  heldCall(actionId: string): (HeldCall & { runId: string; state: HeldState }) | undefined {
    const row = this.db
      .prepare('SELECT run_id, tool, args, state FROM held_actions WHERE action_id = ?')
      .get(actionId) as Row | undefined;
    if (!row) return undefined;
    return {
      runId: String(row.run_id),
      tool: String(row.tool),
      args: JSON.parse(String(row.args)) as Record<string, unknown>,
      state: row.state as HeldState,
    };
  }

  hold(runId: string, tool: string, args: unknown): string {
    const actionId = `act_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    this.db
      .prepare(
        "INSERT INTO held_actions (action_id, run_id, tool, args, state, created_at) VALUES (?, ?, ?, ?, 'held', ?)",
      )
      .run(actionId, runId, tool, canonicalJson(args), this.now());
    return actionId;
  }

  heldState(actionId: string): { runId: string; tool: string; state: HeldState } | undefined {
    const row = this.db
      .prepare('SELECT run_id, tool, state FROM held_actions WHERE action_id = ?')
      .get(actionId) as Row | undefined;
    if (!row) return undefined;
    return { runId: String(row.run_id), tool: String(row.tool), state: row.state as HeldState };
  }

  /** Uses an approval exactly once, for the tool, run and arguments it was given for. */
  consumeApproval(runId: string, tool: string, actionId: string, args: unknown): boolean {
    const changed = this.db
      .prepare(
        "UPDATE held_actions SET state = 'used' WHERE action_id = ? AND run_id = ? AND tool = ? AND args = ? AND state = 'approved'",
      )
      .run(actionId, runId, tool, canonicalJson(args)).changes;
    return Number(changed) === 1;
  }

  /** Held and approved-but-unused actions of a run stop being usable. */
  expireHeld(runId: string): void {
    this.db
      .prepare(
        "UPDATE held_actions SET state = 'expired' WHERE run_id = ? AND state IN ('held', 'approved')",
      )
      .run(runId);
  }

  // Outbox. Every event for the user is a row written in the same transaction
  // as the state change it reports, with a stable id, and stays until acked.

  enqueueOutbox(
    kind: OutboxKind,
    conversationId: string,
    payload: Record<string, unknown>,
    completesRun: string | null = null,
  ): string {
    const eventId = `evt_${randomUUID().replaceAll('-', '')}`;
    this.db
      .prepare(
        'INSERT INTO outbox (event_id, conversation_id, kind, payload, completes_run) VALUES (?, ?, ?, ?, ?)',
      )
      .run(eventId, conversationId, kind, JSON.stringify({ ...payload, eventId }), completesRun);
    return eventId;
  }

  /** A notice to the conversation's feed; counted against the run's cap by `takeNotice`, not here. */
  enqueueNotice(
    run: Pick<RunRow, 'conversationId' | 'runId'> | { conversationId: string },
    text: string,
  ): string {
    const runId = 'runId' in run ? run.runId : undefined;
    return this.enqueueOutbox('notice', run.conversationId, {
      conversationId: run.conversationId,
      ...(runId === undefined ? {} : { runId }),
      text,
    });
  }

  /** The conversation's oldest event not acked yet: events of one conversation go out in order. */
  nextOutbox(conversationId: string): OutboxRow | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM outbox WHERE conversation_id = ? AND acked_at IS NULL ORDER BY n LIMIT 1',
      )
      .get(conversationId) as Row | undefined;
    if (!row) return undefined;
    return {
      eventId: String(row.event_id),
      conversationId: String(row.conversation_id),
      kind: row.kind as OutboxKind,
      payload: JSON.parse(String(row.payload)) as Record<string, unknown>,
      attempts: Number(row.attempts),
    };
  }

  outboxConversations(): string[] {
    return (
      this.db
        .prepare('SELECT DISTINCT conversation_id FROM outbox WHERE acked_at IS NULL')
        .all() as Row[]
    ).map((row) => String(row.conversation_id));
  }

  outboxFailed(eventId: string): number {
    this.db.prepare('UPDATE outbox SET attempts = attempts + 1 WHERE event_id = ?').run(eventId);
    const row = this.db
      .prepare('SELECT attempts FROM outbox WHERE event_id = ?')
      .get(eventId) as Row;
    return Number(row.attempts);
  }

  /** The event was delivered. A run whose final message it was is done now. */
  ackOutbox(eventId: string): void {
    this.transaction(() => {
      const row = this.db
        .prepare('SELECT completes_run FROM outbox WHERE event_id = ? AND acked_at IS NULL')
        .get(eventId) as Row | undefined;
      if (!row) return;
      this.db.prepare('UPDATE outbox SET acked_at = ? WHERE event_id = ?').run(this.now(), eventId);
      if (row.completes_run !== null) {
        this.db
          .prepare(
            "UPDATE runs SET state = 'done', end_reason = 'delivered' WHERE run_id = ? AND state = 'delivering'",
          )
          .run(String(row.completes_run));
      }
    });
  }

  countHeld(state: HeldState): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS c FROM held_actions WHERE state = ?')
      .get(state) as { c: number };
    return row.c;
  }
}

function toRun(row: Row): RunRow {
  return {
    runId: String(row.run_id),
    conversationId: String(row.conversation_id),
    state: row.state as RunState,
    playbook: row.playbook === null ? null : String(row.playbook),
    budgetUsd: Number(row.budget_usd),
    createdAt: Number(row.created_at),
    endedAt: row.ended_at === null ? null : Number(row.ended_at),
    endReason: row.end_reason === null ? null : String(row.end_reason),
  };
}

function toQuestion(row: Row): QuestionRow {
  return {
    questionId: String(row.question_id),
    runId: String(row.run_id),
    conversationId: String(row.conversation_id),
    reason: row.reason as QuestionReason,
    question: String(row.question),
    options: JSON.parse(String(row.options)) as QuestionOption[],
    recommended: String(row.recommended),
    raiseToUsd: row.raise_to_usd === null ? null : Number(row.raise_to_usd),
    actionRef: row.action_ref === null ? null : String(row.action_ref),
    action: row.action === null ? null : (JSON.parse(String(row.action)) as HeldCall),
    note: row.note === null ? null : String(row.note),
    state: row.state as QuestionRow['state'],
    answer: row.answer === null ? null : String(row.answer),
  };
}

function toDelegation(row: Row): DelegationRow {
  return {
    key: String(row.key),
    runId: String(row.run_id),
    conversationId: String(row.conversation_id),
    taskId: row.task_id === null ? null : String(row.task_id),
    reservedUsd: Number(row.reserved),
    state: row.state as DelegationRow['state'],
    actualUsd: row.actual_usd === null ? null : Number(row.actual_usd),
    cancelPending: Number(row.cancel_pending) === 1,
  };
}

/** Rounds away float noise from sums of dollar amounts. */
function roundUsd(usd: number): number {
  return Math.round(usd * 1e9) / 1e9;
}

function money(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/** JSON with object keys sorted, so the same arguments always compare equal. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : item,
  );
}
