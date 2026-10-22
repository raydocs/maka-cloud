import { createHash } from 'node:crypto';
import {
  type IssuedSession,
  MemorySessionStore,
  SessionAuth,
  type SessionInfo,
  type SessionStore,
} from './auth.js';
import { BoundedCache, type CacheLimits } from './cache.js';
import { Handoff, type HandoffPaths } from './handoff.js';
import { DEFAULT_QUOTAS, KeyedCounter, type QuotaLimits, quotaExceeded } from './quota.js';
import { applyEvent, reduce, runTimeMs, spendKey, type TaskMap, toView } from './reducer.js';
import { MAX_RESUMES_IN_A_ROW, recoveryNote, resumesInARow } from './recovery.js';
import type { Recovery, RunHandle, RunnerRegistry, RunSpec } from './runner.js';
import {
  cleanIntent,
  clipOutput,
  MAX_STEPS_PER_TASK,
  type StepIntentResult,
  type StepLog,
} from './steps.js';
import { type Fence, StaleEpochError, type TaskStore } from './store.js';
import {
  type AttemptCause,
  isTerminal,
  OrchestratorError,
  type ResultManifest,
  type SessionId,
  type SteerId,
  type SteerState,
  type StepId,
  type StopPendingCause,
  type StoredEvent,
  type TaskEvent,
  type TaskId,
  type TaskMode,
  type TaskRecord,
  type TaskState,
  type TaskView,
} from './types.js';

export const DEFAULT_WAIT_MS = 60_000;
export const MAX_WAIT_MS = 10 * 60_000;
export const DEFAULT_MAX_DEPTH = 5;
export const DEFAULT_ORPHAN_STOP_TIMEOUT_MS = 10_000;
export const DEFAULT_CONTROL_TIMEOUT_MS = 15_000;
/** How often a stop a task is owed is tried again: doubling from `firstMs`, at most `maxMs` apart. */
export const DEFAULT_STOP_RETRY = { firstMs: 5_000, maxMs: 5 * 60_000 } as const;
const MAX_TITLE_LENGTH = 200;
const MAX_KEY_LENGTH = 200;
/** Keys cancelled before their task existed, remembered so a late delegation is refused. */
const MAX_TOMBSTONES = 10_000;
/** Tasks this process was fenced out of, remembered so it writes nothing more for them. */
const MAX_FENCED = 10_000;
/**
 * What a viewer shows in place of the turn a restart cut off. Fixed text: the viewer replaces what
 * it had with it, and the agent's own words are not repeated.
 */
export const RESTART_TEXT =
  'The server restarted. The task goes on from its last finished step; the cut-off turn is not repeated here.';

/** A message to a running task: its key, its text, and how many may wait unread at once. */
const MAX_STEER_ID_LENGTH = 64;
export const MAX_STEER_CHARS = 4_000;
export const MAX_PENDING_STEERS = 20;
export const DEFAULT_ARCHIVE_CACHE: CacheLimits = { maxEntries: 512, maxBytes: 4 * 1024 * 1024 };

export interface OrchestratorOptions {
  store: TaskStore;
  runners: RunnerRegistry;
  /** Directory that holds one `<taskId>/` folder of handoff files per task. */
  handoffRoot: string;
  /**
   * Replaces the reads and writes of the handoff directory. For tests that schedule every await
   * themselves (the schedule fuzzer): restore reads the handoff, so it must be in place before
   * restore runs.
   */
  handoff?: Pick<Handoff, 'paths' | 'writeBrief' | 'discard' | 'readManifest'>;
  now?: () => number;
  /**
   * How many levels of tasks may sit below a task the caller delegated
   * directly. With 1, that task can delegate, but its children cannot.
   */
  maxDepth?: number;
  newTaskId?: () => TaskId;
  /** Where session digests live. Defaults to memory; a server that restarts supplies a durable one. */
  sessions?: SessionStore;
  quotas?: Partial<QuotaLimits>;
  caches?: {
    /** Finished tasks read back from the store. 0 entries reads the store every time. */
    archivedTasks?: CacheLimits;
    sessions?: CacheLimits;
  };
  /** How long restore waits for one runner to stop a leftover run. Default 10 s. */
  orphanStopTimeoutMs?: number;
  /** How long a pause or resume waits for the runner to answer. Default 15 s. */
  controlTimeoutMs?: number;
  /** Backoff for retrying a stop a task is owed. Default `DEFAULT_STOP_RETRY`. */
  stopRetry?: { firstMs?: number; maxMs?: number };
  /**
   * Spend an earlier process wrote down but may not have recorded (the model gateway's journal).
   * Restore records it on each task's tree before anything else, then calls `recorded`.
   */
  recoveredSpend?: RecoveredSpend;
  /**
   * When the tasks a restart resumes start running again. `automatic` (default): at the end of
   * `create`. `manual`: when the caller calls `startRestored()`, once everything a resumed run
   * needs is wired (the MCP endpoint, the tenant of each task); until then the tasks read as running.
   */
  resume?: 'automatic' | 'manual';
  /** Limits on one task on top of the budget of its tree; see `TaskLimits`. */
  limits?: Partial<TaskLimits>;
  /** Holds back top-level tasks so few trees of one group run at once; see `Admission`. */
  admission?: Admission;
}

/**
 * At most `perGroup` task trees of one group run at once. A top-level task that would make one
 * more waits as `queued`, in the order it came, with a note that says what it waits for, and
 * starts once a tree of its group has ended and nothing of it can still be running. A task that a
 * running task delegates is never held: it is that tree's own work. A task whose group is unknown
 * is not held either.
 *
 * The server's group is the invite that owns the conversation: until each task gets an account
 * of its own, every task of an invite runs on one machine as one agent account, so two trees at
 * once could read and change each other's files.
 */
export interface Admission {
  /** The group of the tree a root session starts, or undefined when it has none. */
  groupOf(rootSessionId: SessionId): string | undefined;
  perGroup: number;
}

/**
 * Limits of one task, each stopping it with a note for the user.
 * - `turnUsd`: what one run (a start, or a resume after a restart) may spend. The budget of the
 *   whole tree still applies; this is the smaller of the two for a run. Absent: no turn limit.
 * - `runMs`: how long the task may run in all, over every attempt. A restart does not give it a
 *   fresh start, and time spent paused does not count. Default 4 hours.
 */
export interface TaskLimits {
  turnUsd?: number;
  runMs: number;
}

export const DEFAULT_TASK_LIMITS: TaskLimits = { runMs: 4 * 60 * 60_000 };
/** The longest delay a timer takes; a task with more time left than this arms again when it fires. */
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface RecoveredSpend {
  /**
   * Per task, everything its runs spent in earlier processes, open reservations in full. A
   * reservation still open is a model call the process died in: `cutOffCalls` of them, charged in
   * full as `cutOffUsd` (included in `usd`) because whether the vendor billed them is unknown.
   */
  unrecorded(): ReadonlyArray<{
    taskId: TaskId;
    /**
     * The attempt (epoch) whose grants spent it: its figure replaces what that attempt's live
     * reports gave, however often it is read. Absent for spend written before attempts were kept.
     */
    attempt?: number;
    usd: number;
    cutOffCalls?: number;
    cutOffUsd?: number;
  }>;
  /** Called once all of it is in the task log. */
  recorded(): void;
}

/**
 * A caller that acts for a whole conversation without holding one of its session
 * tokens: the server's public API, after it checked the user's own credential.
 */
export interface OperatorAccess {
  /** The conversation's session: the operator reaches the tree it started and nothing else. */
  sessionId: SessionId;
  /**
   * Runs in the write chain right before the first event of a request is appended,
   * so a credential revoked in between is refused. Throws to refuse.
   */
  authorize(): void;
}

/** Sizes of the structures that must stay bounded, for tests and diagnostics. */
export interface OrchestratorStats {
  /** Tasks held in memory: only those not yet ended. */
  activeTasks: number;
  archivedCached: number;
  archivedCachedBytes: number;
  sessionsCached: number;
  /** Task ids with at least one pending wait. */
  waitedTasks: number;
  /** Sessions holding a wait slot. */
  sessionsWaiting: number;
  /** Trees counted against the active-task quota. */
  treesCounted: number;
  connectionSessions: number;
  /** Tasks whose owed stop, or the cancel of a run that cannot be stopped by id, is being retried. */
  stopRetries: number;
  /** Running tasks with a run-time timer set. */
  runClocks: number;
  /** Top-level tasks waiting for their group to have room (see `Admission`). */
  heldTasks: number;
}

export interface DelegateInput {
  runner: string;
  brief: string;
  title?: string;
  mode?: TaskMode;
  timeoutMs?: number;
  /**
   * Dollar cap for the tree this task starts. Honoured for a root session only: a task an
   * executor delegates shares the cap of the tree it is in.
   */
  budgetUsd?: number;
  /**
   * Makes the delegation idempotent per session: the task id is derived from the key, a repeat
   * returns the task the first call created, and `cancelByKey` can stop it without ever having
   * seen its id.
   */
  idempotencyKey?: string;
}

export class Orchestrator {
  private readonly store: TaskStore;
  private readonly runners: RunnerRegistry;
  private readonly handoff: Pick<Handoff, 'paths' | 'writeBrief' | 'discard' | 'readManifest'>;
  private readonly now: () => number;
  private readonly maxDepth: number;
  private readonly orphanStopTimeoutMs: number;
  private readonly recoveredSpend: RecoveredSpend | undefined;
  private readonly controlTimeoutMs: number;
  private readonly stopRetry: { firstMs: number; maxMs: number };
  private readonly newTaskId: () => TaskId;
  private readonly auth: SessionAuth;
  private readonly quotas: QuotaLimits;
  /** Tasks that have not ended. A task leaves this map on its terminal event and is read from the store after that. */
  private tasks: TaskMap = new Map();
  private readonly archive: BoundedCache<TaskId, TaskRecord>;
  private readonly activeByRoot = new KeyedCounter<SessionId>();
  private readonly waitsBySession = new KeyedCounter<SessionId>();
  private readonly connectionsBySession = new KeyedCounter<SessionId>();
  private openConnections = 0;
  private readonly handles = new Map<TaskId, RunHandle>();
  /** Tasks whose runner start has not been handed off yet: a run may still appear for them. */
  private readonly starting = new Set<TaskId>();
  /** Retries of owed stops, one per task, until the runner confirms or `close`. */
  private readonly stopRetries = new Map<TaskId, AbortController>();
  /**
   * Runs whose cancel failed on a runner that cannot stop by id: nothing durable
   * can be owed for them, so their handle's cancel is retried here, and the task
   * reads as still running until it succeeds.
   */
  private readonly cancelRetries = new Map<TaskId, AbortController>();
  /**
   * Runs whose stream is still being read, by task. What a run reports while it stops is only
   * recorded once its stream has been read to the end, so until then the tree's spend is not final.
   */
  private readonly readers = new Map<TaskId, Promise<void>>();
  private closed = false;
  /** Set when the process is closing: runs are let go, and what they still report is not recorded. */
  private detaching = false;
  private readonly executorSessions = new Map<TaskId, SessionId>();
  private readonly waiters = new Map<TaskId, Set<() => void>>();
  private readonly background = new Set<Promise<void>>();
  private readonly cancelling = new Map<TaskId, Promise<void>>();
  /** Keyed delegations being created, so a repeat waits for the first instead of writing twice. */
  private readonly keyed = new Map<TaskId, Promise<void>>();
  private readonly tombstones = new Set<TaskId>();
  /** Tasks a newer attempt (another process) took over: this process writes nothing for them. */
  private readonly fenced = new Set<TaskId>();
  private restoring = false;
  private writeChain: Promise<unknown> = Promise.resolve();
  private endpoint: string | undefined;
  /** Tasks `restore` found unfinished and ended. */
  private orphans: TaskId[] = [];
  /** Tasks `restore` found unfinished and drove again instead of ending them. */
  private resumed: TaskId[] = [];
  /** Runs `restore` decided to start again, held until `startRestored`. */
  private pendingResumes: PendingResume[] = [];
  private readonly resumeMode: 'automatic' | 'manual';
  private readonly limits: TaskLimits;
  /** The timer of each running task that ends it when its run time is used up. */
  private readonly runClocks = new Map<TaskId, NodeJS.Timeout>();
  /** The messages each run was handed, so a run is offered one once and a new run gets them all. */
  private readonly offered = new WeakMap<RunHandle, Set<SteerId>>();
  private readonly admission: Admission | undefined;
  /** Top-level tasks waiting for room in their group, oldest first. */
  private held: HeldTask[] = [];
  private readonly heldIds = new Set<TaskId>();
  private admitScheduled = false;

