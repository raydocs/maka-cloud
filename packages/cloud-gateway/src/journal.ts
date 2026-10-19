import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { BudgetPort } from './budget.js';

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

/**
 * The journal in SQLite. Each process writes under its own epoch; at start, what earlier epochs
 * wrote is handed to the task log once (`unrecorded`) and then forgotten (`recorded`).
 */
export class SqliteSpendJournal implements SpendJournal {
  private readonly db: DatabaseSync;
  private readonly epoch = randomUUID();

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
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
    `);
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

  close(): void {
    this.db.close();
  }
}
