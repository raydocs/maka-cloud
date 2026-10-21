import type { TaskId } from '@maka-cloud/orchestrator';
import type { SteerReceipt } from './steer-receipts.js';

/** Spend the model gateway settled for one access, request by request. */
export interface AccessMeter {
  spentUsd(): number;
  /**
   * Called after each settled request, and when a request was refused because the budget could
   * not cover it (`exhausted`). Returns the unsubscribe.
   */
  subscribe(listener: (state: { spentUsd: number; exhausted: boolean }) => void): () => void;
}

/** Credentials for one task's model calls. API keys only; there is no subscription login. */
export interface ModelAccess {
  /** Gateway base URL. Unset: the vendor's own API endpoint. */
  baseUrl?: string;
  apiKey: string;
  /**
   * The gateway's web search, called with `apiKey`. When set, the run gets it as
   * `MAKA_SEARCH_URL` and `MAKA_SEARCH_TOKEN`, for the `web-search` sandbox tool.
   */
  searchUrl?: string;
  /**
   * Called when the task ends or is cancelled. With a `meter`, it resolves once every request of
   * the access has settled, so the meter's spend after it is final.
   */
  revoke?(): Promise<void> | void;
  /**
   * The gateway's own metering of this access. When set, the run's spend and its budget stop
   * come from it, request by request, instead of from what the CLI prints.
   */
  meter?: AccessMeter;
}

export interface ModelAccessProvider {
  issue(input: {
    taskId: TaskId;
    runner: string;
    /** What the run may spend (`RunSpec.budgetUsd`). */
    budgetUsd?: number;
    /** The top-level task of the run's tree (`RunSpec.budgetRootId`). */
    budgetRootId?: TaskId;
    /** What this run alone may spend, when that is less than `budgetUsd` (`RunSpec.turnBudgetUsd`). */
    turnBudgetUsd?: number;
  }): Promise<ModelAccess>;
  /**
   * Revokes whatever was issued for `taskId`, from a process that no longer holds the
   * `ModelAccess` (called when leftovers are stopped after a restart).
   */
  revokeForTask?(taskId: TaskId): Promise<void> | void;
}

export interface SandboxLease {
  machineId: string;
  release(): Promise<void> | void;
}

/**
 * Where a task runs. A machine is never shared across tenants: the provider decides the
 * machine from `tenantId`. Tasks of one tenant share it, each in its own directory and all
 * as the same sandbox user, so one tenant's tasks can read each other's process environment.
 * The product's tenant is the invite that owns the task, so invites never share a machine.
 */
export interface SandboxProvider {
  acquire(input: { tenantId: string; taskId: TaskId }): Promise<SandboxLease>;
  /** A machine for the tenant created from a snapshot, when the original machine is gone. */
  restoreFromSnapshot?(input: {
    tenantId: string;
    taskId: TaskId;
    snapshotId: string;
  }): Promise<SandboxLease>;
  /** Every machine tasks may be running on, for finding leftovers after a restart. */
  knownMachines(): Promise<string[]> | string[];
}

/** What the runner remembers about a task so a later turn can resume it. */
export interface RunnerSessionRecord {
  taskId: TaskId;
  runner: string;
  tenantId: string;
  machineId: string;
  /** The vendor's session id, once the CLI reported it. */
  sessionId?: string;
  /** Number of CLI runs started for this task. */
  turns: number;
  /**
   * Snapshots of the machine that can restore this task, oldest first. A snapshot holds the whole
   * machine, so retention is per machine: when it evicts one, every record that pointed at it
   * is moved to the machine's newest snapshot.
   */
  snapshotIds: string[];
  /**
   * When each snapshot in `snapshotIds` was requested, by id (a stamp taken before the request, not
   * when it became ready). Orders a machine's snapshots.
   */
  snapshotAt?: Record<string, number>;
  /**
   * What was written down for each message handed to the agent in a hook's answer, before the
   * answer went out: the proof, with the kept transcript, that a message was given (see
   * `steer-receipts.ts`).
   */
  steerReceipts?: SteerReceipt[];
  updatedAt: number;
}

export interface RunnerSessionStore {
  get(taskId: TaskId): Promise<RunnerSessionRecord | undefined>;
  put(record: RunnerSessionRecord): Promise<void>;
  delete(taskId: TaskId): Promise<void>;
  list(): Promise<RunnerSessionRecord[]>;
}

/**
 * A program installed into the sandbox for the agent to run: one self-contained file (a script with
 * a shebang) put on the PATH of every run as `name`. Installed once per sandbox, again when
 * `content` changes.
 */
export interface SandboxTool {
  /** Lowercase letters, digits and dashes; not a vendor CLI's name. */
  name: string;
  content: Uint8Array | string;
}