  private constructor(options: OrchestratorOptions) {
    this.store = options.store;
    this.runners = options.runners;
    this.handoff = options.handoff ?? new Handoff(options.handoffRoot);
    this.now = options.now ?? Date.now;
    this.quotas = { ...DEFAULT_QUOTAS, ...options.quotas };
    this.auth = new SessionAuth(
      options.sessions ?? new MemorySessionStore(),
      options.caches?.sessions,
    );
    this.archive = new BoundedCache(
      options.caches?.archivedTasks ?? DEFAULT_ARCHIVE_CACHE,
      (record) => JSON.stringify(record).length,
    );
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.orphanStopTimeoutMs = options.orphanStopTimeoutMs ?? DEFAULT_ORPHAN_STOP_TIMEOUT_MS;
    this.recoveredSpend = options.recoveredSpend;
    this.resumeMode = options.resume ?? 'automatic';
    this.limits = { ...DEFAULT_TASK_LIMITS, ...options.limits };
    if (
      !(Number.isFinite(this.limits.runMs) && this.limits.runMs > 0) ||
      (this.limits.turnUsd !== undefined &&
        !(Number.isFinite(this.limits.turnUsd) && this.limits.turnUsd > 0))
    ) {
      throw new RangeError('Task limits are positive numbers');
    }
    if (
      options.admission !== undefined &&
      !(Number.isInteger(options.admission.perGroup) && options.admission.perGroup > 0)
    ) {
      throw new RangeError('admission.perGroup is a whole number above 0');
    }
    this.admission = options.admission;
    this.controlTimeoutMs = options.controlTimeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS;
    this.stopRetry = { ...DEFAULT_STOP_RETRY, ...options.stopRetry };
    this.newTaskId =
      options.newTaskId ?? (() => `tsk_${globalThis.crypto.randomUUID().replaceAll('-', '')}`);
  }

  /** Builds the orchestrator and ends every task the store still lists as unfinished. */
  static async create(options: OrchestratorOptions): Promise<Orchestrator> {
    const orchestrator = new Orchestrator(options);
    await orchestrator.restore();
    if (orchestrator.resumeMode === 'automatic') orchestrator.startRestored();
    return orchestrator;
  }

  /** The MCP URL handed to executors so they can delegate with their own scoped token. */
  setEndpoint(url: string | undefined): void {
    this.endpoint = url;
  }

  issueSession(options: { parentTaskId?: TaskId } = {}): IssuedSession {
    return this.auth.issue(options);
  }

  revokeSession(sessionId: SessionId): void {
    this.auth.revoke(sessionId);
  }

  /** New secret for an existing session whose holder lost its token; the session keeps its tasks. */
  rotateSession(sessionId: SessionId): IssuedSession | undefined {
    return this.auth.rotate(sessionId);
  }

  /** Tasks the last `create` found unfinished and ended. Nothing runs them after a restart. */
  get orphanedTaskIds(): readonly TaskId[] {
    return this.orphans;
  }

  /**
   * Starts the runs of the tasks `create` decided to continue (all of them, once). Called by
   * `create` itself unless it was given `resume: 'manual'`. After it, a task that ends at once
   * cascades to what is below it like any other.
   */
  startRestored(): void {
    const pending = this.pendingResumes;
    this.pendingResumes = [];
    if (this.closed) return;
    for (const resume of pending) {
      const { task } = resume;
      // A top-level task that never started waits its turn again, like a new one.
      if (
        task.parentTaskId === undefined &&
        task.state === 'queued' &&
        this.queueHeld(task.taskId, task.rootSessionId, () => this.resumeRun(resume))
      ) {
        continue;
      }
      this.track(this.resumeRun(resume));
    }
    this.admit();
  }

  /**
   * Starts one restored run. `restore` decided this a while ago, and another process may have
   * taken the task over since (the plan is stale then): nothing is started until a write under
   * this attempt's epoch has been accepted, which is how ownership is proven right before the
   * spawn. Refused (or dropped for a task that is being stopped), the run is not started.
   */
  private async resumeRun(resume: PendingResume): Promise<void> {
    const { task, recovery, resumes } = resume;
    const fence: Fence = { taskId: task.taskId, epoch: task.epoch };
    const claimed = await this.record(
      {
        type: 'task_progress',
        taskId: task.taskId,
        note: `resuming after a restart (resume ${resumes} in a row)`,
      },
      () => {
        if (
          this.isStopping(task.taskId) ||
          this.ancestorStopped(task.taskId) ||
          this.overBudget(task.taskId)
        )
          throw new Superseded();
      },
      fence,
    );
    if (claimed === undefined) return;
    await this.launch(task.taskId, task.runner, this.handoff.paths(task.taskId), recovery);
  }

  /** Tasks the last `create` found unfinished and started driving again (their runner has `recover`). */
  get resumedTaskIds(): readonly TaskId[] {
    return this.resumed;
  }

  /**
   * Lets go of every run this process holds, for a process that is closing: the runs stop working
   * (their timers and pollers end at once) but nothing is cancelled and no task is ended. The task
   * logs still say `running`, and the next process resumes them as it does after a crash, only
   * without the minute of waiting to be killed. What a run reports after this is not recorded.
   */
  detachRuns(): void {
    this.detaching = true;
    for (const handle of this.handles.values()) handle.detach?.();
  }

  /**
   * Stops retrying the stops tasks are owed. The obligations stay in the log, so
   * the next process over the same store retries them.
   */
  close(): void {
    this.closed = true;
    this.pendingResumes = [];
    // A held task stays queued in the log; the next process holds it again.
    this.held = [];
    this.heldIds.clear();
    for (const retry of this.stopRetries.values()) retry.abort();
    this.stopRetries.clear();
    for (const retry of this.cancelRetries.values()) retry.abort();
    this.cancelRetries.clear();
    for (const clock of this.runClocks.values()) clearTimeout(clock);
    this.runClocks.clear();
  }

  stats(): OrchestratorStats {
    return {
      activeTasks: this.tasks.size,
      archivedCached: this.archive.size,
      archivedCachedBytes: this.archive.bytes,
      sessionsCached: this.auth.cached,
      waitedTasks: this.waiters.size,
      sessionsWaiting: this.waitsBySession.keys,
      treesCounted: this.activeByRoot.keys,
      connectionSessions: this.connectionsBySession.keys,
      stopRetries: this.stopRetries.size + this.cancelRetries.size,
      runClocks: this.runClocks.size,
      heldTasks: this.held.length,
    };
  }

