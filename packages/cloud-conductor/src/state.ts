import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * The conductor's own state in one SQLite file. Every method is synchronous,
 * so a check and the write it guards run in one transaction with no await in
 * between (the budget reservation, question and approval rules depend on it).
 */

export type RunState = 'active' | 'waiting' | 'done' | 'failed' | 'cancelled' | 'interrupted';
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
  state: 'open' | 'answered' | 'dismissed' | 'closed';
  answer: string | null;
}

export type HeldState = 'held' | 'approved' | 'rejected' | 'used' | 'expired';

export interface BudgetView {
  budgetUsd: number;
  spentUsd: number;
  reservedUsd: number;
  modelUsd: number;
  /** Settled spend charged by callers outside the conductor (the supervisor's verification). */
  externalUsd: number;
  remainingUsd: number;
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
  | { ok: true; charge: ExternalCharge; duplicate: boolean }
  | { ok: false; reason: 'not_found' | 'conflict' | 'invalid_amount' };

export type ReserveResult =
  | { ok: true; reservation: number }
  | { ok: false; reason: 'question_open' }
  | { ok: false; reason: 'over_budget'; budget: BudgetView };

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
CREATE TABLE IF NOT EXISTS run_tasks (
  task_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  reservation INTEGER NOT NULL
);
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

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
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
   * Open questions close and held actions expire with it. Returns whether
   * this call ended it.
   */
  endRun(runId: string, state: Exclude<RunState, 'active' | 'waiting'>, reason: string): boolean {
    return this.transaction(() => {
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
    });
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
           COALESCE(SUM(CASE WHEN kind = 'external' THEN usd END), 0) AS external
         FROM ledger WHERE run_id = ?`,
      )
      .get(runId) as {
      model: number;
      reserved: number;
      released: number;
      raised: number;
      external: number;
    };
    const reservedUsd = sums.reserved - sums.released;
    const spentUsd = sums.model + sums.external + reservedUsd;
    const budgetUsd = run.budgetUsd + sums.raised;
    return {
      budgetUsd,
      spentUsd,
      reservedUsd,
      modelUsd: sums.model,
      externalUsd: sums.external,
      remainingUsd: budgetUsd - spentUsd,
    };
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
      if (budget.spentUsd + usd > budget.budgetUsd + 1e-9) {
        return { ok: false, reason: 'over_budget', budget };
      }
      const reservation = this.appendLedger(runId, 'reserve', usd, ref);
      return { ok: true, reservation };
    });
  }

  /** Gives back a reservation whose delegation was refused. */
  release(runId: string, reservation: number): void {
    const row = this.db
      .prepare("SELECT usd FROM ledger WHERE n = ? AND run_id = ? AND kind = 'reserve'")
      .get(reservation, runId) as { usd: number } | undefined;
    if (!row) throw new Error(`Unknown reservation ${reservation}`);
    this.appendLedger(runId, 'release', row.usd, String(reservation));
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
      if (budget.spentUsd + maxUsd > budget.budgetUsd + 1e-9)
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
   * by `key`. The actual amount is charged in full even above the reservation.
   */
  settleExternal(key: string, actualUsd: number): ExternalSettleResult {
    if (!Number.isFinite(actualUsd) || actualUsd < 0)
      return { ok: false, reason: 'invalid_amount' };
    return this.transaction((): ExternalSettleResult => {
      const charge = this.externalCharge(key);
      if (!charge) return { ok: false, reason: 'not_found' };
      if (charge.state === 'settled') {
        return charge.actualUsd === actualUsd
          ? { ok: true, charge, duplicate: true }
          : { ok: false, reason: 'conflict' };
      }
      const row = this.db
        .prepare('SELECT reservation FROM external_charges WHERE key = ?')
        .get(key) as Row;
      this.appendLedger(charge.runId, 'release', charge.maxUsd, String(row.reservation));
      if (actualUsd > 0) this.appendLedger(charge.runId, 'external', actualUsd, `external:${key}`);
      this.db
        .prepare('UPDATE external_charges SET actual_usd = ? WHERE key = ?')
        .run(actualUsd, key);
      return { ok: true, charge: this.externalCharge(key) as ExternalCharge, duplicate: false };
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
          'SELECT r.run_id FROM run_tasks t JOIN runs r ON r.run_id = t.run_id WHERE t.task_id = ? AND r.conversation_id = ?',
        )
        .get(taskId, conversationId) as Row | undefined;
      if (row) return String(row.run_id);
    }
    const latest = this.db
      .prepare('SELECT run_id FROM runs WHERE conversation_id = ? ORDER BY n DESC LIMIT 1')
      .get(conversationId) as Row | undefined;
    return latest ? String(latest.run_id) : undefined;
  }

  bindTask(taskId: string, runId: string, reservation: number): void {
    this.db
      .prepare('INSERT INTO run_tasks (task_id, run_id, reservation) VALUES (?, ?, ?)')
      .run(taskId, runId, reservation);
  }

  tasksOf(runId: string): string[] {
    return (
      this.db
        .prepare('SELECT task_id FROM run_tasks WHERE run_id = ? ORDER BY rowid')
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
    draft: Omit<QuestionRow, 'questionId' | 'runId' | 'conversationId' | 'state' | 'answer'>,
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
             recommended, raise_to_usd, action_ref, state, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
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
          this.now(),
        );
      const question: QuestionRow = {
        ...draft,
        questionId,
        runId,
        conversationId: run.conversationId,
        state: 'open',
        answer: null,
      };
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
  answer(conversationId: string, questionId: string, optionId: string): AnswerResult {
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

  /** A held action's tool and the arguments it was held with. */
  heldAction(actionId: string): { runId: string; tool: string; args: unknown } | undefined {
    const row = this.db
      .prepare('SELECT run_id, tool, args FROM held_actions WHERE action_id = ?')
      .get(actionId) as Row | undefined;
    if (!row) return undefined;
    return {
      runId: String(row.run_id),
      tool: String(row.tool),
      args: JSON.parse(String(row.args)),
    };
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
    state: row.state as QuestionRow['state'],
    answer: row.answer === null ? null : String(row.answer),
  };
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
