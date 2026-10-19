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
  type StoredEvent,
  type TaskEvent,
  type TaskId,
  type TaskMode,
  type TaskRecord,
  type TaskView,
} from './types.js';

export const DEFAULT_WAIT_MS = 60_000;
export const MAX_WAIT_MS = 10 * 60_000;
export const DEFAULT_MAX_DEPTH = 5;
export const DEFAULT_ORPHAN_STOP_TIMEOUT_MS = 10_000;
const MAX_TITLE_LENGTH = 200;
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
}

export interface DelegateInput {
  runner: string;
  brief: string;
  title?: string;
  mode?: TaskMode;
  timeoutMs?: number;
}

export class Orchestrator {
  private readonly store: TaskStore;
  private readonly runners: RunnerRegistry;
  private readonly handoff: Handoff;
  private readonly now: () => number;
  private readonly maxDepth: number;
  private readonly orphanStopTimeoutMs: number;
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
  private readonly executorSessions = new Map<TaskId, SessionId>();
  private readonly waiters = new Map<TaskId, Set<() => void>>();
  private readonly background = new Set<Promise<void>>();
  private readonly cancelling = new Map<TaskId, Promise<void>>();
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
    // A wait-mode delegate holds its wait slot from the start, so it is refused
    // before a task is created rather than after.
    const releaseWait = mode === 'wait' ? this.acquireWait(session) : undefined;
    try {
      return await this.delegateTask(session, input, mode, signal);
    } finally {
      releaseWait?.();
    }
  }

  private async delegateTask(
    session: SessionInfo,
    input: DelegateInput,
    mode: TaskMode,
    signal: AbortSignal | undefined,
  ): Promise<TaskView> {
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
    // Fail early under overload; the check that counts is the one in the write chain below.
    this.assertTaskQuota(rootSessionId);
    const taskId = this.newTaskId();
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
        },
        () => {
          this.assertSessionActive(session);
          if (parent !== undefined) this.assertParentActive(parent);
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
    if (mode === 'wait') return await this.waitView(taskId, input.timeoutMs, signal);
    return this.view(taskId);
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
    await this.cancelTree(taskId, session.sessionId, session);
    return this.view(taskId);
  }

  private async cancelTree(
    rootId: TaskId,
    by: SessionId | 'system',
    session?: SessionInfo,
  ): Promise<void> {
    let accepted = session === undefined;
    for (;;) {
      const targets = this.activeSubtree(rootId);
      if (targets.length === 0) return;
      // Mark everything first so nothing in the tree can start new children
      // while the tree is being torn down.
      for (const { task } of targets) {
        await this.record({ type: 'task_cancel_requested', taskId: task.taskId, by }, () => {
          if (!accepted && session) {
            this.assertSessionActive(session);
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

  private async launch(taskId: TaskId, runnerName: string, paths: HandoffPaths): Promise<void> {
    const task = this.tasks.get(taskId);
    const runner = this.runners.get(runnerName);
    if (!task || !runner || this.isStopping(taskId) || this.ancestorStopped(taskId)) return;
    const executor = this.auth.issue({ parentTaskId: taskId });
    this.executorSessions.set(taskId, executor.sessionId);
    let handle: RunHandle;
    try {
      handle = await runner.start({
        taskId,
        runner: runnerName,
        briefPath: paths.briefPath,
        resultPath: paths.resultPath,
        ...(this.endpoint === undefined
          ? {}
          : { mcp: { url: this.endpoint, token: executor.token } }),
      });
    } catch (error) {
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
      await handle.cancel().catch(() => undefined);
      return;
    }
    this.handles.set(taskId, handle);
    const started = await this.record({ type: 'task_started', taskId }, () => {
      if (this.isStopping(taskId) || this.ancestorStopped(taskId)) throw new Superseded();
    });
    // Dropped: whatever is stopping the task also holds the handle now.
    if (!started) return;
    // pump records its own failures; a store failure has nowhere left to report.
    void this.pump(taskId, handle).catch(() => undefined);
  }

  private async pump(taskId: TaskId, handle: RunHandle): Promise<void> {
    try {
      for await (const event of handle.events) {
        if (this.isStopping(taskId)) return;
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
    this.runnerOver(taskId, handle);
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
      }
    }
    await this.record({ type: 'task_cancelled', taskId });
  }

  /**
   * Records what a runner reported. Once a cancel is requested or the task has
   * ended the report is dropped, checked inside the write chain so a cancel
   * that commits in between cannot be followed by a result.
   */
  private async recordRunnerOutcome(event: TaskEvent & { taskId: TaskId }): Promise<void> {
    await this.record(event, () => {
      if (this.isStopping(event.taskId)) throw new Superseded();
    });
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
      const stored = await this.store.append(event, this.now());
      applyEvent(this.tasks, stored);
      this.afterApply(stored.event);
      return stored;
    });
    this.writeChain = written.catch(() => undefined);
    return written;
  }

  private afterApply(event: TaskEvent): void {
    const task = this.tasks.get(event.taskId);
    if (!task) return;
    if (event.type === 'task_created') {
      this.activeByRoot.add(task.rootSessionId);
      return;
    }
    if (!isTerminal(task.state)) return;
    // A handle still registered when the task ends belongs to a run nobody
    // stopped (its stream broke, say). Best effort, nothing is waiting on it.
    const handle = this.handles.get(task.taskId);
    if (handle) {
      this.handles.delete(task.taskId);
      void handle.cancel().catch(() => undefined);
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

  /**
   * Throws when the session's token was revoked. The server calls it when a tool
   * runs, since the token was only checked when the request arrived; `delegate`
   * calls it again right before it records a task.
   */
  assertSessionActive(session: SessionInfo): void {
    if (!this.auth.isActive(session.sessionId)) {
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
    // Only an ended task is immutable, which is why caching it needs no invalidation.
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
        next.push(...this.store.childrenOf(id));
      }
      level = next;
    }
    return found;
  }
}

/** Thrown by a write guard to drop an event that no longer applies. */
class Superseded extends Error {}

function isTerminalEvent(event: TaskEvent): boolean {
  return (
    event.type === 'task_succeeded' ||
    event.type === 'task_failed' ||
    event.type === 'task_cancelled'
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
