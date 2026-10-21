import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { Account, SpendAccounts } from './accounts.js';
import type { BudgetPort, CapHit, ReserveResult } from './budget.js';

/**
 * Where the spend of a task's grants is written down as it happens, so a restart cannot lose it.
 * Both calls are synchronous and durable when they return: a hold before its request is sent,
 * a settle when the request is done.
 */
export interface SpendJournal {
  /** Writes down a reservation. Throws if it cannot: the request is then refused. */
  hold(taskId: string, key: string, usd: number): void;
  /** Replaces the reservation under `key` with what the request cost. */
  settle(taskId: string, key: string, usd: number): void;
}

/** What one task's grants spent in an earlier process: every settle, and every hold left open. */
export interface UnrecordedSpend {
  taskId: string;
  usd: number;
  /** Reservations the earlier process left open: model calls it died in, at their reserved amount. */
  cutOffCalls?: number;
  /** What those reservations add up to; already part of `usd`. */
  cutOffUsd?: number;
}

/**
 * A grant's port that writes every reservation and settle to `journal` too. A reservation the
 * journal cannot take is released and refused, so nothing is sent that a restart could forget.
 */
export function journaledPort(port: BudgetPort, journal: SpendJournal, taskId: string): BudgetPort {
  return {
    reserve(key, usd) {
      const result = port.reserve(key, usd);
      if (!result.ok) return result;
      try {
        journal.hold(taskId, key, usd);
      } catch {
        port.settle(key, 0);
        return { ok: false, unavailable: true, reason: 'the spend could not be recorded' };
      }
      return result;
    },
    settle(key, usd) {
      try {
        // If this throws, the hold stays written and a restart charges it in full.
        journal.settle(taskId, key, usd);
      } finally {
        port.settle(key, usd);
      }
    },
  };
}

/** Opening or setting up a file that another process is setting up at that moment can fail for a moment. */
const OPEN_RETRY_MS = 10_000;
const TRANSIENT = new Set([5, 6, 10]); // SQLITE_BUSY, SQLITE_LOCKED, SQLITE_IOERR (any extended code)

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * A new file is switched to WAL by whichever process gets there first; the others can be refused
 * ("database is locked", "disk I/O error") although `busy_timeout` is set, because SQLite does not
 * wait where waiting could deadlock. Setting up is idempotent, so a refusal is retried from the
 * start for a while; anything else is thrown at once.
 */
