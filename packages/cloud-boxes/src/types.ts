import type { InstaboxClient } from '@maka-cloud/instabox';

/** The part of the instabox client the pool uses; tests pass a fake with the same methods. */
export type BoxApi = Pick<
  InstaboxClient,
  | 'createMachine'
  | 'deleteMachine'
  | 'getMachine'
  | 'listMachines'
  | 'patchMachineMetadata'
  | 'waitForOperation'
>;

/** Why the pool is about to hand a box to a task for the first time since it was made. */
export type BoxUseReason = 'create' | 'restore';

export interface BoxPoolOptions {
  api: BoxApi;
  /**
   * What a new box starts from. A function so a later piece can start an invite's boxes from a
   * setup snapshot instead of the template.
   */
  source: (tenantId: string) => { templateId: string } | { snapshotId: string };
  /**
   * Whether the orchestrator still considers a task live. A box labelled with a task that is not
   * live is freed when the pool finds it (after a restart, and in `reconcile`). Required: a pool
   * that cannot tell would keep a box claimed for ever.
   */
  isTaskLive: (taskId: string) => boolean;
  /** At most this many boxes per invite. Default 3. */
  maxPerInvite?: number;
  /** How long a task may wait for a box before it fails, in ms. Default 120 000. */
  waitMs?: number;
  /** How long a learned account limit holds before the pool tries a create again, in ms. Default 600 000. */
  limitRecheckMs?: number;
  /** The conversation a task belongs to, so its next task prefers the box its earlier ones used. */
  conversationOf?: (taskId: string) => string | undefined;
  /**
   * Runs on every box before it is handed out for the first time (the egress guard goes here). When
   * it throws the box is deleted and the task gets the error: a box is never used unguarded.
   */
  beforeUse?: (machineId: string, reason: BoxUseReason) => Promise<void>;
  onWarning?: (message: string, detail?: unknown) => void;
  /** Test seams. */
  now?: () => number;
  timers?: {
    setTimeout: (callback: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
  };
}

/** A task waited `waitMs` and no box of its invite came free. */
export class NoFreeBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoFreeBoxError';
  }
}

/** A box was found or made but is not what the pool expects of it, so it was not used. */
export class BoxRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BoxRefusedError';
  }
}
