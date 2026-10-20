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
