import type { StoredEvent, TaskEvent } from './types.js';

/**
 * Append-only task log. Implementations must assign `seq` as 1, 2, 3, ... in
 * append order and never change or remove an entry. All state is derived from
 * this log by `reduce`, so a restart over the same store restores every task.
 */
export interface TaskStore {
  append(event: TaskEvent, at: number): Promise<StoredEvent>;
  /** Entries with `seq` greater than `afterSeq` (all of them when omitted), in order. */
  read(afterSeq?: number): Promise<StoredEvent[]>;
}

export class MemoryTaskStore implements TaskStore {
  private readonly log: StoredEvent[] = [];

  async append(event: TaskEvent, at: number): Promise<StoredEvent> {
    const stored: StoredEvent = deepFreeze({
      seq: this.log.length + 1,
      at,
      event: structuredClone(event),
    });
    this.log.push(stored);
    return stored;
  }

  async read(afterSeq = 0): Promise<StoredEvent[]> {
    return this.log.slice(afterSeq);
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
