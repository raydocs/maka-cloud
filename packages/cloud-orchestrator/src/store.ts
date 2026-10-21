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
  /**
   * With a `fence`, the append is refused with `StaleEpochError` when the fenced task's latest
   * epoch is not the fence's; a `task_attempt` is refused unless its epoch is the latest plus
   * one. Both checks and the append are one atomic step, so of two writers racing for the same
   * epoch exactly one wins, and a writer that lost the task is refused at its first write.
   */
  append(event: TaskEvent, at: number, fence?: Fence): Promise<StoredEvent>;
  /** Entries with `seq` greater than `afterSeq` (all of them when omitted), in order. */
  read(afterSeq?: number): Promise<StoredEvent[]>;
  /** The log entries of one task in order; empty for an id that was never created. */
  readTask(taskId: TaskId): StoredEvent[];
  /**
   * The same entries, read a page at a time: the caller never holds the whole log of a task that
   * has run for long, and may stop reading whenever it has enough.
   */
  iterateTask(taskId: TaskId): Iterable<StoredEvent>;
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

/** The epoch a write was made under, for the task whose driver made it. */
export interface Fence {
  taskId: TaskId;
  epoch: number;
}

/** A write was refused because a newer attempt drives the task (or, for an attempt, another won the epoch). */
export class StaleEpochError extends Error {
  constructor(
    readonly taskId: TaskId,
    readonly writerEpoch: number,
    readonly currentEpoch: number,
  ) {
    super(
      `Task ${taskId} is at epoch ${currentEpoch}; a write under epoch ${writerEpoch} is stale`,
    );
    this.name = 'StaleEpochError';
  }
}

/** The check every store makes before it appends; `current` is the fenced task's latest epoch. */
export function assertEpoch(
  event: TaskEvent,
  fence: Fence | undefined,
  current: (id: TaskId) => number | undefined,
): void {
  if (event.type === 'task_attempt') {
    const latest = current(event.taskId);
    if (latest === undefined || event.epoch !== latest + 1) {
      throw new StaleEpochError(event.taskId, event.epoch, latest ?? 0);
    }
  }
  if (fence !== undefined) {
    const latest = current(fence.taskId);
    // A task the store does not know cannot be written under.
    if (latest === undefined || fence.epoch !== latest) {
      throw new StaleEpochError(fence.taskId, fence.epoch, latest ?? 0);
    }
  }
}

const TERMINAL_EVENTS: ReadonlySet<TaskEvent['type']> = new Set([
  'task_succeeded',
  'task_failed',
  'task_cancelled',
]);

interface TaskRow {
  events: StoredEvent[];
  terminal: boolean;
  epoch: number;
}

export class MemoryTaskStore implements TaskStore {
  private readonly log: StoredEvent[] = [];
  private readonly rows = new Map<TaskId, TaskRow>();
  private readonly children = new Map<TaskId, TaskId[]>();
  private readonly active = new Set<TaskId>();
  private readonly stopPending = new Set<TaskId>();
  private readonly createdByRoot = new Map<SessionId, number[]>();

  async append(event: TaskEvent, at: number, fence?: Fence): Promise<StoredEvent> {
    assertEpoch(event, fence, (id) => this.rows.get(id)?.epoch);
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

  *iterateTask(taskId: TaskId): Iterable<StoredEvent> {
    const events = this.rows.get(taskId)?.events;
    if (events) yield* events;
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
      this.rows.set(event.taskId, { events: [stored], terminal: false, epoch: 1 });
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
    if (event.type === 'task_attempt') row.epoch = event.epoch;
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
