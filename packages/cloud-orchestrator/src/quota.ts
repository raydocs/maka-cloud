import { OrchestratorError } from './types.js';

export interface QuotaLimits {
  /** Tasks queued or running in one conversation's whole tree (counted by the session that started the tree). */
  maxActiveTasks: number;
  /** Tasks one tree may create within `taskWindowMs`. */
  maxTasksPerWindow: number;
  taskWindowMs: number;
  /** Blocking waits (`task_wait`, wait-mode `delegate_task`) one conductor session may hold open. */
  maxWaits: number;
  /** The same for an executor session. */
  maxExecutorWaits: number;
  /** Open MCP connections for one conductor session. */
  maxConnections: number;
  /** The same for an executor session. */
  maxExecutorConnections: number;
  /** Open MCP connections across all sessions. */
  maxTotalConnections: number;
}

export const DEFAULT_QUOTAS: QuotaLimits = {
  maxActiveTasks: 32,
  maxTasksPerWindow: 200,
  taskWindowMs: 60 * 60_000,
  maxWaits: 8,
  maxExecutorWaits: 2,
  maxConnections: 8,
  maxExecutorConnections: 2,
  maxTotalConnections: 256,
};

export function quotaExceeded(message: string): OrchestratorError {
  return new OrchestratorError('quota_exceeded', message);
}

/** Counts per key. A key whose count returns to zero is removed, so the map only holds live keys. */
export class KeyedCounter<K> {
  private readonly counts = new Map<K, number>();

  get keys(): number {
    return this.counts.size;
  }

  count(key: K): number {
    return this.counts.get(key) ?? 0;
  }

  /** Adds one unless `max` is already reached. */
  tryAcquire(key: K, max: number): boolean {
    const count = this.count(key);
    if (count >= max) return false;
    this.counts.set(key, count + 1);
    return true;
  }

  add(key: K): void {
    this.counts.set(key, this.count(key) + 1);
  }

  release(key: K): void {
    const count = this.count(key);
    if (count <= 1) this.counts.delete(key);
    else this.counts.set(key, count - 1);
  }
}
