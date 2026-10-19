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
import { applyEvent, reduce, type TaskMap, toView } from './reducer.js';
import type { RunHandle, RunnerRegistry } from './runner.js';
import type { TaskStore } from './store.js';
import {
  isTerminal,
  OrchestratorError,
  type SessionId,
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
export const DEFAULT_ARCHIVE_CACHE: CacheLimits = { maxEntries: 512, maxBytes: 4 * 1024 * 1024 };

export interface OrchestratorOptions {
  store: TaskStore;
  runners: RunnerRegistry;
  /** Directory that holds one `<taskId>/` folder of handoff files per task. */
  handoffRoot: string;
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
  /** Tasks whose owed stop is being retried. */
  stopRetries: number;
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
  private readonly handoff: Handoff;
  private readonly now: () => number;
  private readonly maxDepth: number;
  private readonly orphanStopTimeoutMs: number;
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
  private closed = false;
  private readonly executorSessions = new Map<TaskId, SessionId>();
  private readonly waiters = new Map<TaskId, Set<() => void>>();
  private readonly background = new Set<Promise<void>>();
  private readonly cancelling = new Map<TaskId, Promise<void>>();
  /** Keyed delegations being created, so a repeat waits for the first instead of writing twice. */
  private readonly keyed = new Map<TaskId, Promise<void>>();
  private readonly tombstones = new Set<TaskId>();
  private restoring = false;
  private writeChain: Promise<unknown> = Promise.resolve();
  private endpoint: string | undefined;
  /** Tasks `restore` found unfinished and ended. */
  private orphans: TaskId[] = [];

  private constructor(options: OrchestratorOptions) {
    this.store = options.store;
    this.runners = options.runners;
    this.handoff = new Handoff(options.handoffRoot);
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
    this.controlTimeoutMs = options.controlTimeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS;
    this.stopRetry = { ...DEFAULT_STOP_RETRY, ...options.stopRetry };
    this.newTaskId =
      options.newTaskId ?? (() => `tsk_${globalThis.crypto.randomUUID().replaceAll('-', '')}`);
  }

  /** Builds the orchestrator and ends every task the store still lists as unfinished. */
  static async create(options: OrchestratorOptions): Promise<Orchestrator> {
    const orchestrator = new Orchestrator(options);
    await orchestrator.restore();
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
   * Stops retrying the stops tasks are owed. The obligations stay in the log, so
   * the next process over the same store retries them.
   */
  close(): void {
    this.closed = true;
    for (const retry of this.stopRetries.values()) retry.abort();
    this.stopRetries.clear();
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
      stopRetries: this.stopRetries.size,
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
    this.track(this.launch(taskId, input.runner, paths));
    return taskId;
  }

  status(session: SessionInfo, taskId: TaskId): TaskView {
    return toView(this.visible(session, taskId));
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
    const orphans = [...this.tasks.values()];
    // A runner may have left work behind (a remote sandbox keeps running when we restart).
    // Stop it for every orphan at once, each bounded, so an unreachable sandbox cannot stall startup.
    const stops = await Promise.all(orphans.map((task) => this.stopLeftover(task)));
    for (const [index, task] of orphans.entries()) {
      const problem = stops[index];
      if (problem !== undefined) {
        await this.record({
          type: 'task_progress',
          taskId: task.taskId,
          note: `could not stop the leftover runner: ${problem}`,
        });
        // Ending the task does not stop its run: the stop stays owed and is retried.
        if (!task.stopPending) {
          await this.record({ type: 'task_stop_pending', taskId: task.taskId, cause: 'restart' });
        }
      } else if (task.stopPending) {
        await this.record({ type: 'task_stopped', taskId: task.taskId });
      }
      // Nothing is running after a restart. History is never edited, so the
      // outcome is appended.
      this.orphans.push(task.taskId);
      // The map of executor sessions died with the process, but a durable
      // session store still holds the digests of the ones this task was given.
      this.auth.revokeForTask(task.taskId);
      await this.record(
        task.cancelRequestedBy !== undefined
          ? { type: 'task_cancelled', taskId: task.taskId }
          : {
              type: 'task_failed',
              taskId: task.taskId,
              reason: 'orphaned: the orchestrator restarted while this task was running',
            },
      );
    }
    this.restoring = false;
    // Ended tasks whose stop an earlier process could not confirm.
    for (const taskId of this.store.stopPendingTaskIds()) this.retryStop(taskId);
  }

  /** Resolves to a description of what went wrong, or undefined when the leftover is stopped (or none exists). */
  private async stopLeftover(task: TaskRecord): Promise<string | undefined> {
    const runner = this.runners.get(task.runner);
    if (!runner?.stopOrphaned) return undefined;
    const timeoutMs = this.orphanStopTimeoutMs;
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        runner.stopOrphaned(task.taskId, { signal: controller.signal }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error(`no answer after ${timeoutMs} ms`));
          }, timeoutMs);
        }),
      ]);
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
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
    if (await cancelHandle(handle)) await this.recordStopped(taskId);
    else await this.recordStopPending(taskId, 'cancel_failed');
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
      // A start still under way may yet hand back a run: try again after it.
      if (this.starting.has(taskId)) continue;
      try {
        if ((await this.stopLeftover(task)) !== undefined || signal.aborted) continue;
        await this.recordStopped(taskId);
      } catch {
        // The store failed; the obligation is still in the log, so try again.
        continue;
      }
      if (!this.lookup(taskId)?.stopPending) return release();
    }
  }

  private async launch(taskId: TaskId, runnerName: string, paths: HandoffPaths): Promise<void> {
    const task = this.tasks.get(taskId);
    const runner = this.runners.get(runnerName);
    if (
      !task ||
      !runner ||
      this.isStopping(taskId) ||
      this.ancestorStopped(taskId) ||
      this.overBudget(taskId)
    )
      return;
    const left = this.budgetLeft(taskId);
    const executor = this.auth.issue({ parentTaskId: taskId });
    this.executorSessions.set(taskId, executor.sessionId);
    // Until the run is registered or stopped, a task that ends owes a stop.
    this.starting.add(taskId);
    let handle: RunHandle;
    try {
      handle = await runner.start({
        taskId,
        runner: runnerName,
        briefPath: paths.briefPath,
        resultPath: paths.resultPath,
        ...(left === undefined
          ? {}
          : { budgetUsd: left, budgetRootId: (this.treeRoot(taskId) as TaskRecord).taskId }),
        ...(this.endpoint === undefined
          ? {}
          : { mcp: { url: this.endpoint, token: executor.token } }),
      });
    } catch (error) {
      this.starting.delete(taskId);
      await this.recordRunnerOutcome({
        type: 'task_failed',
        taskId,
        reason: `runner failed to start: ${errorMessage(error)}`,
      });
      return;
    }
    // The hand-off. A cancel or an ended ancestor may have landed while the
    // runner was starting, and the task need not be terminal yet: a cancel in
    // progress has no handle to stop. Anything that is stopping gets the late
    // handle cancelled here, because nothing else knows about it.
    if (this.isStopping(taskId) || this.ancestorStopped(taskId)) {
      // Still counted as starting while the cancel is out, so a task that ends
      // meanwhile owes a stop. One that failed is owed before that is cleared.
      let cancelled = false;
      try {
        cancelled = await cancelHandle(handle);
        if (!cancelled) await this.recordStopPending(taskId, 'cancel_failed');
      } finally {
        this.starting.delete(taskId);
      }
      if (cancelled) await this.recordStopped(taskId);
      return;
    }
    this.handles.set(taskId, handle);
    this.starting.delete(taskId);
    const started = await this.record({ type: 'task_started', taskId }, () => {
      if (this.isStopping(taskId) || this.ancestorStopped(taskId) || this.overBudget(taskId))
        throw new Superseded();
    });
    // Dropped: whatever is stopping the task also holds the handle now.
    if (!started) return;
    // pump records its own failures; a store failure has nowhere left to report.
    void this.pump(taskId, handle).catch(() => undefined);
  }

  private async pump(taskId: TaskId, handle: RunHandle): Promise<void> {
    try {
      for await (const event of handle.events) {
        if (event.type === 'usage') {
          if (!Number.isFinite(event.costUsd) || event.costUsd < 0) continue;
          await this.recordSpend(taskId, event.costUsd);
          continue;
        }
        // The outcome of a stopping task no longer counts, but its stream is read to the end:
        // the run reports what settled while it stopped.
        if (this.isStopping(taskId)) continue;
        if (event.type === 'progress') {
          await this.recordRunnerOutcome({ type: 'task_progress', taskId, note: event.note });
        } else if (event.type === 'failed') {
          this.runnerOver(taskId, handle);
          await this.recordRunnerOutcome({ type: 'task_failed', taskId, reason: event.reason });
          return;
        } else {
          this.runnerOver(taskId, handle);
          const result = await this.handoff.readManifest(taskId);
          await this.recordRunnerOutcome(
            result.ok
              ? { type: 'task_succeeded', taskId, manifest: result.manifest }
              : { type: 'task_failed', taskId, reason: result.reason },
          );
          return;
        }
      }
    } catch (error) {
      // The stream broke; the remote run may still be alive, so the handle
      // stays registered and is cancelled when the task ends.
      await this.recordRunnerOutcome({
        type: 'task_failed',
        taskId,
        reason: `runner error: ${errorMessage(error)}`,
      });
      return;
    }
    // A clean end of the stream does not prove the remote run stopped, so the
    // handle stays registered and is cancelled when the task ends.
    await this.recordRunnerOutcome({
      type: 'task_failed',
      taskId,
      reason: 'runner exited without reporting a result',
    });
  }

  /** The runner reported its own end, so there is nothing left to cancel. */
  private runnerOver(taskId: TaskId, handle: RunHandle): void {
    if (this.handles.get(taskId) === handle) this.handles.delete(taskId);
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
      try {
        await handle.cancel();
      } catch (error) {
        await this.record({
          type: 'task_progress',
          taskId,
          note: `runner cancel failed: ${errorMessage(error)}`,
        });
        // Owed before the task ends, so no restart in between can lose it.
        await this.recordStopPending(taskId, 'cancel_failed');
      }
    }
    await this.record({ type: 'task_cancelled', taskId });
  }

  /**
   * Records what a runner reported. Once a cancel is requested or the task has
   * ended the report is dropped, checked inside the write chain so a cancel
   * that commits in between cannot be followed by a result.
   */
  private recordRunnerOutcome(
    event: TaskEvent & { taskId: TaskId },
  ): Promise<StoredEvent | undefined> {
    return this.record(event, () => {
      if (this.isStopping(event.taskId)) throw new Superseded();
    });
  }

  /**
   * Records a runner's spend on the top-level task of its tree, and cancels the
   * tree when that reaches its cap. Spend is never dropped: what settles after
   * a cancel or after the top-level task ended was still paid for.
   */
  private async recordSpend(taskId: TaskId, costUsd: number): Promise<void> {
    const root = this.treeRoot(taskId);
    if (!root) return;
    const recorded = await this.record({
      type: 'task_cost',
      taskId: root.taskId,
      fromTaskId: taskId,
      costUsd,
    });
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
  private record(event: TaskEvent, guard?: () => void): Promise<StoredEvent | undefined> {
    const written = this.writeChain.then(async () => {
      try {
        if (isTerminalEvent(event) && this.isDone(event.taskId)) throw new Superseded();
        guard?.();
      } catch (error) {
        if (error instanceof Superseded) return undefined;
        throw error;
      }
      // An end with a run still registered or starting does not stop that run.
      if (isTerminalEvent(event) && this.mayStillRun(event.taskId)) {
        await this.commit({ type: 'task_stop_pending', taskId: event.taskId, cause: 'run_live' });
      }
      return this.commit(event);
    });
    this.writeChain = written.catch(() => undefined);
    return written;
  }

  /** Appends and applies one event. Only `record` calls it, inside the write chain. */
  private async commit(event: TaskEvent): Promise<StoredEvent> {
    const stored = await this.store.append(event, this.now());
    applyEvent(this.tasks, stored);
    this.afterApply(stored.event);
    return stored;
  }

  private afterApply(event: TaskEvent): void {
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
    if (!isTerminal(task.state)) return;
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
    return toView(task);
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

function isTerminalEvent(event: TaskEvent): boolean {
  return (
    event.type === 'task_succeeded' ||
    event.type === 'task_failed' ||
    event.type === 'task_cancelled'
  );
}

/** A cancel that throws, synchronously or not, must not stop the cleanup around it. True when it succeeded. */
function cancelHandle(handle: RunHandle): Promise<boolean> {
  return Promise.resolve()
    .then(() => handle.cancel())
    .then(
      () => true,
      () => false,
    );
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
