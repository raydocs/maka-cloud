import { type IssuedSession, SessionAuth, type SessionInfo } from './auth.js';
import { Handoff, type HandoffPaths } from './handoff.js';
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
const MAX_TITLE_LENGTH = 200;

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
  private readonly newTaskId: () => TaskId;
  private readonly auth = new SessionAuth();
  private tasks: TaskMap = new Map();
  private readonly handles = new Map<TaskId, RunHandle>();
  private readonly executorSessions = new Map<TaskId, SessionId>();
  private readonly waiters = new Map<TaskId, Set<() => void>>();
  private writeChain: Promise<unknown> = Promise.resolve();
  private endpoint: string | undefined;

  private constructor(options: OrchestratorOptions) {
    this.store = options.store;
    this.runners = options.runners;
    this.handoff = new Handoff(options.handoffRoot);
    this.now = options.now ?? Date.now;
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.newTaskId =
      options.newTaskId ?? (() => `tsk_${globalThis.crypto.randomUUID().replaceAll('-', '')}`);
  }

  /** Builds the orchestrator and restores every task from the store's log. */
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

  authenticate(token: string): SessionInfo | undefined {
    return this.auth.resolve(token);
  }

  async delegate(session: SessionInfo, input: DelegateInput): Promise<TaskView> {
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
    const mode = input.mode ?? 'async';
    const taskId = this.newTaskId();
    let paths: HandoffPaths;
    try {
      paths = await this.handoff.writeBrief(taskId, input.brief);
    } catch (error) {
      throw new OrchestratorError('invalid_request', errorMessage(error));
    }
    try {
      // A cancel can finish while the brief is being written, so check again
      // inside the write chain, where it cannot interleave with the append.
      await this.record(
        {
          type: 'task_created',
          taskId,
          sessionId: session.sessionId,
          ...(parent === undefined ? {} : { parentTaskId: parent }),
          runner: input.runner,
          ...(input.title === undefined ? {} : { title: input.title }),
          mode,
        },
        parent === undefined ? undefined : () => this.assertParentActive(parent),
      );
    } catch (error) {
      if (error instanceof OrchestratorError) await this.handoff.discard(taskId);
      throw error;
    }
    // launch records its own failures; a store failure has nowhere left to report.
    void this.launch(taskId, input.runner, paths).catch(() => undefined);
    if (mode === 'wait') return this.waitView(taskId, input.timeoutMs);
    return this.view(taskId);
  }

  status(session: SessionInfo, taskId: TaskId): TaskView {
    return toView(this.visible(session, taskId));
  }

  async wait(session: SessionInfo, taskId: TaskId, timeoutMs?: number): Promise<TaskView> {
    this.visible(session, taskId);
    return this.waitView(taskId, timeoutMs);
  }

  /** Cancels the task and every descendant, children first. Terminal tasks keep their state. */
  async cancel(session: SessionInfo, taskId: TaskId): Promise<TaskView> {
    const root = this.visible(session, taskId);
    if (isTerminal(root.state)) return toView(root);
    for (;;) {
      const targets = this.subtree(taskId).filter((task) => !isTerminal(task.state));
      if (targets.length === 0) break;
      // Mark everything first so nothing in the tree can start new children
      // while the tree is being torn down.
      for (const task of targets) {
        await this.record({
          type: 'task_cancel_requested',
          taskId: task.taskId,
          by: session.sessionId,
        });
      }
      targets.sort((a, b) => this.ancestry(b.taskId).length - this.ancestry(a.taskId).length);
      for (const task of targets) await this.cancelOne(task.taskId);
    }
    return this.view(taskId);
  }

  private async restore(): Promise<void> {
    this.tasks = reduce(await this.store.read());
    for (const task of [...this.tasks.values()]) {
      if (isTerminal(task.state)) continue;
      // Nothing is running after a restart. History is never edited, so the
      // outcome is appended.
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
  }

  private async launch(taskId: TaskId, runnerName: string, paths: HandoffPaths): Promise<void> {
    const task = this.tasks.get(taskId);
    const runner = this.runners.get(runnerName);
    if (!task || isTerminal(task.state) || !runner) return;
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
      await this.record({
        type: 'task_failed',
        taskId,
        reason: `runner failed to start: ${errorMessage(error)}`,
      });
      return;
    }
    if (this.isDone(taskId)) {
      await handle.cancel().catch(() => undefined);
      return;
    }
    this.handles.set(taskId, handle);
    await this.record({ type: 'task_started', taskId });
    await this.pump(taskId, handle);
  }

  private async pump(taskId: TaskId, handle: RunHandle): Promise<void> {
    try {
      for await (const event of handle.events) {
        if (this.isStopping(taskId)) return;
        if (event.type === 'progress') {
          await this.record({ type: 'task_progress', taskId, note: event.note });
        } else if (event.type === 'failed') {
          await this.record({ type: 'task_failed', taskId, reason: event.reason });
          return;
        } else {
          const result = await this.handoff.readManifest(taskId);
          if (this.isStopping(taskId)) return;
          await this.record(
            result.ok
              ? { type: 'task_succeeded', taskId, manifest: result.manifest }
              : { type: 'task_failed', taskId, reason: result.reason },
          );
          return;
        }
      }
    } catch (error) {
      if (!this.isStopping(taskId)) {
        await this.record({
          type: 'task_failed',
          taskId,
          reason: `runner error: ${errorMessage(error)}`,
        });
      }
      return;
    }
    if (!this.isStopping(taskId)) {
      await this.record({
        type: 'task_failed',
        taskId,
        reason: 'runner exited without reporting a result',
      });
    }
  }

  private async cancelOne(taskId: TaskId): Promise<void> {
    if (this.isDone(taskId)) return;
    const handle = this.handles.get(taskId);
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

  /** `guard` runs in the write chain right before the append and aborts it by throwing. */
  private record(event: TaskEvent, guard?: () => void): Promise<StoredEvent> {
    const written = this.writeChain.then(async () => {
      guard?.();
      const stored = await this.store.append(event, this.now());
      applyEvent(this.tasks, stored);
      this.afterApply(stored.event);
      return stored;
    });
    this.writeChain = written.catch(() => undefined);
    return written;
  }

  private afterApply(event: TaskEvent): void {
    if (event.type === 'task_created') return;
    const task = this.tasks.get(event.taskId);
    if (!task || !isTerminal(task.state)) return;
    this.handles.delete(task.taskId);
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
  }

  private async waitView(taskId: TaskId, timeoutMs: number | undefined): Promise<TaskView> {
    const limit = Math.min(Math.max(timeoutMs ?? DEFAULT_WAIT_MS, 0), MAX_WAIT_MS);
    const finished = await this.untilTerminal(taskId, limit);
    return { ...this.view(taskId), ...(finished ? {} : { waitTimedOut: true }) };
  }

  private untilTerminal(taskId: TaskId, timeoutMs: number): Promise<boolean> {
    if (this.isDone(taskId)) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let set = this.waiters.get(taskId);
      if (!set) {
        set = new Set();
        this.waiters.set(taskId, set);
      }
      const waiting = set;
      const wake = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        waiting.delete(wake);
        resolve(false);
      }, timeoutMs);
      waiting.add(wake);
    });
  }

  private view(taskId: TaskId): TaskView {
    const task = this.tasks.get(taskId);
    if (!task) throw new OrchestratorError('not_found', `Task not found: ${taskId}`);
    return toView(task);
  }

  private assertParentActive(parent: TaskId): void {
    if (this.ancestry(parent).some((task) => task.cancelRequestedBy !== undefined)) {
      throw new OrchestratorError('invalid_request', 'The calling task is being cancelled');
    }
  }

  /** Ended, or a cancel is under way: the runner's own outcome no longer counts. */
  private isStopping(taskId: TaskId): boolean {
    const task = this.tasks.get(taskId);
    return !task || isTerminal(task.state) || task.cancelRequestedBy !== undefined;
  }

  private isDone(taskId: TaskId): boolean {
    const task = this.tasks.get(taskId);
    return !task || isTerminal(task.state);
  }

  /** A session sees tasks it created and everything beneath them, nothing else. */
  private visible(session: SessionInfo, taskId: TaskId): TaskRecord {
    const task = this.tasks.get(taskId);
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
      let current = this.tasks.get(taskId);
      current;
      current =
        current.parentTaskId === undefined ? undefined : this.tasks.get(current.parentTaskId)
    ) {
      chain.push(current);
    }
    return chain;
  }

  private subtree(rootId: TaskId): TaskRecord[] {
    return [...this.tasks.values()].filter((task) =>
      this.ancestry(task.taskId).some((ancestor) => ancestor.taskId === rootId),
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
