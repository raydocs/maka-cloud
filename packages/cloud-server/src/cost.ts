import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './db.js';
import { appendFeed, type FeedHub } from './feed.js';

/** Where the public API reads the cost of a task so far. */
export interface CostSource {
  /** US dollars spent so far, or nothing when no figure was ever reported. */
  taskCostUsd(taskId: string): number | undefined;
}

/**
 * The cost figures reported for tasks, append-only. A figure only ever grows:
 * a lower or equal one is ignored, so a late or repeated report cannot make the
 * cost go backwards on a client. Each accepted figure is also a `task.cost` feed
 * entry, so a stream that reconnects sees it.
 */
export class CostLedger implements CostSource {
  constructor(
    private readonly db: DatabaseSync,
    private readonly hub: FeedHub,
    private readonly now: () => number = Date.now,
  ) {}

  taskCostUsd(taskId: string): number | undefined {
    const row = this.db
      .prepare('SELECT usd FROM task_cost_log WHERE task_id = ? ORDER BY id DESC LIMIT 1')
      .get(taskId) as { usd: number } | undefined;
    return row?.usd;
  }

  /** True when the figure was recorded: the task exists and the figure is above the last one. */
  report(taskId: string, usd: number): boolean {
    if (!Number.isFinite(usd) || usd <= 0) return false;
    const at = this.now();
    const recorded = transaction(this.db, () => {
      const task = this.db
        .prepare(
          `SELECT c.conversation_id AS conversation
           FROM task_index t LEFT JOIN conversations c ON c.session_id = t.root_session_id
           WHERE t.task_id = ?`,
        )
        .get(taskId) as { conversation: string | null } | undefined;
      if (!task) return false;
      const last = this.taskCostUsd(taskId);
      if (last !== undefined && usd <= last) return false;
      const result = this.db
        .prepare('INSERT INTO task_cost_log (task_id, usd, at) VALUES (?, ?, ?)')
        .run(taskId, usd, at);
      appendFeed(this.db, 'task.cost', task.conversation, Number(result.lastInsertRowid), at);
      return true;
    });
    if (recorded) this.hub.notify();
    return recorded;
  }
}