  /**
   * Takes a connection slot for the session and returns the function that gives
   * it back. The MCP endpoint calls this per request and releases it when the
   * response closes.
   */
  acquireConnection(session: SessionInfo): () => void {
    const limit = this.limitFor(
      session,
      this.quotas.maxConnections,
      this.quotas.maxExecutorConnections,
    );
    if (this.openConnections >= this.quotas.maxTotalConnections) {
      throw quotaExceeded('The server has too many open connections');
    }
    if (!this.connectionsBySession.tryAcquire(session.sessionId, limit)) {
      throw quotaExceeded(`A session may hold at most ${limit} open connections`);
    }
    this.openConnections += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.openConnections -= 1;
      this.connectionsBySession.release(session.sessionId);
    };
  }

  authenticate(token: string): SessionInfo | undefined {
    return this.auth.resolve(token);
  }

  async delegate(
    session: SessionInfo,
    input: DelegateInput,
    signal?: AbortSignal,
  ): Promise<TaskView> {
    this.assertSessionActive(session);
    const mode = input.mode ?? 'async';
    if (
      input.budgetUsd !== undefined &&
      !(Number.isFinite(input.budgetUsd) && input.budgetUsd > 0)
    ) {
      throw new OrchestratorError('invalid_request', 'budgetUsd must be a positive number');
    }
    const key = input.idempotencyKey;
    if (key !== undefined && (key.length === 0 || key.length > MAX_KEY_LENGTH)) {
      throw new OrchestratorError(
        'invalid_request',
        `idempotencyKey must be 1 to ${MAX_KEY_LENGTH} characters`,
      );
    }
    // A wait-mode delegate holds its wait slot from the start, so it is refused
    // before a task is created rather than after.
    const releaseWait = mode === 'wait' ? this.acquireWait(session) : undefined;
    try {
      const taskId =
        key === undefined
          ? await this.delegateTask(session, input, mode, this.newTaskId(), false)
          : await this.delegateOnce(session, input, mode, keyedTaskId(session.sessionId, key));
      if (mode === 'wait') return await this.waitView(taskId, input.timeoutMs, signal);
      return this.view(taskId);
    } finally {
      releaseWait?.();
    }
  }

  /** A keyed delegation: the first call creates the task, every repeat gets that task. */
  private async delegateOnce(
    session: SessionInfo,
    input: DelegateInput,
    mode: TaskMode,
    taskId: TaskId,
  ): Promise<TaskId> {
    let creating = this.keyed.get(taskId);
    if (!creating) {
      if (this.lookup(taskId)) return taskId;
      const created = this.delegateTask(session, input, mode, taskId, true).then(() => undefined);
      creating = created.finally(() => this.keyed.delete(taskId));
      this.keyed.set(taskId, creating);
    }
    await creating;
    return taskId;
  }

  private async delegateTask(
    session: SessionInfo,
    input: DelegateInput,
    mode: TaskMode,
    taskId: TaskId,
    keyed: boolean,
  ): Promise<TaskId> {
    const runner = this.runners.get(input.runner);
    if (!runner) {
      throw new OrchestratorError(
        'unknown_runner',
        `Unknown runner "${input.runner}". Available: ${this.runners.names().join(', ') || 'none'}`,
      );
    }
    if (input.brief.trim() === '') {
      throw new OrchestratorError('invalid_request', 'brief must not be empty');
    }
    if (input.title !== undefined && input.title.length > MAX_TITLE_LENGTH) {
      throw new OrchestratorError('invalid_request', `title is longer than ${MAX_TITLE_LENGTH}`);
    }
    const parent = session.parentTaskId;
    if (parent !== undefined) {
      this.assertParentActive(parent);
      if (this.ancestry(parent).length > this.maxDepth) {
        throw new OrchestratorError(
          'depth_exceeded',
          `Delegation is limited to ${this.maxDepth} levels below a top-level task`,
        );
      }
    }
    const rootSessionId = this.rootSessionOf(session);
    // Fail early under overload; the checks that count are the ones in the write chain below.
    this.assertTaskQuota(rootSessionId);
    if (parent !== undefined) this.assertUnderBudget(parent);
    if (keyed) this.assertNotTombstoned(taskId);
    // Only a root session sets a tree's cap; below it, the tree's cap applies.
    const budgetUsd = parent === undefined ? input.budgetUsd : undefined;
    let paths: HandoffPaths;
    try {
      paths = await this.handoff.writeBrief(taskId, input.brief);
    } catch (error) {
      throw new OrchestratorError('invalid_request', errorMessage(error));
    }
    try {
      // The session can be revoked and a cancel or an end can land while the
      // brief is being written, so check again inside the write chain, where
      // nothing can interleave with the append.
      await this.record(
        {
          type: 'task_created',
          taskId,
          sessionId: session.sessionId,
          rootSessionId,
          ...(parent === undefined ? {} : { parentTaskId: parent }),
          runner: input.runner,
          ...(input.title === undefined ? {} : { title: input.title }),
          mode,
          ...(budgetUsd === undefined ? {} : { budgetUsd }),
          ...(keyed && input.idempotencyKey !== undefined
            ? { idempotencyKey: input.idempotencyKey }
            : {}),
        },
        () => {
          this.assertSessionActive(session);
          if (parent !== undefined) {
            this.assertParentActive(parent);
            // Spend is recorded in this chain too, so no task joins a tree whose
            // reported spend has reached its cap, even before the cancel lands.
            this.assertUnderBudget(parent);
          }
          // A cancel by key that found nothing left a tombstone, also in this chain.
          if (keyed) this.assertNotTombstoned(taskId);
          // Counting and appending happen in the same step of the chain, so
          // concurrent delegates cannot all pass at limit - 1.
          this.assertTaskQuota(rootSessionId);
        },
      );
    } catch (error) {
      if (error instanceof OrchestratorError) await this.handoff.discard(taskId);
      throw error;
    }
    const start = () => this.launch(taskId, input.runner, paths);
    if (parent === undefined && this.queueHeld(taskId, rootSessionId, start)) {
      this.admit();
      // The caller gets the task with the note that says what it waits for.
      await this.heldTask(taskId)?.noting;
    } else {
      this.track(start());
    }
    return taskId;
  }

  // Admission (see `Admission`). Which trees run is read from what may still run (as `view` reads
  // it for `treeStopPending`), not counted, so nothing can leak a slot or free one too early.

  /** Puts a top-level task at the back of its group's line. False when it has no group to wait in. */
  private queueHeld(taskId: TaskId, rootSessionId: SessionId, start: () => Promise<void>): boolean {
    if (this.admission === undefined) return false;
    const group = this.admission.groupOf(rootSessionId);
    if (group === undefined) return false;
    this.held.push({ taskId, group, start });
    this.heldIds.add(taskId);
    return true;
  }

  private heldTask(taskId: TaskId): HeldTask | undefined {
    return this.held.find((entry) => entry.taskId === taskId);
  }

  /** Runs `admit` once after whatever changed what may still run. */
  private wakeAdmission(): void {
    if (this.admitScheduled || this.held.length === 0) return;
    this.admitScheduled = true;
    queueMicrotask(() => {
      this.admitScheduled = false;
      this.admit();
    });
  }

  /**
   * Starts every held task whose group has room, oldest first, and tells the others what they
   * wait for. Synchronous: what runs is read and the start is decided in one step.
   */
  private admit(): void {
    const admission = this.admission;
    if (admission === undefined || this.closed || this.held.length === 0) return;
    const running = this.runningTrees(admission);
    const waiting = new Map<string, number>();
    const kept: HeldTask[] = [];
    for (const entry of this.held) {
      // Cancelled or ended while it waited (a cancel ends a task with no run at once).
      if (this.isStopping(entry.taskId) || this.fenced.has(entry.taskId)) {
        this.heldIds.delete(entry.taskId);
        continue;
      }
      const trees = running.get(entry.group) ?? [];
      const ahead = waiting.get(entry.group) ?? 0;
      if (ahead === 0 && trees.length < admission.perGroup) {
        this.heldIds.delete(entry.taskId);
        trees.push(this.tasks.get(entry.taskId) as TaskRecord);
        running.set(entry.group, trees);
        this.track(entry.start());
        continue;
      }
      kept.push(entry);
      waiting.set(entry.group, ahead + 1);
      const note = holdNote(admission.perGroup, trees[0]?.title, ahead);
      if (note !== entry.note) {
        entry.note = note;
        entry.noting = this.recordHoldNote(entry.taskId, note);
        this.track(entry.noting);
      }
    }
    this.held = kept;
  }

  /**
   * The top-level task of every tree that is not held and may still run something, by group,
   * oldest first: a tree with a task not ended, or one still starting, owing a stop, having its
   * cancel retried or its stream read.
   */
  private runningTrees(admission: Admission): Map<string, TaskRecord[]> {
    const roots = new Map<TaskId, TaskRecord>();
    const consider = (taskId: TaskId) => {
      if (this.fenced.has(taskId)) return;
      const root = this.treeRoot(taskId);
      if (root && !this.heldIds.has(root.taskId)) roots.set(root.taskId, root);
    };
    for (const taskId of this.tasks.keys()) consider(taskId);
    for (const taskId of this.starting) consider(taskId);
    for (const taskId of this.handles.keys()) consider(taskId);
    for (const taskId of this.readers.keys()) consider(taskId);
    for (const taskId of this.cancelRetries.keys()) consider(taskId);
    for (const taskId of this.store.stopPendingTaskIds()) consider(taskId);
    const byGroup = new Map<string, TaskRecord[]>();
    for (const root of [...roots.values()].sort((a, b) => a.createdAt - b.createdAt)) {
      const group = admission.groupOf(root.rootSessionId);
      if (group === undefined) continue;
      const trees = byGroup.get(group) ?? [];
      trees.push(root);
      byGroup.set(group, trees);
    }
    return byGroup;
  }

  /** Writes what a held task waits for, unless it started meanwhile or already says so. */
  private async recordHoldNote(taskId: TaskId, note: string): Promise<void> {
    try {
      await this.record({ type: 'task_progress', taskId, note }, () => {
        const task = this.tasks.get(taskId);
        if (
          !this.heldIds.has(taskId) ||
          task?.state !== 'queued' ||
          task.progress.at(-1) === note
        ) {
          throw new Superseded();
        }
      });
    } catch {
      // A note that could not be written changes nothing about when the task starts.
    }
  }

  status(session: SessionInfo, taskId: TaskId): TaskView {
    this.visible(session, taskId);
    return this.view(taskId);
  }

  /** An aborted `signal` (the caller's connection dropped) stops the wait; the task is left alone. */
  async wait(
    session: SessionInfo,
    taskId: TaskId,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<TaskView> {
    this.visible(session, taskId);
    // A task that already ended answers at once and needs no slot.
    if (this.isDone(taskId)) return this.view(taskId);
    const release = this.acquireWait(session);
    try {
      return await this.waitView(taskId, timeoutMs, signal);
    } finally {
      release();
    }
  }

  /**
   * Cancels the task and every descendant, children first. Terminal tasks keep
   * their state. The session is checked once, where the first cancel request is
   * accepted in the write chain; after that the cleanup runs to the end on its
   * own, even if the session is revoked.
   */
  async cancel(session: SessionInfo, taskId: TaskId): Promise<TaskView> {
    this.visible(session, taskId);
    await this.cancelTree(taskId, session.sessionId, () => this.assertSessionActive(session));
    return this.view(taskId);
  }

  /**
   * Cancels the task a keyed delegation of this session created. When none
   * exists yet, the key is remembered so that a delegation still on its way
   * is refused, and this returns undefined. The check runs in the write chain,
   * behind any create already queued there.
   */
  async cancelByKey(session: SessionInfo, key: string): Promise<TaskView | undefined> {
    this.assertSessionActive(session);
    const taskId = keyedTaskId(session.sessionId, key);
    const exists = await this.inChain(() => {
      if (this.lookup(taskId)) return true;
      this.tombstone(taskId);
      return false;
    });
    if (!exists) return undefined;
    return this.cancel(session, taskId);
  }

  /** `cancel` for the public API: the operator is checked once, in the write chain, like a session. */
  async cancelAs(access: OperatorAccess, taskId: TaskId): Promise<TaskView> {
    this.visibleToRoot(access.sessionId, taskId);
    await this.cancelTree(taskId, access.sessionId, () => {
      access.authorize();
      this.visibleToRoot(access.sessionId, taskId);
    });
    return this.view(taskId);
  }

  /**
   * Sends the user's message to the agent of a running task, for the public API (the operator is
   * checked in the write chain, like a pause). It is recorded first, once per `steerId`: a
   * resend returns the message as it stands and changes nothing. The run is handed it at once when
   * it can take one, and the agent reads it at the next safe point (after the tool call under way).
   * A new attempt of the task holds its messages back until its first step has finished. A turn
   * that makes no more calls never reads them; the task says so when it ends.
   */
  async steerAs(
    access: OperatorAccess,
    taskId: TaskId,
    input: { steerId: SteerId; text: string },
  ): Promise<{ steerId: SteerId; state: SteerState }> {
    const text = input.text.trim();
    if (!/^[A-Za-z0-9_.:-]+$/u.test(input.steerId) || input.steerId.length > MAX_STEER_ID_LENGTH) {
      throw new OrchestratorError('invalid_request', 'The message key is not valid');
    }
    if (text === '' || text.length > MAX_STEER_CHARS) {
      throw new OrchestratorError(
        'invalid_request',
        `A message is 1 to ${MAX_STEER_CHARS} characters`,
      );
    }
    this.visibleToRoot(access.sessionId, taskId);
    await this.record(
      { type: 'task_steer', taskId, steerId: input.steerId, text, by: access.sessionId },
      () => {
        access.authorize();
        const task = this.visibleToRoot(access.sessionId, taskId);
        this.assertControllable(task);
        const known = task.steers.get(input.steerId);
        if (known) {
          if (known.text !== text) {
            throw new OrchestratorError(
              'invalid_request',
              'That message key was used for other text',
            );
          }
          throw new Superseded();
        }
        if (!this.runners.get(task.runner)?.steerable) {
          throw new OrchestratorError('unsupported', 'This task cannot be sent messages');
        }
        let waiting = 0;
        for (const steer of task.steers.values()) if (steer.state === 'pending') waiting++;
        if (waiting >= MAX_PENDING_STEERS) {
          throw new OrchestratorError('quota_exceeded', 'The agent has too many unread messages');
        }
      },
    );
    this.deliverSteers(taskId);
    const steer = this.lookup(taskId)?.steers.get(input.steerId);
    return { steerId: input.steerId, state: steer?.state ?? 'unseen' };
  }

  /**
   * Takes a message back. Only one the agent has not read can be: the run is asked to drop it in
   * the write chain, and refuses when it has handed it over already.
   */
  async withdrawSteerAs(
    access: OperatorAccess,
    taskId: TaskId,
    steerId: SteerId,
  ): Promise<{ steerId: SteerId; state: SteerState }> {
    this.visibleToRoot(access.sessionId, taskId);
    await this.record({ type: 'task_steer_withdrawn', taskId, steerId }, () => {
      access.authorize();
      const task = this.visibleToRoot(access.sessionId, taskId);
      const steer = task.steers.get(steerId);
      if (!steer) throw new OrchestratorError('not_found', 'No such message');
      if (steer.state === 'withdrawn') throw new Superseded();
      if (steer.state !== 'pending') throw invalidState('The agent has already read this message');
      const handle = this.handles.get(taskId);
      if (handle && this.offered.get(handle)?.has(steerId) && !handle.unsteer?.(steerId)) {
        throw invalidState('The agent has already read this message');
      }
    });
    return { steerId, state: this.lookup(taskId)?.steers.get(steerId)?.state ?? 'withdrawn' };
  }

  /**
   * Hands the run every message it has not been offered, unless the task is paused, ending, or a
   * new attempt still holds them back. Offering is not delivery: the run reports `steered` when
   * the agent has the message, and until then it stays pending (and can be withdrawn).
   */
  private deliverSteers(taskId: TaskId): void {
    const task = this.tasks.get(taskId);
    const handle = this.handles.get(taskId);
    if (!task || !handle?.steer || task.state !== 'running' || task.steersHeld) return;
    if (this.isStopping(taskId) || this.ancestorStopped(taskId)) return;
    let offered = this.offered.get(handle);
    if (!offered) this.offered.set(handle, (offered = new Set()));
    for (const steer of task.steers.values()) {
      if (steer.state !== 'pending' || offered.has(steer.steerId)) continue;
      offered.add(steer.steerId);
      try {
        handle.steer({ steerId: steer.steerId, text: steer.text });
      } catch {
        // The run could not take it now; it stays pending, and a later event offers it again.
        offered.delete(steer.steerId);
      }
    }
  }

  /**
   * The run is ending and the agent never read these: they are marked so, and the task says how
   * many, so whoever sent them knows to send them again. Runs before the end is recorded.
   */
  private async markUnseen(taskId: TaskId, fence: Fence): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;
    const unread = [...task.steers.values()].filter((steer) => steer.state === 'pending');
    for (const steer of unread) {
      await this.record(
        { type: 'task_steer_unseen', taskId, steerId: steer.steerId },
        undefined,
        fence,
      );
    }
    if (unread.length === 0) return;
    await this.record(
      {
        type: 'task_progress',
        taskId,
        note:
          unread.length === 1
            ? 'a message sent to the agent came too late to be read: it ended without another step'
            : `${unread.length} messages sent to the agent came too late to be read: it ended without another step`,
      },
      () => {
        if (this.isStopping(taskId)) throw new Superseded();
      },
      fence,
    );
  }

  /**
   * Asks the run to hold. The request is recorded first, in the write chain with
   * every check, then the runner is asked; the task reads `paused` once it
   * answers. Asking again while it holds or is being paused changes nothing.
   */
  pauseAs(access: OperatorAccess, taskId: TaskId): Promise<TaskView> {
    return this.trackControl(this.pauseTask(access, taskId));
  }

  /** The reverse of `pauseAs`; only a task that is `paused` can be resumed. */
  resumeAs(access: OperatorAccess, taskId: TaskId): Promise<TaskView> {
    return this.trackControl(this.resumeTask(access, taskId));
  }

  private trackControl(work: Promise<TaskView>): Promise<TaskView> {
    this.track(work);
    return work;
  }

  private async pauseTask(access: OperatorAccess, taskId: TaskId): Promise<TaskView> {
    this.visibleToRoot(access.sessionId, taskId);
    let handle: RunHandle | undefined;
    const requested = await this.record(
      { type: 'task_pause_requested', taskId, by: access.sessionId },
      () => {
        access.authorize();
        const task = this.visibleToRoot(access.sessionId, taskId);
        this.assertControllable(task);
        if (task.resumeRequested) throw invalidState('The task is being resumed');
        if (task.pauseRequested) throw new Superseded();
        if (task.state !== 'running') throw invalidState('The task has not started');
        handle = this.handles.get(taskId);
        if (!handle) throw invalidState('The task is ending');
        if (!handle.pause || !handle.resume) {
          throw new OrchestratorError('unsupported', 'This task cannot be paused');
        }
      },
    );
    if (!requested || !handle) return this.view(taskId);
    const attempt = Promise.resolve().then(() => handle?.pause?.());
    try {
      await this.withControlTimeout(attempt);
    } catch (error) {
      await this.record({ type: 'task_pause_failed', taskId, reason: errorMessage(error) }, () => {
        if (this.isStopping(taskId)) throw new Superseded();
      });
      // The task now says it runs, so a pause that took effect, now or when the runner
      // finally answers, is undone. Not tracked: a runner that never answers must not hold up `settled`.
      const undo = () => Promise.resolve().then(() => handle?.resume?.());
      if (error instanceof ControlTimeout) void attempt.then(undo, undo).catch(() => undefined);
      else this.track(undo());
      throw invalidState('The task could not be paused');
    }
    await this.record({ type: 'task_paused', taskId }, () => {
      if (this.isStopping(taskId)) throw new Superseded();
    });
    return this.view(taskId);
  }

  private async resumeTask(access: OperatorAccess, taskId: TaskId): Promise<TaskView> {
    this.visibleToRoot(access.sessionId, taskId);
    let handle: RunHandle | undefined;
    const requested = await this.record(
      { type: 'task_resume_requested', taskId, by: access.sessionId },
      () => {
        access.authorize();
        const task = this.visibleToRoot(access.sessionId, taskId);
        this.assertControllable(task);
        if (task.state !== 'paused') {
          throw invalidState(
            task.pauseRequested ? 'The task is still being paused' : 'The task is not paused',
          );
        }
        if (task.resumeRequested) throw new Superseded();
        handle = this.handles.get(taskId);
        if (!handle?.resume) throw invalidState('The task is ending');
      },
    );
    if (!requested || !handle) return this.view(taskId);
    try {
      await this.withControlTimeout(Promise.resolve().then(() => handle?.resume?.()));
    } catch (error) {
      await this.record({ type: 'task_resume_failed', taskId, reason: errorMessage(error) }, () => {
        if (this.isStopping(taskId)) throw new Superseded();
      });
      throw invalidState('The task could not be resumed');
    }
    await this.record({ type: 'task_resumed', taskId }, () => {
      if (this.isStopping(taskId)) throw new Superseded();
    });
    return this.view(taskId);
  }

  /** Runs in the write chain: a task that ended or is being cancelled takes no pause or resume. */
  private assertControllable(task: TaskRecord): void {
    if (isTerminal(task.state)) throw invalidState('The task has ended');
    if (task.cancelRequestedBy !== undefined || this.ancestorStopped(task.taskId)) {
      throw invalidState('The task is being cancelled');
    }
  }

  private withControlTimeout<T>(work: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new ControlTimeout(`no answer after ${this.controlTimeoutMs} ms`)),
        this.controlTimeoutMs,
      );
    });
    return Promise.race([work, limit]).finally(() => clearTimeout(timer));
  }

  private async cancelTree(
    rootId: TaskId,
    by: SessionId | 'system',
    authorize?: () => void,
  ): Promise<void> {
    let accepted = authorize === undefined;
    for (;;) {
      const targets = this.activeSubtree(rootId);
      if (targets.length === 0) return;
      // Mark everything first so nothing in the tree can start new children
      // while the tree is being torn down.
      for (const { task } of targets) {
        await this.record({ type: 'task_cancel_requested', taskId: task.taskId, by }, () => {
          if (!accepted && authorize) {
            authorize();
            accepted = true;
          }
          if (this.isStopping(task.taskId)) throw new Superseded();
        });
      }
      targets.sort((a, b) => b.depth - a.depth);
      for (const { task } of targets) await this.cancelOne(task.taskId);
    }
  }

  /**
   * Resolves once every runner start and cascading cancel under way has been
   * handed off. A running task is not waited for. Tests and shutdown use it as
   * an explicit signal that background work is done.
   */
  async settled(): Promise<void> {
    while (this.background.size > 0) await Promise.all([...this.background]);
  }

  /** Background work records its own failures; a store failure has nowhere left to report. */
  private track(work: Promise<unknown>): void {
    const tracked: Promise<void> = work
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => this.background.delete(tracked));
    this.background.add(tracked);
  }

  private async restore(): Promise<void> {
    // Everything unfinished ends below, so no cascade is needed.
    this.restoring = true;
    // Only unfinished tasks are loaded; everything that ended stays in the store.
    for (const taskId of this.store.activeTaskIds()) {
      const task = reduce(this.store.readTask(taskId)).get(taskId);
      if (!task || isTerminal(task.state)) continue;
      this.tasks.set(taskId, task);
      this.activeByRoot.add(task.rootSessionId);
    }
    // Take every unfinished task over before anything else: from here a process that still
    // drives one of them (a restart that raced its predecessor) is refused at its next write. A
    // task another process took first is let go of, and is not ended below.
    const begun = new Map<TaskId, number>();
    for (const taskId of [...this.tasks.keys()]) {
      const epoch = await this.beginAttempt(taskId, 'restart');
      if (epoch !== undefined) {
        begun.set(taskId, epoch);
        await this.interruptOpenSteps({ taskId, epoch });
      }
    }
    await this.recordRecoveredSpend(begun);
    const orphans = [...this.tasks.values()];
    // A runner may have left work behind (a remote sandbox keeps running when we restart).
    // Stop it for every orphan at once, each bounded, so an unreachable sandbox cannot stall startup.
    const stops = await Promise.all(
      orphans.map((task) => this.stopLeftover(task, begun.get(task.taskId) ?? task.epoch)),
    );
    const toResume: PendingResume[] = [];
    for (const [index, task] of orphans.entries()) {
      const stop = stops[index] ?? 'none';
      // The stop above can take long; another process may have taken the task over meanwhile.
      // Then nothing below is this attempt's to do: not the notes, the owed stop, the credential
      // revoke or the outcome, all of which would land on the newer attempt.
      const epoch = begun.get(task.taskId);
      if (epoch === undefined || !this.holdsAttempt({ taskId: task.taskId, epoch })) {
        this.fenceOut(task.taskId);
        continue;
      }
      const fence: Fence = { taskId: task.taskId, epoch };
      // The map of executor sessions died with the process, but a durable session store still
      // holds the digests of the ones this task was given. Checked just above, with nothing
      // awaited since, so the sessions revoked are the earlier attempts'.
      this.auth.revokeForTask(task.taskId);
      if (typeof stop === 'object') {
        await this.record(
          {
            type: 'task_progress',
            taskId: task.taskId,
            note: `could not stop the leftover runner: ${stop.problem}`,
          },
          undefined,
          fence,
        );
        // Ending the task does not stop its run: the stop stays owed and is retried.
        if (!task.stopPending && !this.fenced.has(task.taskId)) {
          await this.record(
            { type: 'task_stop_pending', taskId: task.taskId, cause: 'restart' },
            undefined,
            fence,
          );
        }
      } else if (stop === 'stopped' && task.stopPending) {
        await this.record({ type: 'task_stopped', taskId: task.taskId }, undefined, fence);
      }
      if (this.fenced.has(task.taskId)) continue;
      const plan = typeof stop === 'object' ? undefined : this.resumePlan(task);
      if (plan?.kind === 'resume') {
        const resumes = plan.resumes;
        this.resumed.push(task.taskId);
        toResume.push({
          task,
          resumes,
          ...(task.state === 'queued'
            ? {}
            : { recovery: { resumes, note: recoveryNote(task.steps.values(), resumes) } }),
        });
        continue;
      }
      // Nothing is running after a restart. History is never edited, so the
      // outcome is appended. A change the runner already kept for the owner is on the handoff
      // directory, not in a process: it goes on the outcome like on any other end (read here,
      // before the write chain, as `withKept` requires).
      const ended = await this.record(
        await this.withKept(
          task.cancelRequestedBy !== undefined
            ? { type: 'task_cancelled', taskId: task.taskId }
            : {
                type: 'task_failed',
                taskId: task.taskId,
                reason:
                  plan?.kind === 'give_up'
                    ? plan.reason
                    : 'orphaned: the orchestrator restarted while this task was running',
              },
        ),
        undefined,
        fence,
      );
      if (ended !== undefined) this.orphans.push(task.taskId);
    }
    this.restoring = false;
    this.pendingResumes = toResume;
    // Ended tasks whose stop an earlier process could not confirm.
    for (const taskId of this.store.stopPendingTaskIds()) this.retryStop(taskId);
  }

  /**
   * Whether `restore` drives the task again instead of ending it. Only a task whose runner has
   * `recover`, that nobody is cancelling or pausing, and whose tree can still spend. A task that
   * was resumed `MAX_RESUMES_IN_A_ROW` times without getting anywhere is ended for the user.
   */
  private resumePlan(
    task: TaskRecord,
  ): { kind: 'resume'; resumes: number } | { kind: 'give_up'; reason: string } | undefined {
    const runner = this.runners.get(task.runner);
    // A top-level task still waiting its turn never ran: it waits again and starts like a new one,
    // whatever its runner can recover, and waiting through restarts is not a resume that got nowhere.
    const waitingTurn =
      this.admission !== undefined &&
      task.parentTaskId === undefined &&
      task.state === 'queued' &&
      isHoldNote(task.progress.at(-1));
    if (
      runner === undefined ||
      (!runner.recover && !waitingTurn) ||
      task.cancelRequestedBy !== undefined ||
      task.state === 'paused' ||
      task.pauseRequested === true ||
      this.ancestorStopped(task.taskId) ||
      this.overBudget(task.taskId)
    ) {
      return undefined;
    }
    if (this.overRunTime(task)) {
      return {
        kind: 'give_up',
        reason: `needs you: this task had used its ${formatSpan(this.limits.runMs)} of run time by the time the server came back, so it was not resumed; open it and decide whether to start it again`,
      };
    }
    const root = this.treeRoot(task.taskId);
    const costSeqs = (root ? this.store.readTask(root.taskId) : [])
      .filter(({ event }) => event.type === 'task_cost' && event.fromTaskId === task.taskId)
      .map(({ seq }) => seq);
    const resumes = resumesInARow(this.store.readTask(task.taskId), costSeqs);
    if (resumes > MAX_RESUMES_IN_A_ROW && !waitingTurn) {
      return {
        kind: 'give_up',
        reason: `needs you: this task was resumed ${MAX_RESUMES_IN_A_ROW} times in a row without finishing a step or spending anything, so it stopped; open it and decide whether to start it again`,
      };
    }
    return { kind: 'resume', resumes };
  }

  /**
   * Records what runs of an earlier process spent, before any task here ends or settles. Each row
   * is the total of one attempt of one task, and is recorded under that attempt (`task_cost` keeps
   * the highest per task and attempt, and attempts add up): it replaces the figure the run
   * reported live rather than adding to it, and recording it again (a crash after the records and
   * before `recorded()` hands the same rows to the next process) changes nothing. Spend written
   * before the journal kept attempts has none: it is booked under the attempt before the one just
   * begun, or, when the task's log holds figures from before attempts were keyed (epoch 0), under
   * that, so it replaces those too. The tree is not cancelled for it here: every task still
   * running is ended just below.
   */
  private async recordRecoveredSpend(begun: ReadonlyMap<TaskId, number>): Promise<void> {
    const recovered = this.recoveredSpend?.unrecorded() ?? [];
    for (const { taskId, attempt: spentIn, usd, cutOffCalls, cutOffUsd } of recovered) {
      if (!Number.isFinite(usd) || usd <= 0) continue;
      const root = this.treeRoot(taskId);
      if (!root) continue;
      let epoch: number;
      // A row without an attempt is booked under an attempt that depends on this process (the one
      // before the one just begun). A crash after the record and before `recorded()` hands the same
      // row to the next process, whose attempt is another: the row's id says where it went.
      // The id is a hash of the row's sum, so it holds only while no new row without an attempt is
      // written for the task (every run spec carries its epoch, so only a journal from before
      // attempts has them); two such rows with the same figures would share an id.
      const recovery =
        spentIn === undefined
          ? createHash('sha256')
              .update(JSON.stringify([taskId, usd, cutOffCalls ?? 0, cutOffUsd ?? 0]))
              .digest('hex')
          : undefined;
      const booked = recovery === undefined ? undefined : root.recoveredRows?.[recovery];
      if (booked !== undefined) {
        epoch = booked;
      } else if (spentIn !== undefined && Number.isInteger(spentIn) && spentIn >= 1) {
        epoch = spentIn;
      } else if (root.spendByRun?.[spendKey({ fromTaskId: taskId })] !== undefined) {
        epoch = 0;
      } else {
        epoch = begun.has(taskId)
          ? (begun.get(taskId) as number) - 1
          : (this.lookup(taskId)?.epoch ?? 0);
      }
      await this.record({
        type: 'task_cost',
        taskId: root.taskId,
        fromTaskId: taskId,
        costUsd: usd,
        epoch,
        ...(recovery === undefined ? {} : { recovery }),
      });
      // The calls the restart cut off are charged in full and may be made again by the run that
      // resumes; the task's log says so, under the attempt that now drives it.
      const attempt = begun.get(taskId);
      if (attempt !== undefined && cutOffCalls !== undefined && cutOffCalls > 0) {
        await this.record(
          {
            type: 'task_progress',
            taskId,
            note: `${cutOffCalls} call${cutOffCalls === 1 ? '' : 's'} to the model gateway cut off by the restart ${cutOffCalls === 1 ? 'was' : 'were'} charged in full ($${(cutOffUsd ?? 0).toFixed(2)}) because the vendor may have billed ${cutOffCalls === 1 ? 'it' : 'them'}`,
          },
          undefined,
          { taskId, epoch: attempt },
        );
      }
    }
    if (recovered.length > 0) this.recoveredSpend?.recorded();
  }

  /**
   * Stops what a runner left of the task. Only `stopped` is a confirmation; `none`
   * means its runner is registered and cannot leave work behind (it has no
   * `stopOrphaned`). A runner that is not registered is unknown, never stopped.
   */
  private async stopLeftover(task: TaskRecord, epoch?: number): Promise<LeftoverStop> {
    const runner = this.runners.get(task.runner);
    if (!runner) return { problem: 'its runner is not registered' };
    if (!runner.stopOrphaned) return 'none';
    const timeoutMs = this.orphanStopTimeoutMs;
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        runner.stopOrphaned(task.taskId, {
          signal: controller.signal,
          ...(epoch === undefined ? {} : { epoch }),
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error(`no answer after ${timeoutMs} ms`));
          }, timeoutMs);
        }),
      ]);
      return 'stopped';
    } catch (error) {
      return { problem: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
    }
  }

  /** True when the task's run is registered or starting and its runner could stop it later by id. */
  private mayStillRun(taskId: TaskId): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.stopPending) return false;
    if (!this.handles.has(taskId) && !this.starting.has(taskId)) return false;
    return this.runners.get(task.runner)?.stopOrphaned !== undefined;
  }

  /** Records that the task owes a stop, when its runner can stop it by id and it does not owe one yet. */
  private async recordStopPending(taskId: TaskId, cause: StopPendingCause): Promise<void> {
    await this.record({ type: 'task_stop_pending', taskId, cause }, () => {
      const task = this.lookup(taskId);
      if (!task || task.stopPending || !this.runners.get(task.runner)?.stopOrphaned) {
        throw new Superseded();
      }
    });
  }

  /** Clears an owed stop. Dropped unless one is owed and no start can still hand back a run. */
  private recordStopped(taskId: TaskId): Promise<StoredEvent | undefined> {
    return this.record({ type: 'task_stopped', taskId }, () => {
      if (!this.lookup(taskId)?.stopPending || this.starting.has(taskId)) throw new Superseded();
    });
  }

  /** Cancels the run of a task that ended. Until that succeeds, the task owes a stop. */
  private async cancelLeftover(taskId: TaskId, handle: RunHandle): Promise<void> {
    // Nothing durable can be owed for a run that cannot be stopped by id: the
    // task reads as still running from before the first try until one succeeds.
    if (!this.stopsById(taskId)) return this.retryCancel(taskId, handle, true);
    if (await cancelHandle(handle)) {
      await this.readerEnded(taskId);
      await this.recordStopped(taskId);
    } else await this.recordStopPending(taskId, 'cancel_failed');
  }

  private stopsById(taskId: TaskId): boolean {
    const task = this.lookup(taskId);
    return task !== undefined && this.runners.get(task.runner)?.stopOrphaned !== undefined;
  }

  /**
   * A cancel of the task's run failed. A runner that can stop by id is owed a stop,
   * in the log; any other keeps the handle, and its cancel is retried until it succeeds.
   */
  private async cancelFailed(taskId: TaskId, handle: RunHandle): Promise<void> {
    if (this.stopsById(taskId)) await this.recordStopPending(taskId, 'cancel_failed');
    else void this.retryCancel(taskId, handle, false);
  }

  /**
   * Cancels a run that cannot be stopped by id, at once when `tryNow`, then
   * backing off until a try succeeds or `close`; the task reads as still running
   * meanwhile. Resolves after the first try: later ones run on their own.
   */
  private async retryCancel(taskId: TaskId, handle: RunHandle, tryNow: boolean): Promise<void> {
    if (this.cancelRetries.has(taskId)) return;
    if (this.closed) {
      if (tryNow) await cancelHandle(handle);
      return;
    }
    const retry = new AbortController();
    this.cancelRetries.set(taskId, retry);
    const first = tryNow ? cancelHandle(handle) : Promise.resolve(false);
    void first
      .then(async (cancelled) => {
        for (let attempt = 0; !cancelled; attempt += 1) {
          await sleep(
            Math.min(this.stopRetry.firstMs * 2 ** attempt, this.stopRetry.maxMs),
            retry.signal,
          );
          if (retry.signal.aborted) return;
          cancelled = await cancelHandle(handle);
        }
      })
      .finally(() => {
        if (this.cancelRetries.get(taskId) === retry) this.cancelRetries.delete(taskId);
        this.wakeAdmission();
      });
    await first;
  }

  /** Retries the stop a task is owed, backing off, until its runner confirms it or `close`. */
  private retryStop(taskId: TaskId): void {
    if (this.closed || this.stopRetries.has(taskId)) return;
    const retry = new AbortController();
    this.stopRetries.set(taskId, retry);
    // Released in the same step as the decision to stop, so an obligation
    // recorded right after starts a retry of its own.
    const release = () => {
      if (this.stopRetries.get(taskId) === retry) this.stopRetries.delete(taskId);
    };
    void this.stopUntilConfirmed(taskId, retry.signal, release).finally(release);
  }

  private async stopUntilConfirmed(
    taskId: TaskId,
    signal: AbortSignal,
    release: () => void,
  ): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      await sleep(Math.min(this.stopRetry.firstMs * 2 ** attempt, this.stopRetry.maxMs), signal);
      if (signal.aborted) return release();
      const task = this.lookup(taskId);
      if (!task?.stopPending) return release();
      // A newer attempt (another process) drives the task: the stop is its to finish, and a run
      // or an access of its own is not this attempt's to stop.
      if (this.fenced.has(taskId)) return release();
      // A start still under way may yet hand back a run: try again after it.
      if (this.starting.has(taskId)) continue;
      try {
        // Only a confirmed stop clears the obligation: a runner that is gone or
        // can no longer stop by id leaves it owed. It stops what this attempt or an earlier one
        // started, and nothing of a later one.
        if ((await this.stopLeftover(task, task.epoch)) !== 'stopped' || signal.aborted) continue;
        await this.recordStopped(taskId);
      } catch {
        // The store failed; the obligation is still in the log, so try again.
        continue;
      }
      if (!this.lookup(taskId)?.stopPending) return release();
    }
  }

  /**
   * Starts the run of a task. With `recovery` it continues what an earlier attempt was doing
   * (`runner.recover`) instead of starting it, and the task's start is already in the log.
   */
  private async launch(
    taskId: TaskId,
    runnerName: string,
    paths: HandoffPaths,
    recovery?: Omit<Recovery, 'epoch'>,
  ): Promise<void> {
    const task = this.tasks.get(taskId);
    const runner = this.runners.get(runnerName);
    if (
      !task ||
      !runner ||
      this.isStopping(taskId) ||
      this.ancestorStopped(taskId) ||
      this.overBudget(taskId) ||
      this.overRunTime(task)
    )
      return;
    // Every write for the run carries this epoch, and a newer attempt refuses them.
    const fence: Fence = { taskId, epoch: task.epoch };
    const left = this.budgetLeft(taskId);
    const executor = this.auth.issue({ parentTaskId: taskId });
    this.executorSessions.set(taskId, executor.sessionId);
    // Until the run is registered or stopped, a task that ends owes a stop.
    this.starting.add(taskId);
    let handle: RunHandle;
    try {
      const spec: RunSpec = {
        taskId,
        runner: runnerName,
        briefPath: paths.briefPath,
        resultPath: paths.resultPath,
        steps: this.stepLog(fence),
        epoch: fence.epoch,
        ...(left === undefined
          ? {}
          : { budgetUsd: left, budgetRootId: (this.treeRoot(taskId) as TaskRecord).taskId }),
        ...(left === undefined || this.limits.turnUsd === undefined
          ? {}
          : { turnBudgetUsd: this.limits.turnUsd }),
        ...(this.endpoint === undefined
          ? {}
          : { mcp: { url: this.endpoint, token: executor.token } }),
      };
      handle =
        recovery !== undefined && runner.recover
          ? await runner.recover({ ...spec, recovery: { ...recovery, epoch: fence.epoch } })
          : await runner.start(spec);
    } catch (error) {
      this.starting.delete(taskId);
      await this.recordRunnerOutcome(
        {
          type: 'task_failed',
          taskId,
          reason:
            recovery === undefined
              ? `runner failed to start: ${errorMessage(error)}`
              : `orphaned: could not resume after a restart: ${errorMessage(error)}`,
        },
        fence,
      );
      return;
    }
    // One reader per handle, started the moment the handle exists and living as long as its
    // stream, whatever happens to this start: it records what the run spends until the stream ends,
    // and what the run reports only once its start is recorded. pump records its own failures; a
    // store failure has nowhere left to report.
    let reports!: (recorded: boolean) => void;
    const reading = this.pump(
      taskId,
      handle,
      new Promise<boolean>((resolve) => {
        reports = resolve;
      }),
      fence,
    ).catch(() => undefined);
    this.readers.set(taskId, reading);
    void reading.finally(() => {
      if (this.readers.get(taskId) === reading) this.readers.delete(taskId);
      this.wakeAdmission();
    });
    let recorded = false;
    try {
      // The hand-off. A cancel or an ended ancestor may have landed while the
      // runner was starting, and the task need not be terminal yet: a cancel in
      // progress has no handle to stop. Anything that is stopping gets the late
      // handle cancelled here, because nothing else knows about it.
      if (this.isStopping(taskId) || this.ancestorStopped(taskId)) {
        // The reader records the spend that settles during the cancel too; the cancel ends the
        // stream.
        reports(false);
        await this.cancelUnrecorded(taskId, handle, reading);
        return;
      }
      this.handles.set(taskId, handle);
      this.starting.delete(taskId);
      if (this.detaching) handle.detach?.();
      try {
        if (recovery !== undefined && this.tasks.get(taskId)?.state === 'running') {
          // A task a restart resumed started long ago: its start is in the log already. What is
          // written instead is a fenced note, which proves this attempt still owns the task now
          // the run exists: when another process took it over while the run was starting, the
          // write is refused and fencing out cancels the late run, which has written nothing yet.
          const back = await this.record(
            { type: 'task_restarted', taskId, epoch: fence.epoch, text: RESTART_TEXT },
            () => {
              if (
                this.isStopping(taskId) ||
                this.ancestorStopped(taskId) ||
                this.overBudget(taskId)
              )
                throw new Superseded();
            },
            fence,
          );
          recorded = back !== undefined;
          if (recorded) this.armRunClock(taskId);
        } else {
          const started = await this.record(
            { type: 'task_started', taskId },
            () => {
              if (
                this.isStopping(taskId) ||
                this.ancestorStopped(taskId) ||
                this.overBudget(taskId)
              )
                throw new Superseded();
            },
            fence,
          );
          // Dropped: whatever is stopping the task also holds the handle now and ends its stream;
          // the reader still records the spend the run reports until then.
          recorded = started !== undefined;
        }
        if (recorded) this.deliverSteers(taskId);
      } catch (error) {
        // The start could not be written, so nothing the run reports can be. It is stopped, unless
        // a stop already holds it, and the reader records its spend until the stream ends.
        reports(false);
        if (this.handles.get(taskId) !== handle) return;
        this.handles.delete(taskId);
        this.starting.add(taskId);
        await this.cancelUnrecorded(taskId, handle, reading);
        await this.recordRunnerOutcome(
          {
            type: 'task_failed',
            taskId,
            reason: `the run's start could not be recorded: ${errorMessage(error)}`,
          },
          fence,
        );
      }
    } finally {
      reports(recorded);
    }
  }

  /**
   * Starts a new attempt to drive the task: the next epoch, written in the write chain and
   * refused by the store when another process got there first (then this process lets go of the
   * task). Returns the epoch, or undefined when the attempt was not recorded. The first attempt is
   * the task's creation (epoch 1); this takes over a task another attempt drove, whatever its state.
   */
  private async beginAttempt(taskId: TaskId, cause: AttemptCause): Promise<number | undefined> {
    const epoch = (this.tasks.get(taskId)?.epoch ?? 0) + 1;
    const stored = await this.record({ type: 'task_attempt', taskId, epoch, cause }, () => {
      const task = this.tasks.get(taskId);
      if (!task || task.epoch + 1 !== epoch) throw new Superseded();
    });
    return stored === undefined ? undefined : epoch;
  }

  /**
   * Marks every step the previous attempt left running as interrupted, in the log, under the
   * new epoch: its driver is gone, so whether the step finished is unknown.
   */
  private async interruptOpenSteps(fence: Fence): Promise<void> {
    const open = [...(this.tasks.get(fence.taskId)?.steps.values() ?? [])].filter(
      (step) => step.state === 'running' && step.epoch < fence.epoch,
    );
    for (const step of open) {
      await this.record(
        {
          type: 'step_interrupted',
          taskId: fence.taskId,
          epoch: fence.epoch,
          stepId: step.stepId,
        },
        undefined,
        fence,
      );
    }
  }

  /** The step log one attempt's runner writes to; see `StepLog`. */
  private stepLog(fence: Fence): StepLog {
    const { taskId, epoch } = fence;
    return {
      intent: async (step) => {
        const clean = cleanIntent(step);
        if (!clean) return { status: 'refused', reason: 'not a usable step' };
        // Set by the guard, which TypeScript cannot see from here.
        let result = {
          status: 'refused',
          reason: 'the task is ending, or a newer attempt drives it',
        } as StepIntentResult;
        const stored = await this.record(
          { type: 'step_intent', taskId, epoch, ...clean },
          () => {
            const task = this.tasks.get(taskId);
            if (!task || this.isStopping(taskId)) throw new Superseded();
            const known = task.steps.get(clean.stepId);
            if (known?.state === 'running') {
              result = { status: 'running' };
              throw new Superseded();
            }
            if (known?.state === 'done' || known?.state === 'failed') {
              const output = this.stepOutput(taskId, clean.stepId);
              result = {
                status: 'completed',
                ok: known.state === 'done',
                ...(output === undefined ? {} : { output }),
              };
              throw new Superseded();
            }
            if (known?.state === 'interrupted' && known.replay === 'never') {
              result = { status: 'interrupted' };
              throw new Superseded();
            }
            if (!known && task.steps.size >= MAX_STEPS_PER_TASK) {
              result = { status: 'refused', reason: 'the task logged too many steps' };
              throw new Superseded();
            }
            result = { status: 'recorded' };
          },
          fence,
        );
        // Dropped without a verdict from the guard: the attempt was replaced or fenced out.
        if (stored === undefined && result.status === 'recorded') {
          return { status: 'refused', reason: 'a newer attempt drives this task' };
        }
        return result;
      },
      outcome: async (stepId, outcome) => {
        const output = outcome.output === undefined ? undefined : clipOutput(outcome.output);
        const stored = await this.record(
          {
            type: 'step_outcome',
            taskId,
            epoch,
            stepId,
            status: outcome.status,
            ...(output === undefined || outcome.status !== 'done' ? {} : { output }),
          },
          () => {
            const step = this.tasks.get(taskId)?.steps.get(stepId);
            // Only a step this attempt started and nobody settled; a cancel does not stop its report.
            if (step?.state !== 'running' || step.epoch !== epoch) throw new Superseded();
          },
          fence,
        );
        return stored === undefined ? 'ignored' : 'recorded';
      },
    };
  }

  /** What a finished step recorded as its output, read back from the log. */
  private stepOutput(taskId: TaskId, stepId: StepId): string | undefined {
    for (const { event } of this.store.readTask(taskId).reverse()) {
      if (event.type === 'step_outcome' && event.stepId === stepId && event.status === 'done') {
        return event.output;
      }
    }
    return undefined;
  }

  /**
   * Cancels a run whose start is not recorded. It counts as starting while the cancel is out, so a
   * task that ends meanwhile owes a stop; one that failed is owed (or, without a stop by id,
   * retried) before that is cleared.
   */
  private async cancelUnrecorded(
    taskId: TaskId,
    handle: RunHandle,
    reading: Promise<void>,
  ): Promise<void> {
    let cancelled = false;
    try {
      cancelled = await cancelHandle(handle);
      if (!cancelled) await this.cancelFailed(taskId, handle);
    } finally {
      this.starting.delete(taskId);
      this.wakeAdmission();
    }
    if (cancelled) await Promise.all([reading, this.recordStopped(taskId)]);
  }

  /**
   * Reads a run's stream to its end. Spend is recorded as it comes; everything else waits for
   * `reports`, and counts only if the run's start was recorded.
   */
  private async pump(
    taskId: TaskId,
    handle: RunHandle,
    reports: Promise<boolean>,
    fence: Fence,
  ): Promise<void> {
    try {
      for await (const event of handle.events) {
        if (event.type === 'usage') {
          if (!Number.isFinite(event.costUsd) || event.costUsd < 0) continue;
          await this.recordSpend(taskId, event.costUsd, fence);
          continue;
        }
        if (this.detaching) continue;
        if (!(await reports)) continue;
        // The outcome of a stopping task no longer counts, but its stream is read to the end:
        // the run reports what settled while it stopped.
        if (this.isStopping(taskId)) continue;
        if (event.type === 'steered') {
          await this.record(
            { type: 'task_steer_delivered', taskId, steerId: event.steerId, epoch: fence.epoch },
            undefined,
            fence,
          );
        } else if (event.type === 'progress') {
          await this.recordRunnerOutcome(
            { type: 'task_progress', taskId, note: event.note },
            fence,
          );
        } else if (event.type === 'failed') {
          this.runnerOver(taskId, handle);
          await this.markUnseen(taskId, fence);
          await this.recordRunnerOutcome(
            { type: 'task_failed', taskId, reason: event.reason },
            fence,
          );
          return;
        } else {
          this.runnerOver(taskId, handle);
          await this.markUnseen(taskId, fence);
          const result = await this.handoff.readManifest(taskId);
          await this.recordRunnerOutcome(
            result.ok
              ? { type: 'task_succeeded', taskId, manifest: result.manifest }
              : { type: 'task_failed', taskId, reason: result.reason },
            fence,
          );
          return;
        }
      }
    } catch (error) {
      if (this.detaching || !(await reports)) return;
      // The stream broke; the remote run may still be alive, so the handle
      // stays registered and is cancelled when the task ends.
      this.readers.delete(taskId);
      await this.recordRunnerOutcome(
        {
          type: 'task_failed',
          taskId,
          reason: `runner error: ${errorMessage(error)}`,
        },
        fence,
      );
      return;
    }
    if (this.detaching || !(await reports)) return;
    // A clean end of the stream does not prove the remote run stopped, so the
    // handle stays registered and is cancelled when the task ends.
    this.readers.delete(taskId);
    await this.recordRunnerOutcome(
      {
        type: 'task_failed',
        taskId,
        reason: 'runner exited without reporting a result',
      },
      fence,
    );
  }

  /** The runner reported its own end, so there is nothing left to cancel. */
  private runnerOver(taskId: TaskId, handle: RunHandle): void {
    if (this.handles.get(taskId) === handle) this.handles.delete(taskId);
    this.readers.delete(taskId);
    this.wakeAdmission();
  }

  /** Concurrent callers for one task share a single cancel. */
  private cancelOne(taskId: TaskId): Promise<void> {
    const inFlight = this.cancelling.get(taskId);
    if (inFlight) return inFlight;
    const cancelled = this.stopTask(taskId).finally(() => this.cancelling.delete(taskId));
    this.cancelling.set(taskId, cancelled);
    return cancelled;
  }

  private async stopTask(taskId: TaskId): Promise<void> {
    if (this.isDone(taskId)) return;
    const handle = this.handles.get(taskId);
    // Taken out of the map first: ending the task cancels any handle left in it.
    this.handles.delete(taskId);
    if (handle) {
      let cancelled = false;
      try {
        await handle.cancel();
        cancelled = true;
      } catch (error) {
        await this.record({
          type: 'task_progress',
          taskId,
          note: `runner cancel failed: ${errorMessage(error)}`,
        });
        // Owed before the task ends, so no restart in between can lose it.
        await this.cancelFailed(taskId, handle);
      }
      // The run reports what settled while it stopped on its stream, which closes with the cancel:
      // the task ends once that is recorded, so what it reads as costing is what the run spent.
      if (cancelled) await this.readerEnded(taskId);
    }
    await this.record(await this.withKept({ type: 'task_cancelled', taskId }));
  }

  /**
   * Resolves once the stream of the task's run has been read to the end, or after the control
   * timeout. A stream that is still open then keeps the task reading as possibly running.
   */
  private async readerEnded(taskId: TaskId): Promise<void> {
    const reading = this.readers.get(taskId);
    if (!reading) return;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.controlTimeoutMs);
    });
    try {
      await Promise.race([reading, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Records what a runner reported. Once a cancel is requested or the task has
   * ended the report is dropped, checked inside the write chain so a cancel
   * that commits in between cannot be followed by a result.
   */
  private recordRunnerOutcome(
    event: TaskEvent & { taskId: TaskId },
    fence: Fence,
  ): Promise<StoredEvent | undefined> {
    return this.withKept(event).then((withKept) =>
      this.record(
        withKept,
        () => {
          if (this.isStopping(event.taskId)) throw new Superseded();
        },
        fence,
      ),
    );
  }

  /**
   * A failed or cancelled task's event, with the change the runner kept for the owner when it left
   * one. Read before the write chain, never in it.
   */
  private async withKept<E extends TaskEvent>(event: E): Promise<E> {
    if (event.type !== 'task_failed' && event.type !== 'task_cancelled') return event;
    if (event.kept !== undefined) return event;
    const kept = await this.keptManifestOf(event.taskId);
    return kept === undefined ? event : { ...event, kept };
  }

  /**
   * Records a runner's spend on the top-level task of its tree, and cancels the
   * tree when that reaches its cap. Spend is never dropped: what settles after
   * a cancel or after the top-level task ended was still paid for.
   */
  private async recordSpend(taskId: TaskId, costUsd: number, fence?: Fence): Promise<void> {
    const root = this.treeRoot(taskId);
    if (!root) return;
    const recorded = await this.record(
      {
        type: 'task_cost',
        taskId: root.taskId,
        fromTaskId: taskId,
        costUsd,
        // The run's figure is its own attempt's: a resumed run counts from zero again.
        epoch: fence?.epoch ?? this.lookup(taskId)?.epoch ?? 0,
      },
      undefined,
      fence,
    );
    if (recorded && this.overBudget(root.taskId)) {
      this.track(this.cancelTree(root.taskId, 'system'));
    }
  }

  /** Runs `fn` in the write chain, after every append queued before it. */
  private inChain<T>(fn: () => T): Promise<T> {
    const done = this.writeChain.then(fn);
    this.writeChain = done.catch(() => undefined);
    return done;
  }

  /**
   * `guard` runs in the write chain right before the append and aborts it by
   * throwing. Throwing `Superseded` drops the event and resolves to `undefined`.
   * A terminal event for a task that already ended is always dropped, so the log
   * holds exactly one per task.
   */
  private record(
    event: TaskEvent,
    guard?: () => void,
    fence?: Fence,
  ): Promise<StoredEvent | undefined> {
    const written = this.writeChain.then(async () => {
      try {
        if (isTerminalEvent(event) && this.isDone(event.taskId)) throw new Superseded();
        if (fence !== undefined && this.fencedOut(fence)) throw new Superseded();
        guard?.();
      } catch (error) {
        if (error instanceof Superseded) return undefined;
        throw error;
      }
      // An end with a run still registered or starting does not stop that run.
      if (isTerminalEvent(event) && this.mayStillRun(event.taskId)) {
        const stop = await this.commit(
          { type: 'task_stop_pending', taskId: event.taskId, cause: 'run_live' },
          fence,
        );
        if (stop === undefined) return undefined;
      }
      return this.commit(event, fence);
    });
    this.writeChain = written.catch(() => undefined);
    return written;
  }

  /**
   * The manifest a runner left for a change it kept for the owner (a `kept:` line in `done`), read
   * from the handoff when the task ends without a result. Anything else, or a manifest that cannot
   * be read, is nothing: a failed task shows what the runner reported.
   */
  private async keptManifestOf(taskId: TaskId): Promise<ResultManifest | undefined> {
    try {
      const result = await this.handoff.readManifest(taskId);
      if (!result.ok) return undefined;
      const kept = result.manifest.done.some((line) => line.trim().startsWith('kept:'));
      return kept ? result.manifest : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Whether the store still has this attempt as the task's latest, read now (not from this
   * process's view, which only learns of a takeover at a refused write). Synchronous, so a caller
   * can act on the answer with nothing awaited in between.
   */
  private holdsAttempt(fence: Fence): boolean {
    if (this.fenced.has(fence.taskId)) return false;
    let latest = 1;
    for (const { event } of this.store.readTask(fence.taskId)) {
      if (event.type === 'task_attempt') latest = event.epoch;
    }
    return latest === fence.epoch;
  }

  /**
   * True when a write under `fence` must not go out: this process was fenced out of the task, or
   * a newer attempt of this very process replaced the one that is writing (its late events are
   * dropped, and the task is not fenced out for them).
   */
  private fencedOut(fence: Fence): boolean {
    if (this.fenced.has(fence.taskId)) return true;
    const task = this.tasks.get(fence.taskId);
    return task !== undefined && task.epoch !== fence.epoch;
  }

  /**
   * Appends and applies one event; `undefined` when the store refused it because a newer attempt
   * drives the task, after this process let go of the task. Only `record` calls it, inside the
   * write chain.
   */
  private async commit(event: TaskEvent, fence?: Fence): Promise<StoredEvent | undefined> {
    let stored: StoredEvent;
    try {
      stored = await this.store.append(event, this.now(), fence);
    } catch (error) {
      if (!(error instanceof StaleEpochError)) throw error;
      this.fenceOut(error.taskId);
      return undefined;
    }
    applyEvent(this.tasks, stored);
    this.afterApply(stored.event);
    return stored;
  }

  /**
   * Another process drives the task now. This one writes nothing more for it, stops its own run
   * (a handle only ever stops the run it started) and forgets it; the log is the other process's.
   */
  private fenceOut(taskId: TaskId): void {
    if (this.fenced.has(taskId)) return;
    this.fenced.add(taskId);
    if (this.fenced.size > MAX_FENCED) {
      const oldest = this.fenced.values().next().value;
      if (oldest !== undefined) this.fenced.delete(oldest);
    }
    this.disarmRunClock(taskId);
    const handle = this.handles.get(taskId);
    this.handles.delete(taskId);
    this.starting.delete(taskId);
    if (handle) this.track(cancelHandle(handle));
    const executor = this.executorSessions.get(taskId);
    if (executor !== undefined) {
      this.auth.revoke(executor);
      this.executorSessions.delete(taskId);
    }
    // A process that lost the task revokes only the session it issued itself: the sessions in a
    // shared store now belong to the attempt that took the task over.
    const task = this.tasks.get(taskId);
    if (task) {
      this.activeByRoot.release(task.rootSessionId);
      this.tasks.delete(taskId);
    }
    this.readers.delete(taskId);
    this.wakeAdmission();
  }

  private afterApply(event: TaskEvent): void {
    // An end or a confirmed stop may be the last of what a running tree had left.
    if (isTerminalEvent(event) || event.type === 'task_stopped') this.wakeAdmission();
    if (event.type === 'task_cost' && !this.tasks.has(event.taskId)) {
      // Spend that settled after the end changed the ended record.
      this.archive.delete(event.taskId);
      return;
    }
    if (event.type === 'task_stop_pending' || event.type === 'task_stopped') {
      // An ended task's record changed, so the cached copy is stale.
      this.archive.delete(event.taskId);
      if (event.type === 'task_stop_pending') this.retryStop(event.taskId);
      return;
    }
    const task = this.tasks.get(event.taskId);
    if (!task) return;
    if (event.type === 'task_created') {
      this.activeByRoot.add(task.rootSessionId);
      return;
    }
    if (event.type === 'task_started' || event.type === 'task_resumed') {
      this.armRunClock(task.taskId);
    } else if (event.type === 'task_paused') {
      this.disarmRunClock(task.taskId);
    }
    // A task running again, or past its attempt's first step, may take the messages held for it.
    if (event.type === 'task_resumed' || event.type === 'step_outcome') {
      this.deliverSteers(task.taskId);
    }
    if (!isTerminal(task.state)) return;
    this.disarmRunClock(task.taskId);
    // A handle still registered when the task ends belongs to a run nobody
    // stopped (its stream broke, say). The task owes its stop until this cancel
    // or a retry confirms it.
    const handle = this.handles.get(task.taskId);
    if (handle) {
      this.handles.delete(task.taskId);
      this.track(this.cancelLeftover(task.taskId, handle));
    }
    const executor = this.executorSessions.get(task.taskId);
    if (executor !== undefined) {
      this.auth.revoke(executor);
      this.executorSessions.delete(task.taskId);
    }
    const waiting = this.waiters.get(task.taskId);
    if (waiting) {
      this.waiters.delete(task.taskId);
      for (const wake of [...waiting]) wake();
    }
    // Waiters read the finished task back from the store, so it can leave memory now.
    this.activeByRoot.release(task.rootSessionId);
    this.tasks.delete(task.taskId);
    // Nothing below a task that ended may keep running.
    if (!this.restoring) this.track(this.cancelTree(task.taskId, 'system'));
  }

  private async waitView(
    taskId: TaskId,
    timeoutMs: number | undefined,
    signal?: AbortSignal,
  ): Promise<TaskView> {
    const limit = Math.min(Math.max(timeoutMs ?? DEFAULT_WAIT_MS, 0), MAX_WAIT_MS);
    const finished = await this.untilTerminal(taskId, limit, signal);
    return { ...this.view(taskId), ...(finished ? {} : { waitTimedOut: true }) };
  }

  private untilTerminal(
    taskId: TaskId,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    if (this.isDone(taskId)) return Promise.resolve(true);
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let set = this.waiters.get(taskId);
      if (!set) {
        set = new Set();
        this.waiters.set(taskId, set);
      }
      const waiting = set;
      const stop = (finished: boolean) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        waiting.delete(wake);
        if (waiting.size === 0 && this.waiters.get(taskId) === waiting) this.waiters.delete(taskId);
        resolve(finished);
      };
      const wake = () => stop(true);
      const onAbort = () => stop(false);
      const timer = setTimeout(() => stop(false), timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      waiting.add(wake);
    });
  }

  private view(taskId: TaskId): TaskView {
    const task = this.lookup(taskId);
    if (!task) throw new OrchestratorError('not_found', `Task not found: ${taskId}`);
    const view = toView(task);
    // A start still under way may yet hand back a run, whether or not its runner can stop it by
    // id, and a run whose cancel is being retried is still going.
    const mayRun =
      this.starting.has(taskId) ||
      this.cancelRetries.has(taskId) ||
      (isTerminal(task.state) && this.readers.has(taskId)) ||
      this.belowStillRuns(taskId);
    return mayRun ? { ...view, treeStopPending: true } : view;
  }

  /**
   * True when a task below `rootId` has not ended, is still starting, owes a stop, has its cancel
   * retried, or has a stream still being read.
   */
  private belowStillRuns(rootId: TaskId): boolean {
    const seen = new Set<TaskId>([rootId]);
    let level = this.store.childrenOf(rootId);
    while (level.length > 0) {
      const next: TaskId[] = [];
      for (const id of level) {
        if (seen.has(id)) continue;
        seen.add(id);
        const task = this.lookup(id);
        if (
          !task ||
          !isTerminal(task.state) ||
          task.stopPending ||
          this.starting.has(id) ||
          this.cancelRetries.has(id) ||
          this.readers.has(id)
        ) {
          return true;
        }
        next.push(...this.store.childrenOf(id));
      }
      level = next;
    }
    return false;
  }

  // Run time. A running task has a timer for the time it has left; when it fires the task is
  // stopped with a note. The time is read from the log (`runMs`), so a restart does not reset it.

  private overRunTime(task: TaskRecord): boolean {
    return runTimeMs(task, this.now()) >= this.limits.runMs;
  }

  /** (Re)sets the timer of a running task for the run time it has left. */
  private armRunClock(taskId: TaskId): void {
    this.disarmRunClock(taskId);
    const task = this.tasks.get(taskId);
    if (this.closed || this.restoring || !task || task.state !== 'running') return;
    const left = Math.max(0, this.limits.runMs - runTimeMs(task, this.now()));
    const timer = setTimeout(
      () => this.track(this.stopForRunTime(taskId)),
      Math.min(left, MAX_TIMER_MS),
    );
    timer.unref();
    this.runClocks.set(taskId, timer);
  }

  private disarmRunClock(taskId: TaskId): void {
    const timer = this.runClocks.get(taskId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.runClocks.delete(taskId);
  }

  private async stopForRunTime(taskId: TaskId): Promise<void> {
    this.runClocks.delete(taskId);
    const task = this.tasks.get(taskId);
    if (!task || task.state !== 'running' || this.isStopping(taskId)) return;
    if (!this.overRunTime(task)) {
      this.armRunClock(taskId);
      return;
    }
    // Written under this attempt's epoch: a process that lost the task stops nothing of it.
    const noted = await this.record(
      {
        type: 'task_progress',
        taskId,
        note: `stopped: the task used its ${formatSpan(this.limits.runMs)} of run time`,
      },
      () => {
        if (this.isStopping(taskId)) throw new Superseded();
      },
      { taskId, epoch: task.epoch },
    );
    if (noted !== undefined) await this.cancelTree(taskId, 'system');
  }

  // Budgets. A top-level task delegated with `budgetUsd` caps the spend its
  // whole tree reports. Spend is recorded in the write chain, so the checks
  // below see it in the same order as creates and starts.

  /** The top-level task of the tree `taskId` is in. */
  private treeRoot(taskId: TaskId): TaskRecord | undefined {
    return this.ancestry(taskId).at(-1);
  }

  /** Dollars left under the cap of the tree `taskId` is in; undefined when it has none. */
  private budgetLeft(taskId: TaskId): number | undefined {
    const root = this.treeRoot(taskId);
    if (root?.budgetUsd === undefined) return undefined;
    return roundUsd(Math.max(0, root.budgetUsd - (root.costUsd ?? 0)));
  }

  private overBudget(taskId: TaskId): boolean {
    const left = this.budgetLeft(taskId);
    return left !== undefined && left <= 0;
  }

  private assertUnderBudget(taskId: TaskId): void {
    if (this.overBudget(taskId)) {
      throw new OrchestratorError(
        'budget_exceeded',
        'The budget of this task tree is spent; it is being cancelled',
      );
    }
  }

  private assertNotTombstoned(taskId: TaskId): void {
    if (this.tombstones.has(taskId)) {
      throw new OrchestratorError('cancelled', 'This delegation was cancelled before it started');
    }
  }

  private tombstone(taskId: TaskId): void {
    this.tombstones.add(taskId);
    if (this.tombstones.size > MAX_TOMBSTONES) {
      const oldest = this.tombstones.values().next().value;
      if (oldest !== undefined) this.tombstones.delete(oldest);
    }
  }

  /**
   * Throws when the session's token was revoked. The server calls it when a tool
   * runs, since the token was only checked when the request arrived; `delegate`
   * calls it again right before it records a task.
   */
  assertSessionActive(session: SessionInfo): void {
    if (!this.auth.isActive(session)) {
      throw new OrchestratorError('unauthorized', 'The session token is no longer valid');
    }
  }

  /** No task above the caller may be cancelling or ended: its children would outlive it. */
  private assertParentActive(parent: TaskId): void {
    const chain = this.ancestry(parent);
    if (chain.some((task) => task.cancelRequestedBy !== undefined)) {
      throw new OrchestratorError('invalid_request', 'The calling task is being cancelled');
    }
    if (chain.some((task) => isTerminal(task.state))) {
      throw new OrchestratorError('invalid_request', 'The calling task has ended');
    }
  }

  /** A task above it ended or is being cancelled, so it must not run. */
  private ancestorStopped(taskId: TaskId): boolean {
    return this.ancestry(taskId)
      .slice(1)
      .some((task) => isTerminal(task.state) || task.cancelRequestedBy !== undefined);
  }

  /**
   * A task that is not in memory has ended (an id that never existed is turned
   * away by `visible` before it gets here), so these treat "not in memory" as
   * "ended". Cancel requested or ended: the runner's own outcome no longer counts.
   */
  private isStopping(taskId: TaskId): boolean {
    const task = this.tasks.get(taskId);
    return !task || task.cancelRequestedBy !== undefined;
  }

  private isDone(taskId: TaskId): boolean {
    return !this.tasks.has(taskId);
  }

  /** An unfinished task from memory, otherwise a finished one read back from the store. */
  private lookup(taskId: TaskId): TaskRecord | undefined {
    const active = this.tasks.get(taskId);
    if (active) return active;
    const cached = this.archive.get(taskId);
    if (cached) return cached;
    const events = this.store.readTask(taskId);
    if (events.length === 0) return undefined;
    const record = reduce(events).get(taskId);
    // An ended task changes only by a stop obligation or late spend, which drop it from the cache.
    if (record && isTerminal(record.state)) this.archive.set(taskId, record);
    return record;
  }

  /** The root session that owns the tree a new task from `session` joins. */
  private rootSessionOf(session: SessionInfo): SessionId {
    if (session.parentTaskId === undefined) return session.sessionId;
    return this.lookup(session.parentTaskId)?.rootSessionId ?? session.sessionId;
  }

  private assertTaskQuota(rootSessionId: SessionId): void {
    if (this.activeByRoot.count(rootSessionId) >= this.quotas.maxActiveTasks) {
      throw quotaExceeded(
        `A conversation may have at most ${this.quotas.maxActiveTasks} unfinished tasks`,
      );
    }
    const since = this.now() - this.quotas.taskWindowMs;
    if (this.store.countCreatedSince(rootSessionId, since) >= this.quotas.maxTasksPerWindow) {
      throw quotaExceeded(
        `A conversation may create at most ${this.quotas.maxTasksPerWindow} tasks per ${Math.round(this.quotas.taskWindowMs / 60_000)} minutes`,
      );
    }
  }

  private acquireWait(session: SessionInfo): () => void {
    const limit = this.limitFor(session, this.quotas.maxWaits, this.quotas.maxExecutorWaits);
    if (!this.waitsBySession.tryAcquire(session.sessionId, limit)) {
      throw quotaExceeded(`A session may hold at most ${limit} waits at a time`);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.waitsBySession.release(session.sessionId);
    };
  }

  private limitFor(session: SessionInfo, conductor: number, executor: number): number {
    return session.parentTaskId === undefined ? conductor : executor;
  }

  /** The tree a conversation's session started: every task whose root is that session. */
  private visibleToRoot(rootSessionId: SessionId, taskId: TaskId): TaskRecord {
    const task = this.lookup(taskId);
    if (!task || task.rootSessionId !== rootSessionId) {
      throw new OrchestratorError('not_found', `Task not found: ${taskId}`);
    }
    return task;
  }

  /** The conversation session whose tree holds the task, if the task exists. */
  rootSessionOfTask(taskId: TaskId): SessionId | undefined {
    return this.lookup(taskId)?.rootSessionId;
  }

  /** Where a task stands, for callers that act on it outside a session (an unknown task: undefined). */
  taskStateOf(taskId: TaskId): TaskState | undefined {
    return this.lookup(taskId)?.state;
  }

  /** A session sees tasks it created and everything beneath them, nothing else. */
  private visible(session: SessionInfo, taskId: TaskId): TaskRecord {
    const task = this.lookup(taskId);
    if (
      !task ||
      !this.ancestry(taskId).some((ancestor) => ancestor.sessionId === session.sessionId)
    ) {
      throw new OrchestratorError('not_found', `Task not found: ${taskId}`);
    }
    return task;
  }

  /** The task itself followed by its parents, nearest first. */
  private ancestry(taskId: TaskId): TaskRecord[] {
    const chain: TaskRecord[] = [];
    for (
      let current = this.lookup(taskId);
      current;
      current = current.parentTaskId === undefined ? undefined : this.lookup(current.parentTaskId)
    ) {
      chain.push(current);
    }
    return chain;
  }

  /**
   * Unfinished tasks in the subtree of `rootId` (itself included) with their
   * depth below it. It walks the store's child index, so cost follows the size
   * of this subtree, and it passes through ended tasks: an ended parent does not
   * hide its running children.
   */
  private activeSubtree(rootId: TaskId): Array<{ task: TaskRecord; depth: number }> {
    const found: Array<{ task: TaskRecord; depth: number }> = [];
    const seen = new Set<TaskId>();
    let level = [rootId];
    for (let depth = 0; level.length > 0; depth += 1) {
      const next: TaskId[] = [];
      for (const id of level) {
        if (seen.has(id)) continue;
        seen.add(id);
        const task = this.tasks.get(id);
        if (task) found.push({ task, depth });
        for (const child of this.store.childrenOf(id)) next.push(child);
      }
      level = next;
    }
    return found;
  }
}

/** The id of the task a session's keyed delegation creates: the same key always gives the same id. */
function keyedTaskId(sessionId: SessionId, key: string): TaskId {
  const digest = createHash('sha256').update(`${sessionId}\0${key}`).digest('hex');
  return `tsk_${digest.slice(0, 32)}`;
}

function roundUsd(usd: number): number {
  return Math.round(usd * 1e9) / 1e9;
}

function invalidState(message: string): OrchestratorError {
  return new OrchestratorError('invalid_state', message);
}

/** A runner did not answer a pause or resume in time. */
class ControlTimeout extends Error {}

/** Thrown by a write guard to drop an event that no longer applies. */
class Superseded extends Error {}

/** A top-level task waiting for room in its group (see `Admission`). */
interface HeldTask {
  taskId: TaskId;
  group: string;
  /** Starts its run: a first start, or the resume `restore` planned. */
  start: () => Promise<void>;
  /** The last note it was given, and the write of it. */
  note?: string;
  noting?: Promise<void>;
}

/**
 * What a held task tells its user. `title` is the oldest running tree's; `ahead` counts the tasks
 * of the group that wait before it.
 */
export function holdNote(perGroup: number, title: string | undefined, ahead: number): string {
  const rule =
    perGroup === 1
      ? 'One task runs at a time on this workspace for now.'
      : `${perGroup} tasks run at a time on this workspace for now.`;
  const others = ahead === 1 ? 'the task' : `the ${ahead} tasks`;
  if (perGroup > 1) {
    return ahead === 0
      ? `${rule} This one starts when one of them finishes.`
      : `${rule} This one starts after ${others} waiting before it.`;
  }
  const running = title === undefined || title.trim() === '' ? 'the running task' : `"${title}"`;
  return ahead === 0
    ? `${rule} This one starts when ${running} finishes.`
    : `${rule} This one starts after ${running} and ${others} waiting before it.`;
}

/** Whether a progress note is one `holdNote` wrote: the task was waiting its turn. */
export function isHoldNote(note: string | undefined): boolean {
  return (
    note !== undefined &&
    /^(?:One task runs|\d+ tasks run) at a time on this workspace for now\. /u.test(note)
  );
}

/** A run `restore` decided to start again, held until `startRestored`. */
interface PendingResume {
  task: TaskRecord;
  /** How many times in a row the task is resumed, for the note that says so. */
  resumes: number;
  recovery?: Omit<Recovery, 'epoch'>;
}

function isTerminalEvent(event: TaskEvent): boolean {
  return (
    event.type === 'task_succeeded' ||
    event.type === 'task_failed' ||
    event.type === 'task_cancelled'
  );
}

/** What stopping a task's leftover run came to; see `stopLeftover`. */
type LeftoverStop = 'stopped' | 'none' | { problem: string };

/** A cancel that throws, synchronously or not, must not stop the cleanup around it. True when it succeeded. */
function cancelHandle(handle: RunHandle): Promise<boolean> {
  return Promise.resolve()
    .then(() => handle.cancel())
    .then(
      () => true,
      () => false,
    );
}

/** A span for a note to the user: whole hours when it is, else minutes. */
function formatSpan(ms: number): string {
  const hours = ms / 3_600_000;
  if (Number.isInteger(hours)) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/** Resolves after `ms`, or at once when `signal` aborts. The timer never holds the process open. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    if (typeof timer === 'object') timer.unref();
    signal.addEventListener('abort', done, { once: true });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
