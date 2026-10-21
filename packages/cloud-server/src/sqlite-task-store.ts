import type { DatabaseSync, StatementSync } from 'node:sqlite';
import {
  assertEpoch,
  type Fence,
  type SessionId,
  type StoredEvent,
  type TaskEvent,
  type TaskId,
  type TaskStore,
} from '@maka-cloud/orchestrator';
import { transaction } from './db.js';
import { appendFeed, type FeedHub } from './feed.js';

const TERMINAL: Partial<Record<TaskEvent['type'], string>> = {
  task_succeeded: 'succeeded',
  task_failed: 'failed',
  task_cancelled: 'cancelled',
};

const ID_PAGE = 1000;

/**
 * Events that belong to the driver and the orchestrator, not to the people watching: a client's feed
 * carries none of them (every tool call is a step).
 */
const NOT_IN_FEED: ReadonlySet<TaskEvent['type']> = new Set([
  'task_attempt',
  'step_intent',
  'step_outcome',
  'step_interrupted',
]);

interface LogRow {
  seq: number;
  at: number;
  event: string;
}

/**
 * The orchestrator's append-only log in SQLite. `seq` is `max + 1` inside the
 * append transaction, so it is exactly 1, 2, 3, ... and nothing else writes
 * `task_log`. The task index and the feed row change in that same transaction;
 * open streams are told only after it committed.
 */
export class SqliteTaskStore implements TaskStore {
  private readonly nextSeq: StatementSync;
  private readonly insertLog: StatementSync;
  private readonly insertTask: StatementSync;
  private readonly startTask: StatementSync;
  private readonly endTask: StatementSync;
  private readonly markStop: StatementSync;
  private readonly rootOfTask: StatementSync;
  private readonly conversationOfSession: StatementSync;
  private readonly epochOfTask: StatementSync;
  private readonly setEpoch: StatementSync;

  constructor(
    private readonly db: DatabaseSync,
    private readonly hub: FeedHub,
  ) {
    this.nextSeq = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM task_log');
    this.insertLog = db.prepare(
      'INSERT INTO task_log (seq, at, task_id, event) VALUES (?, ?, ?, ?)',
    );
    this.insertTask = db.prepare(
      `INSERT OR IGNORE INTO task_index
         (task_id, session_id, root_session_id, parent_task_id, state, created_at)
       VALUES (?, ?, ?, ?, 'queued', ?)`,
    );
    this.startTask = db.prepare(
      "UPDATE task_index SET state = 'running' WHERE task_id = ? AND state = 'queued'",
    );
    this.endTask = db.prepare(
      "UPDATE task_index SET state = ? WHERE task_id = ? AND state IN ('queued', 'running')",
    );
    this.markStop = db.prepare('UPDATE task_index SET stop_pending = ? WHERE task_id = ?');
    this.rootOfTask = db.prepare(
      'SELECT root_session_id AS root FROM task_index WHERE task_id = ?',
    );
    this.conversationOfSession = db.prepare(
      'SELECT conversation_id AS id FROM conversations WHERE session_id = ?',
    );
    this.epochOfTask = db.prepare('SELECT epoch FROM task_index WHERE task_id = ?');
    this.setEpoch = db.prepare('UPDATE task_index SET epoch = ? WHERE task_id = ?');
  }

  async append(event: TaskEvent, at: number, fence?: Fence): Promise<StoredEvent> {
    const stored = transaction(this.db, () => {
      // Checked in the transaction that appends, so two writers racing for a task cannot both win.
      assertEpoch(event, fence, (id) => {
        const row = this.epochOfTask.get(id) as { epoch: number } | undefined;
        return row?.epoch;
      });
      const { seq } = this.nextSeq.get() as { seq: number };
      this.insertLog.run(seq, at, event.taskId, JSON.stringify(event));
      this.index(event, at);
      if (!NOT_IN_FEED.has(event.type)) {
        appendFeed(this.db, 'task.event', this.conversationOf(event), seq, at);
      }
      return freeze<StoredEvent>({ seq, at, event: structuredClone(event) });
    });
    this.hub.notify();
    return stored;
  }

  async read(afterSeq = 0): Promise<StoredEvent[]> {
    const rows = this.db
      .prepare('SELECT seq, at, event FROM task_log WHERE seq > ? ORDER BY seq')
      .all(afterSeq) as unknown as LogRow[];
    return rows.map(toStored);
  }

