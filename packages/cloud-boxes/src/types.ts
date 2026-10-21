import type { InstaboxClient } from '@maka-cloud/instabox';

/** The part of the instabox client the pool uses; tests pass a fake with the same methods. */
export type BoxApi = Pick<
  InstaboxClient,
  | 'createMachine'
  | 'deleteMachine'
  | 'ensureRunning'
  | 'exec'
  | 'getMachine'
  | 'listMachines'
  | 'patchMachineMetadata'
  | 'suspendMachine'
  | 'waitForOperation'
>;

/** Why the pool runs `beforeUse` on a box: it was just made, made from a snapshot, or woken. */
export type BoxUseReason = 'create' | 'restore' | 'wake';

/** A built setup snapshot a task's repository can start boxes from (see `SetupSnapshots`). */
export interface SetupChoice {
  /** Whose snapshot this is. The pool refuses a choice that names another invite than the task's. */
  tenantId: string;
  setupHash: string;
  /** `repoKey` of the repository: names the checkout directory in the box. */
  repo: string;
  snapshotId: string;
}

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
  /** When a box goes to sleep: the agent idle this long and nobody looking. Default 5 and 20 minutes. */
  idle?: { agentMs?: number; userMs?: number };
  /** Limits for waking a box, in ms; a failure of one is tried again with the next. Default 60 s then 180 s. */
  wakeTimeoutsMs?: readonly number[];
  /**
   * The built setup snapshot for the task's repository, if there is one. A lookup, never a build: a
   * task must not wait for a build to get a box. A box made for the task starts from it, and a free box
   * with the same setup is preferred to one without.
   */
  setupOf?: (tenantId: string, taskId: string) => Promise<SetupChoice | undefined>;
  /** How long a box's `.agents/resume` may run, in seconds. Default 120. */
  resumeTimeoutSeconds?: number;
  /** Called when a box's `.agents/resume` failed. The box is still handed out: a failure is reported, not hidden. */
  onResumeFailure?: (machineId: string, reason: string) => void;
  /**
   * Whether anything wrote to the box in the last minute, asked right before a box is suspended. A
   * failure to tell counts as "yes": the box stays awake.
   */
  recentWrite?: (machineId: string) => Promise<boolean>;
  /**
   * When unused boxes are looked at: a lost box is tried again after `lostGraceMs` (default 30 min)
   * and deleted after `lostDeleteMs` (default 24 h); a box idle for `idleDeleteMs` is deleted (never
   * by default).
   */
  cleanup?: { lostGraceMs?: number; lostDeleteMs?: number; idleDeleteMs?: number };
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
