import { randomUUID } from 'node:crypto';
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
        settled INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS account_spend_day ON account_spend (day, account);
      CREATE INDEX IF NOT EXISTS account_spend_month ON account_spend (account, month);
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
        `SELECT task_id AS taskId, SUM(usd) AS usd FROM (
           SELECT task_id, usd FROM holds WHERE epoch != ?
           UNION ALL
           SELECT task_id, usd FROM spent WHERE epoch != ?
         ) GROUP BY task_id ORDER BY task_id`,
      )
      .all(this.epoch, this.epoch) as Array<{ taskId: string; usd: number }>;
    return rows.map((row) => ({ taskId: row.taskId, usd: row.usd }));
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
    const sum = (where: string, ...args: string[]): number =>
      (
        this.db
          .prepare(`SELECT COALESCE(SUM(usd), 0) AS usd FROM account_spend WHERE ${where}`)
          .get(...args) as { usd: number }
      ).usd;
    return {
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
              'INSERT INTO account_spend (key, account, day, month, usd) VALUES (?, ?, ?, ?, ?)',
            )
            .run(key, name, day, month, usd);
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
        : "this invite's monthly limit";
  return {
    ok: false,
    budget: true,
    cap,
    reason: `${what} of ${money(cap.limitUsd)} cannot cover this request`,
  };
}