  readTask(taskId: TaskId): StoredEvent[] {
    const rows = this.db
      .prepare('SELECT seq, at, event FROM task_log WHERE task_id = ? ORDER BY seq')
      .all(taskId) as unknown as LogRow[];
    return rows.map(toStored);
  }

  childrenOf(taskId: TaskId): TaskId[] {
    const rows = this.db
      .prepare('SELECT task_id AS id FROM task_index WHERE parent_task_id = ? ORDER BY n')
      .all(taskId) as unknown as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  activeTaskIds(): TaskId[] {
    const rows = this.db
      .prepare(
        "SELECT task_id AS id FROM task_index WHERE state IN ('queued', 'running') ORDER BY n",
      )
      .all() as unknown as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  /** Every task id, read a page at a time so the caller never holds the whole table. */
  *taskIds(): Iterable<TaskId> {
    let after = 0;
    for (;;) {
      const rows = this.db
        .prepare('SELECT n, task_id AS id FROM task_index WHERE n > ? ORDER BY n LIMIT ?')
        .all(after, ID_PAGE) as unknown as Array<{ n: number; id: string }>;
      for (const row of rows) yield row.id;
      const last = rows.at(-1);
      if (!last || rows.length < ID_PAGE) return;
      after = last.n;
    }
  }

  stopPendingTaskIds(): TaskId[] {
    const rows = this.db
      .prepare('SELECT task_id AS id FROM task_index WHERE stop_pending = 1 ORDER BY n')
      .all() as unknown as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  countCreatedSince(rootSessionId: SessionId, sinceMs: number): number {
    const row = this.db
      .prepare(
        'SELECT COUNT(*) AS count FROM task_index WHERE root_session_id = ? AND created_at >= ?',
      )
      .get(rootSessionId, sinceMs) as { count: number };
    return row.count;
  }

  /** Tasks of one conversation tree in creation order, after position `after`. */
  tasksOfRoot(rootSessionId: SessionId, after: number, limit: number) {
    const rows = this.db
      .prepare(
        'SELECT n, task_id AS id FROM task_index WHERE root_session_id = ? AND n > ? ORDER BY n LIMIT ?',
      )
      .all(rootSessionId, after, limit) as unknown as Array<{ n: number; id: string }>;
    return rows.map((row) => ({ position: row.n, taskId: row.id }));
  }

  /** Throws the index away and derives it again from the log. The log is untouched. */
  rebuildTaskIndex(): void {
    transaction(this.db, () => {
      this.db.exec('DELETE FROM task_index');
      const rows = this.db
        .prepare('SELECT at, event FROM task_log ORDER BY seq')
        .all() as unknown as Array<{ at: number; event: string }>;
      for (const row of rows) this.index(JSON.parse(row.event) as TaskEvent, row.at);
    });
  }

  private index(event: TaskEvent, at: number): void {
    if (event.type === 'task_created') {
      this.insertTask.run(
        event.taskId,
        event.sessionId,
        event.rootSessionId ?? event.sessionId,
        event.parentTaskId ?? null,
        at,
      );
    } else if (event.type === 'task_attempt') {
      this.setEpoch.run(event.epoch, event.taskId);
    } else if (event.type === 'task_started') {
      this.startTask.run(event.taskId);
    } else if (event.type === 'task_stop_pending' || event.type === 'task_stopped') {
      this.markStop.run(event.type === 'task_stop_pending' ? 1 : 0, event.taskId);
    } else {
      const state = TERMINAL[event.type];
      if (state !== undefined) this.endTask.run(state, event.taskId);
    }
  }

  private conversationOf(event: TaskEvent): string | null {
    const root =
      event.type === 'task_created'
        ? (event.rootSessionId ?? event.sessionId)
        : (this.rootOfTask.get(event.taskId) as { root: string } | undefined)?.root;
    if (root === undefined) return null;
    return (this.conversationOfSession.get(root) as { id: string } | undefined)?.id ?? null;
  }
}

function toStored(row: LogRow): StoredEvent {
  return freeze<StoredEvent>({
    seq: row.seq,
    at: row.at,
    event: JSON.parse(row.event) as TaskEvent,
  });
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