function openJournal(path: string): DatabaseSync {
  const giveUpAt = Date.now() + OPEN_RETRY_MS;
  for (;;) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(path);
      db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS holds (
        key TEXT PRIMARY KEY,
        epoch TEXT NOT NULL,
        task_id TEXT NOT NULL,
        usd REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS spent (
        epoch TEXT NOT NULL,
        task_id TEXT NOT NULL,
        usd REAL NOT NULL,
        PRIMARY KEY (epoch, task_id)
      );
      CREATE TABLE IF NOT EXISTS daily (
        key TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        day TEXT NOT NULL,
        usd REAL NOT NULL,
        settled INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS daily_day ON daily (name, day);
      CREATE TABLE IF NOT EXISTS account_spend (
        key TEXT PRIMARY KEY,
        account TEXT NOT NULL,
        day TEXT NOT NULL,
        month TEXT NOT NULL,
        usd REAL NOT NULL,
        settled INTEGER NOT NULL DEFAULT 0,
        booked_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS account_spend_day ON account_spend (day, account);
      CREATE INDEX IF NOT EXISTS account_spend_month ON account_spend (account, month);
      CREATE TABLE IF NOT EXISTS run_budget (
        account TEXT PRIMARY KEY,
        limit_usd REAL NOT NULL,
        since_ms INTEGER NOT NULL,
        run_id TEXT NOT NULL DEFAULT '',
        heartbeat_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS run_generation (
        account TEXT PRIMARY KEY,
        generation INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS spend_policy (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        invite_daily_usd REAL NOT NULL,
        invite_monthly_usd REAL NOT NULL,
        server_daily_usd REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_alerts (
        invite_id TEXT NOT NULL,
        key TEXT NOT NULL,
        first_at INTEGER NOT NULL,
        failures INTEGER NOT NULL,
        retry_at INTEGER NOT NULL,
        PRIMARY KEY (invite_id, key)
      );
      `);
      addColumn(db, 'account_spend', 'booked_at', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'account_spend', 'generation', 'INTEGER');
      addColumn(db, 'run_budget', 'run_id', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'run_budget', 'heartbeat_at', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'run_budget', 'since_seq', 'INTEGER');
      installRunBudgetTriggers(db);
      return db;
    } catch (error) {
      try {
        db?.close();
      } catch {
        // Nothing more to release.
      }
      const code = (error as { errcode?: unknown }).errcode;
      if (typeof code !== 'number' || !TRANSIENT.has(code & 0xff) || Date.now() >= giveUpAt) {
        throw error;
      }
      sleepSync(5 + Math.random() * 20);
    }
  }
}

/** A journal made before a column existed does not have it; rows from then get the default. */
function addColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((found) => found.name === column)) return;
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (error) {
    // Another process added it between the check and the statement.
    if (!/duplicate column/iu.test(error instanceof Error ? error.message : '')) throw error;
  }
}

/**
 * Whether a row of `account_spend` counts toward the budget in `run` (a `run_budget` row in scope):
 * it was booked after the budget was set, which the row sequence tells exactly (`since_seq` is the
 * highest rowid when the budget was set) and the clock tells only to the millisecond. Either
 * counts it, so a stamp that truncated below the start, or a clock that stepped back, cannot let a
 * booking escape the window.
 */
const IN_RUN_WINDOW =
  '(booked_at >= run.since_ms OR (run.since_seq IS NOT NULL AND account_spend.rowid > run.since_seq))';

const TRIGGER_GUARD = 'run_budget_guard_v3';
const TRIGGER_FENCE = 'run_generation_fence_v1';
const TRIGGER_STAMP = 'run_budget_stamp_v1';
/** Earlier guards. A file may still carry them; the current one covers what they did. */
const OLDER_GUARDS = ['run_budget_guard_v1', 'run_budget_guard_v2'];

/**
 * A run budget is enforced by the journal file itself, so it binds every process that books into
 * it, whatever code that process runs: a server on an older version, or one that is still running
 * while a newer one fails to start, books through the same `account_spend` table.
 *
 * `run_budget_guard_v3` aborts an insert that would take what the account booked since the budget
 * began above its limit, and any insert while the budget is one an earlier version left without a
 * row sequence (`since_seq` NULL), which cannot be trusted to count every booking until a run
 * reopens it. `run_generation_fence_v1` aborts an insert that carries a generation other than the
 * account's current one: a credential issued under an earlier run (see `setRunBudget`) books
 * nothing. `run_budget_stamp_v1` gives a row inserted without a time (by a process that does not
 * know the column) the time of its insert, so its spend counts from then on. All are in the file
 * once any process on this code has opened it, and a connection that is open already sees them at
 * its next statement.
 */
const RUN_BUDGET_TRIGGERS = `
  CREATE TRIGGER IF NOT EXISTS ${TRIGGER_GUARD} BEFORE INSERT ON account_spend
  WHEN EXISTS (
    SELECT 1 FROM run_budget AS run
    WHERE run.account = NEW.account
      AND (
        run.since_seq IS NULL
        OR (
          SELECT COALESCE(SUM(usd), 0) FROM account_spend
          WHERE account = NEW.account AND ${IN_RUN_WINDOW}
        ) + NEW.usd > run.limit_usd + 1e-9
      )
  )
  BEGIN
    SELECT RAISE(ABORT, 'the run budget of this account is used up');
  END;
  CREATE TRIGGER IF NOT EXISTS ${TRIGGER_FENCE} BEFORE INSERT ON account_spend
  WHEN NEW.generation IS NOT NULL
    AND NEW.generation <> COALESCE(
      (SELECT generation FROM run_generation WHERE account = NEW.account), 0
    )
  BEGIN
    SELECT RAISE(ABORT, 'the credential belongs to an earlier run of this account');
  END;
  CREATE TRIGGER IF NOT EXISTS ${TRIGGER_STAMP} AFTER INSERT ON account_spend
  WHEN NEW.booked_at = 0
  BEGIN
    UPDATE account_spend
    SET booked_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
    WHERE key = NEW.key;
  END;
`;

/**
 * Puts the current guards in the file, then takes the earlier ones out, in one transaction: a
 * process that books through the file is never between two guards, and a failure leaves the
 * earlier ones where they were.
 */
function installRunBudgetTriggers(db: DatabaseSync): void {
  const names = [TRIGGER_GUARD, TRIGGER_FENCE, TRIGGER_STAMP, ...OLDER_GUARDS];
  const present = new Set(
    (
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN (${names.map(() => '?').join(', ')})`,
        )
        .all(...names) as Array<{ name: string }>
    ).map((row) => row.name),
  );
  // Nothing to write, so no write lock to wait for.
  if (
    [TRIGGER_GUARD, TRIGGER_FENCE, TRIGGER_STAMP].every((name) => present.has(name)) &&
    OLDER_GUARDS.every((name) => !present.has(name))
  ) {
    return;
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(RUN_BUDGET_TRIGGERS);
    for (const name of OLDER_GUARDS) db.exec(`DROP TRIGGER IF EXISTS ${name}`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * What an invite may spend in one run, wherever the run falls: a budget that starts at `sinceMs`
 * and counts everything the invite books from then on (held and settled), across UTC midnight and
 * restarts. It is kept in the journal file, so the process that runs the work sets it from outside
 * the server and the ledger reads it at every reservation.
 */
export interface RunBudget {
  limitUsd: number;
  sinceMs: number;
}

/**
 * Whether the journal file itself refuses a booking past a run budget, from whichever process it
 * comes (see `RUN_BUDGET_TRIGGERS`). Read-only.
 */
export function journalEnforcesRunBudgets(path: string): boolean {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const found = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN (?, ?, ?)")
      .all(TRIGGER_GUARD, TRIGGER_FENCE, TRIGGER_STAMP);
    return found.length === 3;
  } finally {
    db.close();
  }
}

function withJournal<T>(path: string, body: (db: DatabaseSync) => T): T {
  // A missing file would be created empty: the server has never run here.
  if (!existsSync(path)) throw new Error(`The server has not run here: ${path} does not exist.`);
  const db = openJournal(path);
  try {
    return body(db);
  } finally {
    db.close();
  }
}

/** How long a run may go without renewing its hold on an invite's run budget before another run may take it. */
export const RUN_LEASE_MS = 120_000;

/** Another run holds the run budget of this invite and is still renewing it. */
export class RunBudgetHeld extends Error {
  override name = 'RunBudgetHeld';
}

/**
 * Starts the run budget of `inviteId` for the run `runId`. From now on the account ledger refuses
 * a reservation that would take what the invite booked since `sinceMs` above `limitUsd`.
 *
 * One run holds an invite's budget at a time: while another run renewed it within `RUN_LEASE_MS`
 * this throws `RunBudgetHeld` and changes nothing. A budget nobody renews (its run was killed) is
 * taken over, and the takeover first fences the run it takes over from: the account's generation
 * moves up, and every credential issued under the earlier one (a gateway key, a conductor
 * session) books nothing from then on, wherever it is still in use. Only then does the new run get
 * a window of its own, which starts empty. Each run is held to its own limit, and none of an
 * earlier run's tasks can add to it.
 *
 * The run that holds the budget may set it again (a retry, a changed limit): that keeps its window
 * and its generation, so it never gives the run a fresh start. Renew it with `renewRunBudget`
 * while the run lasts.
 *
 * Returns whether a takeover fenced another run's credentials.
 */
export function setRunBudget(
  path: string,
  inviteId: string,
  budget: RunBudget,
  runId: string,
  now: number = Date.now(),
): { fenced: boolean } {
  if (
    !Number.isFinite(budget.limitUsd) ||
    budget.limitUsd < 0 ||
    !Number.isFinite(budget.sinceMs)
  ) {
    throw new RangeError('A run budget is a number of dollars, 0 or more, from a point in time');
  }
  if (runId === '') throw new RangeError('A run budget belongs to a run with an id');
  return withJournal(path, (db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const held = db
        .prepare('SELECT run_id, heartbeat_at, since_seq FROM run_budget WHERE account = ?')
        .get(inviteId) as
        | { run_id: string; heartbeat_at: number; since_seq: number | null }
        | undefined;
      if (held && held.run_id !== runId && held.heartbeat_at + RUN_LEASE_MS > now) {
        throw new RunBudgetHeld('another run holds the run budget of this invite');
      }
      // The holder sets its own limit again: same window, same generation. A budget an earlier
      // version left without a row sequence is never the holder's, whatever its run id says.
      if (held && held.run_id === runId && held.since_seq !== null) {
        db.prepare(
          'UPDATE run_budget SET limit_usd = ?, heartbeat_at = ? WHERE account = ? AND run_id = ?',
        ).run(budget.limitUsd, now, inviteId, runId);
        db.exec('COMMIT');
        return { fenced: false };
      }
      // A new run: fence the earlier one's credentials, then open the new window.
      bumpGeneration(db, inviteId);
      // Rows after this one were booked after the budget was set, whatever their timestamps say.
      const { seq } = db
        .prepare('SELECT COALESCE(MAX(rowid), 0) AS seq FROM account_spend')
        .get() as { seq: number };
      db.prepare(
        `INSERT INTO run_budget (account, limit_usd, since_ms, since_seq, run_id, heartbeat_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (account) DO UPDATE SET limit_usd = excluded.limit_usd,
           since_ms = excluded.since_ms, since_seq = excluded.since_seq, run_id = excluded.run_id,
           heartbeat_at = excluded.heartbeat_at`,
      ).run(inviteId, budget.limitUsd, budget.sinceMs, seq, runId, now);
      db.exec('COMMIT');
      return { fenced: held !== undefined };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  });
}

/** Moves the account to the next generation, which makes every credential of the earlier one book nothing. */
function bumpGeneration(db: DatabaseSync, account: string): void {
  db.prepare(
    `INSERT INTO run_generation (account, generation) VALUES (?, 1)
     ON CONFLICT (account) DO UPDATE SET generation = generation + 1`,
  ).run(account);
}

/** Keeps the hold of run `runId` on the invite's run budget. False when the run no longer holds it. */
export function renewRunBudget(
  path: string,
  inviteId: string,
  runId: string,
  now: number = Date.now(),
): boolean {
  return withJournal(
    path,
    (db) =>
      Number(
        db
          .prepare('UPDATE run_budget SET heartbeat_at = ? WHERE account = ? AND run_id = ?')
          .run(now, inviteId, runId).changes,
      ) > 0,
  );
}

/**
 * Ends the run budget of `inviteId` if run `runId` holds it; another run's budget is never
 * touched. The invite is then held to its daily and monthly caps alone, and the run's credentials
 * are fenced like a taken-over run's: the run is over, so what it left behind books nothing, and
 * ending the budget does not lift the cap off a task of an earlier run. False when it was not
 * this run's.
 */
export function clearRunBudget(path: string, inviteId: string, runId: string): boolean {
  return withJournal(path, (db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const removed =
        Number(
          db.prepare('DELETE FROM run_budget WHERE account = ? AND run_id = ?').run(inviteId, runId)
            .changes,
        ) > 0;
      if (removed) bumpGeneration(db, inviteId);
      db.exec('COMMIT');
      return removed;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  });
}

/** What an invite may spend per UTC day and month unless it has caps of its own, and what the whole server may spend per day. */
export interface SpendPolicy {
  inviteDailyUsd: number;
  inviteMonthlyUsd: number;
  serverDailyUsd: number;
}

/** An alert asked for and not yet delivered to every device, with the wait before the next try. */
export interface PendingAlert {
  inviteId: string;
  key: string;
  /** When it was first asked for, in milliseconds since the epoch. */
  firstAt: number;
  /** Rounds that left a device owed. */
  failures: number;
  /** The earliest the timer may try again, in milliseconds since the epoch. */
  retryAt: number;
}

/**
 * The journal in SQLite. Each process writes under its own epoch; at start, what earlier epochs
 * wrote is handed to the task log once (`unrecorded`) and then forgotten (`recorded`).
 */
export class SqliteSpendJournal implements SpendJournal {
  private readonly db: DatabaseSync;
  private readonly epoch = randomUUID();

  constructor(path: string) {
    this.db = openJournal(path);
  }

  /**
   * Writes down the caps this ledger runs under, where every process that books spend against it
   * reads them: the server writes at each start, another process (the evals) reads them instead of
   * its own settings. Replaces the earlier policy.
   */
  setSpendPolicy(policy: SpendPolicy): void {
    for (const usd of [policy.inviteDailyUsd, policy.inviteMonthlyUsd, policy.serverDailyUsd]) {
      if (!Number.isFinite(usd) || usd < 0) {
        throw new RangeError('A spend cap is a number of dollars, 0 or more');
      }
    }
    this.db
      .prepare(
        `INSERT INTO spend_policy (id, invite_daily_usd, invite_monthly_usd, server_daily_usd)
         VALUES (1, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET invite_daily_usd = excluded.invite_daily_usd,
           invite_monthly_usd = excluded.invite_monthly_usd,
           server_daily_usd = excluded.server_daily_usd`,
      )
      .run(policy.inviteDailyUsd, policy.inviteMonthlyUsd, policy.serverDailyUsd);
  }

  /** The caps the server last wrote down, read from the file each time; nothing if it never has. */
  spendPolicy(): SpendPolicy | undefined {
    const row = this.db
      .prepare(
        'SELECT invite_daily_usd, invite_monthly_usd, server_daily_usd FROM spend_policy WHERE id = 1',
      )
      .get() as
      | { invite_daily_usd: number; invite_monthly_usd: number; server_daily_usd: number }
      | undefined;
    return (
      row && {
        inviteDailyUsd: row.invite_daily_usd,
        inviteMonthlyUsd: row.invite_monthly_usd,
        serverDailyUsd: row.server_daily_usd,
      }
    );
  }

  /** Writes an alert down as owed, or updates its wait. Survives a restart. */
  savePendingAlert(alert: PendingAlert): void {
    this.db
      .prepare(
        `INSERT INTO pending_alerts (invite_id, key, first_at, failures, retry_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (invite_id, key) DO UPDATE SET failures = excluded.failures,
           retry_at = excluded.retry_at`,
      )
      .run(alert.inviteId, alert.key, alert.firstAt, alert.failures, alert.retryAt);
  }

  /** The alerts still owed, oldest first. */
  pendingAlerts(): PendingAlert[] {
    const rows = this.db
      .prepare(
        'SELECT invite_id, key, first_at, failures, retry_at FROM pending_alerts ORDER BY first_at, key',
      )
      .all() as Array<{
      invite_id: string;
      key: string;
      first_at: number;
      failures: number;
      retry_at: number;
    }>;
    return rows.map((row) => ({
      inviteId: row.invite_id,
      key: row.key,
      firstAt: row.first_at,
      failures: row.failures,
      retryAt: row.retry_at,
    }));
  }

  /** Ends an alert: it was delivered, or will never be. */
  clearPendingAlert(inviteId: string, key: string): void {
    this.db
      .prepare('DELETE FROM pending_alerts WHERE invite_id = ? AND key = ?')
      .run(inviteId, key);
  }

  hold(taskId: string, key: string, usd: number): void {
    this.db
      .prepare('INSERT INTO holds (key, epoch, task_id, usd) VALUES (?, ?, ?, ?)')
      .run(key, this.epoch, taskId, usd);
  }

  settle(taskId: string, key: string, usd: number): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const held = this.db
        .prepare('DELETE FROM holds WHERE key = ? AND epoch = ?')
        .run(key, this.epoch);
      // A key that holds nothing here was never reserved through the journal: nothing to add.
      if (Number(held.changes) > 0) {
        this.db
          .prepare(
            `INSERT INTO spent (epoch, task_id, usd) VALUES (?, ?, ?)
             ON CONFLICT (epoch, task_id) DO UPDATE SET usd = usd + excluded.usd`,
          )
          .run(this.epoch, taskId, usd);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Per task, what earlier processes spent through its grants: their settles, plus every hold
   * they left open at its reserved amount, since whether the vendor billed it is unknown.
   */
  unrecorded(): UnrecordedSpend[] {
    const rows = this.db
      .prepare(
        `SELECT task_id AS taskId, SUM(usd) AS usd, SUM(open) AS cutOffCalls, SUM(open_usd) AS cutOffUsd FROM (
           SELECT task_id, usd, 1 AS open, usd AS open_usd FROM holds WHERE epoch != ?
           UNION ALL
           SELECT task_id, usd, 0 AS open, 0 AS open_usd FROM spent WHERE epoch != ?
         ) GROUP BY task_id ORDER BY task_id`,
      )
      .all(this.epoch, this.epoch) as unknown as UnrecordedSpend[];
    return rows.map((row) => ({
      taskId: row.taskId,
      usd: row.usd,
      cutOffCalls: row.cutOffCalls,
      cutOffUsd: row.cutOffUsd,
    }));
  }

  /** Forgets what `unrecorded` returned, once the task log holds it. */
  recorded(): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM holds WHERE epoch != ?').run(this.epoch);
      this.db.prepare('DELETE FROM spent WHERE epoch != ?').run(this.epoch);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * A dollar limit per UTC day, kept in the journal, for spend that belongs to no task (the
   * digest summary). A request settles on the day it was reserved. A reservation an earlier
   * process never settled counts at its reserved amount, so a restart cannot spend the day twice.
   */
  dailyLimit(name: string, capUsd: number, now: () => number = Date.now): BudgetPort {
    return {
      reserve: (key, usd) => {
        if (!Number.isFinite(usd) || usd < 0) {
          return { ok: false, reason: 'the request has no valid cost' };
        }
        const day = new Date(now()).toISOString().slice(0, 10);
        try {
          this.db.exec('BEGIN IMMEDIATE');
        } catch {
          return { ok: false, unavailable: true, reason: 'the spend could not be recorded' };
        }
        try {
          const row = this.db
            .prepare('SELECT COALESCE(SUM(usd), 0) AS usd FROM daily WHERE name = ? AND day = ?')
            .get(name, day) as { usd: number };
          if (row.usd + usd > capUsd + 1e-9) {
            this.db.exec('ROLLBACK');
            return {
              ok: false,
              budget: true,
              reason: `the day's limit of $${capUsd} for the ${name} cannot cover this request`,
            };
          }
          this.db
            .prepare('INSERT INTO daily (key, name, day, usd) VALUES (?, ?, ?, ?)')
            .run(key, name, day, usd);
          this.db.exec('COMMIT');
          return { ok: true };
        } catch {
          this.db.exec('ROLLBACK');
          return { ok: false, unavailable: true, reason: 'the spend could not be recorded' };
        }
      },
      settle: (key, usd) => {
        // If this throws, the reservation stays and counts in full.
        this.db
          .prepare('UPDATE daily SET usd = ?, settled = 1 WHERE key = ? AND settled = 0')
          .run(usd, key);
      },
    };
  }

  /**
   * Caps per invite and for the whole server, kept in the journal so a restart keeps the counters.
   * A day and a month are UTC. A request is held at its reserved amount until it settles, and a
   * hold an earlier process never settled stays at that amount, so a restart cannot spend a cap
   * twice. Every check and its hold happen in one transaction, so concurrent requests, of one
   * process or of several, cannot together pass a cap.
   */
  accountLedger(options: AccountLedgerOptions): SpendAccounts {
    const now = options.now ?? Date.now;
    // History past two months is of no use to a cap.
    this.db
      .prepare('DELETE FROM account_spend WHERE day < ?')
      .run(new Date(now() - 62 * 86_400_000).toISOString().slice(0, 10));
    const sum = (where: string, ...args: Array<string | number | null>): number =>
      (
        this.db
          .prepare(`SELECT COALESCE(SUM(usd), 0) AS usd FROM account_spend WHERE ${where}`)
          .get(...args) as { usd: number }
      ).usd;
    const generationOf = (name: string): number => {
      const row = this.db
        .prepare('SELECT generation FROM run_generation WHERE account = ?')
        .get(name) as { generation: number } | undefined;
      return row?.generation ?? 0;
    };
    return {
      generationOf,
      reserve: (account: Account, key, usd): ReserveResult => {
        if (!Number.isFinite(usd) || usd < 0) {
          return { ok: false, reason: 'the request has no valid cost' };
        }
        if (options.paused?.()) {
          return { ok: false, unavailable: true, reason: 'spending is paused' };
        }
        const inviteId = account === 'server' ? undefined : account.inviteId;
        let limits: AccountLimits | undefined;
        if (inviteId !== undefined) {
          limits = options.limitsOf(inviteId);
          if (!limits || !Number.isFinite(limits.dailyUsd) || !Number.isFinite(limits.monthlyUsd)) {
            return { ok: false, budget: true, reason: 'this invite may not spend' };
          }
        }
        const serverCap = options.serverDailyUsd();
        if (!Number.isFinite(serverCap)) {
          return { ok: false, unavailable: true, reason: 'the server cap could not be read' };
        }
        const iso = new Date(now()).toISOString();
        const day = iso.slice(0, 10);
        const month = iso.slice(0, 7);
        const name = inviteId ?? 'server';
        try {
          this.db.exec('BEGIN IMMEDIATE');
        } catch {
          return { ok: false, unavailable: true, reason: 'the spend could not be recorded' };
        }
        try {
          const refusal = ((): ReserveResult | undefined => {
            if (inviteId !== undefined && limits) {
              // A credential issued under an earlier run books nothing, run budget or not.
              if (account !== 'server' && account.generation !== undefined) {
                const current = generationOf(name);
                if (account.generation !== current) {
                  return {
                    ok: false,
                    reason: 'this credential belongs to an earlier run of the invite',
                  };
                }
              }
              const run = this.db
                .prepare('SELECT limit_usd, since_ms, since_seq FROM run_budget WHERE account = ?')
                .get(name) as
                | { limit_usd: number; since_ms: number; since_seq: number | null }
                | undefined;
              if (run) {
                if (!Number.isFinite(run.limit_usd) || !Number.isFinite(run.since_ms)) {
                  return { ok: false, budget: true, reason: 'this invite may not spend' };
                }
                // An earlier version's budget has no row sequence: nothing says it counted every
                // booking, so nothing books until a run reopens it.
                if (run.since_seq === null) {
                  return {
                    ok: false,
                    budget: true,
                    reason: 'the run budget of this invite must be reopened by a new run',
                  };
                }
                if (
                  sum(
                    'account = ? AND (booked_at >= ? OR (? IS NOT NULL AND rowid > ?))',
                    name,
                    run.since_ms,
                    run.since_seq,
                    run.since_seq,
                  ) +
                    usd >
                  run.limit_usd + EPSILON
                ) {
                  return capRefusal({ scope: 'invite_run', inviteId, limitUsd: run.limit_usd });
                }
              }
              if (sum('account = ? AND day = ?', name, day) + usd > limits.dailyUsd + EPSILON) {
                return capRefusal({ scope: 'invite_daily', inviteId, limitUsd: limits.dailyUsd });
              }
              if (
                sum('account = ? AND month = ?', name, month) + usd >
                limits.monthlyUsd + EPSILON
              ) {
                return capRefusal({
                  scope: 'invite_monthly',
                  inviteId,
                  limitUsd: limits.monthlyUsd,
                });
              }
            }
            if (sum('day = ?', day) + usd > serverCap + EPSILON) {
              return capRefusal({ scope: 'server_daily', limitUsd: serverCap });
            }
            return undefined;
          })();
          if (refusal) {
            this.db.exec('ROLLBACK');
            return refusal;
          }
          this.db
            .prepare(
              'INSERT INTO account_spend (key, account, day, month, usd, booked_at, generation) VALUES (?, ?, ?, ?, ?, ?, ?)',
            )
            .run(
              key,
              name,
              day,
              month,
              usd,
              now(),
              account !== 'server' && account.generation !== undefined ? account.generation : null,
            );
          this.db.exec('COMMIT');
          return { ok: true };
        } catch {
          this.db.exec('ROLLBACK');
          return { ok: false, unavailable: true, reason: 'the spend could not be recorded' };
        }
      },
      settle: (key, usd) => {
        // If this throws, the hold stays and counts in full.
        this.db
          .prepare('UPDATE account_spend SET usd = ?, settled = 1 WHERE key = ? AND settled = 0')
          .run(usd, key);
      },
    };
  }

  /**
   * Everything the accounts spent on the UTC day of `at`, in USD: what settled plus what is still
   * held at its reserved amount. This is the number the server's daily cap counts.
   */
  serverDaySpendUsd(at: number = Date.now()): number {
    const day = new Date(at).toISOString().slice(0, 10);
    return (
      this.db
        .prepare('SELECT COALESCE(SUM(usd), 0) AS usd FROM account_spend WHERE day = ?')
        .get(day) as { usd: number }
    ).usd;
  }

  close(): void {
    this.db.close();
  }
}

/** What a journal file holds, read from outside the process that writes it. */
export interface JournalTotals {
  /** Per task: what was settled plus what is still held, all processes. */
  taskUsd: Map<string, number>;
  /** Per invite, for the UTC day of `at`: settled plus held. The server's own account is `server`. */
  accountDayUsd: Map<string, number>;
  /** All accounts, for that day. */
  serverDayUsd: number;
}

/**
 * Reads a journal without taking part in it: a separate read-only connection, no epoch of its own
 * and nothing forgotten. Task spend of a process that has since restarted moves into the task log
 * and leaves the journal, so read this before a restart to compare it with the task log.
 */
export function readJournalTotals(path: string, at: number = Date.now()): JournalTotals {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const day = new Date(at).toISOString().slice(0, 10);
    const taskUsd = new Map<string, number>();
    for (const row of db
      .prepare(
        `SELECT task_id AS id, SUM(usd) AS usd FROM
           (SELECT task_id, usd FROM spent UNION ALL SELECT task_id, usd FROM holds)
         GROUP BY task_id`,
      )
      .all() as Array<{ id: string; usd: number }>) {
      taskUsd.set(row.id, row.usd);
    }
    const accountDayUsd = new Map<string, number>();
    let serverDayUsd = 0;
    for (const row of db
      .prepare('SELECT account, SUM(usd) AS usd FROM account_spend WHERE day = ? GROUP BY account')
      .all(day) as Array<{ account: string; usd: number }>) {
      accountDayUsd.set(row.account, row.usd);
      serverDayUsd += row.usd;
    }
    return { taskUsd, accountDayUsd, serverDayUsd };
  } finally {
    db.close();
  }
}

const EPSILON = 1e-9;

/** What an invite may spend. */
export interface AccountLimits {
  dailyUsd: number;
  monthlyUsd: number;
}

export interface AccountLedgerOptions {
  /** The invite's caps; undefined when it may not spend (unknown or revoked). Read on every request. */
  limitsOf(inviteId: string): AccountLimits | undefined;
  /** The cap on all spend of a UTC day. Read on every request. */
  serverDailyUsd(): number;
  /** Spending is paused: every reservation is refused. Read on every request. */
  paused?(): boolean;
  now?(): number;
}

function money(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

function capRefusal(cap: CapHit): ReserveResult {
  const what =
    cap.scope === 'server_daily'
      ? "the server's daily limit"
      : cap.scope === 'invite_daily'
        ? "this invite's daily limit"
        : cap.scope === 'invite_run'
          ? "this invite's limit for the current run"
          : "this invite's monthly limit";
  return {
    ok: false,
    budget: true,
    cap,
    reason: `${what} of ${money(cap.limitUsd)} cannot cover this request`,
  };
}
