import type { SessionId, StoredEvent, TaskEvent, TaskId } from './types.js';

/**
 * Append-only task log. Implementations must assign `seq` as 1, 2, 3, ... in
 * append order and never change or remove an entry. All state is derived from
 * this log by `reduce`, so a restart over the same store restores every task.
 *
 * The same store answers the indexed lookups below, so the orchestrator keeps
 * only unfinished tasks in memory. They are synchronous because an indexed
 * point lookup in an embedded database is, and a status call must not wait on
 * I/O. An index is derived from the log (never the other way round) and must
 * change in the same step as the append that caused it.
 */
export interface TaskStore {
  append(event: TaskEvent, at: number): Promise<StoredEvent>;
  /** Entries with `seq` greater than `afterSeq` (all of them when omitted), in order. */
  read(afterSeq?: number): Promise<StoredEvent[]>;
  /** The log entries of one task in order; empty for an id that was never created. */
  readTask(taskId: TaskId): StoredEvent[];
  /** Direct children of a task in creation order, whatever their state. */
  childrenOf(taskId: TaskId): TaskId[];
  /** Tasks that have no terminal event yet. */
  activeTaskIds(): TaskId[];
  /** Every task id in the log. */
  taskIds(): Iterable<TaskId>;
  /** Tasks, ended or not, with a `task_stop_pending` and no `task_stopped` after it. */
  stopPendingTaskIds(): TaskId[];
  /** Tasks created in the tree started by `rootSessionId` at or after `sinceMs`. */
  countCreatedSince(rootSessionId: SessionId, sinceMs: number): number;
}

const TERMINAL_EVENTS: ReadonlySet<TaskEvent['type']> = new Set([
  'task_succeeded',
  'task_failed',
  'task_cancelled',
]);

interface TaskRow {
  events: StoredEvent[];
  terminal: boolean;
}

export class MemoryTaskStore implements TaskStore {
  private readonly log: StoredEvent[] = [];
  private readonly rows = new Map<TaskId, TaskRow>();
  private readonly children = new Map<TaskId, TaskId[]>();
  private readonly active = new Set<TaskId>();
  private readonly stopPending = new Set<TaskId>();
  private readonly createdByRoot = new Map<SessionId, number[]>();

  async append(event: TaskEvent, at: number): Promise<StoredEvent> {
    const stored: StoredEvent = deepFreeze({
      seq: this.log.length + 1,
      at,
      event: structuredClone(event),
    });
    this.log.push(stored);
    this.index(stored);
    return stored;
  }

  async read(afterSeq = 0): Promise<StoredEvent[]> {
    return this.log.slice(afterSeq);
  }

  readTask(taskId: TaskId): StoredEvent[] {
    return [...(this.rows.get(taskId)?.events ?? [])];
  }

  childrenOf(taskId: TaskId): TaskId[] {
    return [...(this.children.get(taskId) ?? [])];
  }

  activeTaskIds(): TaskId[] {
    return [...this.active];
  }

  taskIds(): Iterable<TaskId> {
    return [...this.rows.keys()];
  }

  stopPendingTaskIds(): TaskId[] {
    return [...this.stopPending];
  }

  countCreatedSince(rootSessionId: SessionId, sinceMs: number): number {
    return (this.createdByRoot.get(rootSessionId) ?? []).filter((at) => at >= sinceMs).length;
  }

  private index(stored: StoredEvent): void {
    const { event } = stored;
    if (event.type === 'task_created') {
      if (this.rows.has(event.taskId)) return;
      const root = event.rootSessionId ?? event.sessionId;
      this.rows.set(event.taskId, { events: [stored], terminal: false });
      this.active.add(event.taskId);
      if (event.parentTaskId !== undefined) {
        const siblings = this.children.get(event.parentTaskId) ?? [];
        siblings.push(event.taskId);
        this.children.set(event.parentTaskId, siblings);
      }
      const created = this.createdByRoot.get(root) ?? [];
      created.push(stored.at);
      this.createdByRoot.set(root, created);
      return;
    }
    const row = this.rows.get(event.taskId);
    if (!row) return;
    row.events.push(stored);
    if (event.type === 'task_stop_pending') this.stopPending.add(event.taskId);
    if (event.type === 'task_stopped') this.stopPending.delete(event.taskId);
    if (!row.terminal && TERMINAL_EVENTS.has(event.type)) {
      row.terminal = true;
      this.active.delete(event.taskId);
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
