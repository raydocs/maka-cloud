import { AsyncLocalStorage } from 'node:async_hooks';
import { MemorySessionStore, type SessionInfo } from '../../auth.js';
import type { CacheLimits } from '../../cache.js';
import type { HandoffPaths } from '../../handoff.js';
import { DEFAULT_ARCHIVE_CACHE, type OperatorAccess, Orchestrator } from '../../orchestrator.js';
import type { QuotaLimits } from '../../quota.js';
import {
  type RunHandle,
  type Runner,
  type RunnerEvent,
  RunnerRegistry,
  type RunSpec,
} from '../../runner.js';
import { MemoryTaskStore, type TaskStore } from '../../store.js';
import {
  OrchestratorError,
  type ResultManifest,
  type SessionId,
  type StoredEvent,
  type TaskEvent,
  type TaskId,
  type TaskView,
} from '../../types.js';
import { FakeClock } from './clock.js';
import { Prng } from './prng.js';

/*
 * The schedule fuzzer. Every await the orchestrator crosses is a gate the
 * scheduler releases: store appends, runner starts, handle cancels, each pull on
 * a run's event stream (progress, finished, failed, clean end, throw) and its
 * close, brief writes, manifest reads, stops of leftover runs by task id, and
 * wait, stop-timeout and stop-retry timers through a fake clock.
 * Between gates the PRNG issues requests the way the MCP endpoint makes them:
 * delegate (async and wait, nested through executor tokens, with or without a
 * budget and an idempotency key), cancel by id or key, wait and status on any
 * task, dropped connections, revoke, rotate, new conductors and restarts over
 * the same store. Runs report cumulative spend as well as progress. The public
 * API's operator (it acts for a conversation without a session token) pauses,
 * resumes and cancels, and its credential can be revoked.
 *
 * Checked as each append is decided (right after its guard):
 * - nothing is created or started under an ancestor that ended or is being
 *   cancelled, and nothing starts after its own cancel or end;
 * - at most one terminal event per task, and a task whose cancel was requested
 *   ends cancelled;
 * - quotas hold exactly at the moment a task is created;
 * - nothing is created or started in a tree whose recorded spend reached its
 *   cap, only a top-level task carries a cap, and spend is recorded only on a
 *   top-level task, from a task of its tree (also once either is stopping or
 *   ended: what settled late was still paid for);
 * - a keyed delegation creates its task once, and never after a cancel by
 *   that key found nothing (in the same process);
 * - a revoked or rotated token commits nothing new after the revoke or rotate;
 *   a revoked operator credential commits nothing either;
 * - a pause is requested once, only for a started task nothing is stopping, and
 *   pause and resume results are only recorded for an open request on a task
 *   that is not being cancelled;
 * - a task never ends while a run of it may still be live (not reported, not
 *   cancelled, not stopped by id, or still starting) unless it already owes a
 *   stop; a stop is owed once at a time, and cleared only when no run of the
 *   task may still be live. One seed in four runs a runner that cannot stop by
 *   id: nothing can be owed for it, so these checks give way to the next one.
 * Checked as each request returns: a view of an ended task that marks nothing
 * in its tree as still running (no owed stop, no `treeStopPending`) has no run
 * in that tree that may still be live, and every spend a run in that tree
 * reported is recorded, so its budget can be settled.
 * Checked after every step:
 * - the in-memory tasks and per-tree counts match the log's unfinished tasks,
 *   and their states (queued, running, paused) match the log;
 * - handle, waiter and executor-session maps hold no ended task;
 * - connection counts match open requests, wait slots and registered waiters
 *   never exceed waiting requests;
 * - executor tokens of ended tasks and rotated-away tokens never authenticate;
 * - every run whose task ended had cancel() called, unless it reported its own end.
 * Checked after each restore: exactly the unfinished tasks were loaded and
 * ended, and their executor tokens no longer authenticate.
 * Checked at quiescence, after settled(): one terminal event per task, every
 * request returned, no task owes a stop, every run of every process ended on
 * its own or was cancelled or stopped (of the live process only, for a runner
 * that cannot stop by id), every spend a run of the live process
 * reported is recorded, and every counter and map is back to zero.
 */

/**
 * Where finished tasks are read back from: `memory` keeps them in the default
 * archive cache, `evicting` drops them at once so every read goes to the store.
 */
export type Catalog = 'memory' | 'evicting';

/** Small enough that the quota paths are hit within one run. */
const QUOTAS: Partial<QuotaLimits> = {
  maxActiveTasks: 6,
  maxTasksPerWindow: 14,
  taskWindowMs: 5_000,
  maxWaits: 3,
  maxExecutorWaits: 1,
  maxConnections: 4,
  maxExecutorConnections: 2,
  maxTotalConnections: 10,
};
const MAX_DEPTH = 2;
const MAX_RESTARTS = 2;
const MAX_CONDUCTORS = 4;
const WAIT_TIMEOUTS = [0, 5, 100, 1_000, 30_000, undefined] as const;
/** Caps a top-level delegation may ask for; runs report spend in cents. */
const BUDGETS = [undefined, undefined, 0.5, 1, 2] as const;
/** Few keys, so repeats and cancels by key meet the same delegation. */
const KEYS = ['k1', 'k2', 'k3'] as const;
const MANIFEST: ResultManifest = {
  summary: 'fuzz run complete',
  done: ['all'],
  notDone: [],
  confidence: 'high',
  knownIssues: [],
};

type GateKind =
  | 'append'
  | 'brief'
  | 'manifest'
  | 'start'
  | 'cancel'
  | 'pause'
  | 'resume'
  | 'next'
  | 'return'
  | 'stop';

/** One await point the orchestrator is parked on. `open` lets it continue and says how. */
interface Gate {
  epoch: number;
  kind: GateKind;
  label: string;
  open: (draining: boolean) => string;
}

interface Credential {
  label: string;
  sessionId: SessionId;
  token: string;
  taskId?: TaskId;
}

/** One tool call, as the MCP endpoint would make it. */
interface Request {
  label: string;
  credential: Credential;
  /** The token the request authenticated with. */
  token: string;
  sessionId: SessionId;
  epoch: number;
  /** Takes a wait slot: task_wait, or delegate in wait mode. */
  waits: boolean;
  settled: boolean;
  /** Gives the connection slot back; unset once given back. */
  connection: (() => void) | undefined;
  abort: AbortController;
  /** For a cancel: its first request was written, so it was accepted. */
  accepted: boolean;
  /** Made through the public API's operator, which holds no session token. */
  operator?: boolean;
}

/** What the log says about one task. Built only from appends the store performed. */
interface ModelTask {
  taskId: TaskId;
  parentTaskId?: TaskId;
  sessionId: SessionId;
  rootSessionId: SessionId;
  started: boolean;
  cancelRequested: boolean;
  pauseRequested: boolean;
  paused: boolean;
  resumeRequested: boolean;
  terminals: number;
  /** A `task_stop_pending` with no `task_stopped` after it. */
  stopPending: boolean;
  createdAt: number;
  budgetUsd?: number;
  /** Cumulative spend per reporting task and attempt (`<epoch>:<taskId>`), recorded on a top-level task. */
  spend: Map<string, number>;
}

interface Internals {
  tasks: Map<TaskId, unknown>;
  handles: Map<TaskId, unknown>;
  waiters: Map<TaskId, Set<unknown>>;
  executorSessions: Map<TaskId, SessionId>;
  cancelling: Map<TaskId, unknown>;
  starting: Set<TaskId>;
  background: Set<unknown>;
  openConnections: number;
  activeByRoot: { counts: Map<SessionId, number> };
  waitsBySession: { counts: Map<SessionId, number> };
  connectionsBySession: { counts: Map<SessionId, number> };
}

function internals(orchestrator: Orchestrator): Internals {
  return orchestrator as unknown as Internals;
}

const TERMINAL: ReadonlySet<TaskEvent['type']> = new Set([
  'task_succeeded',
  'task_failed',
  'task_cancelled',
]);

/**
 * The request each append runs on behalf of. One for the module: every live
 * AsyncLocalStorage adds work to every promise, so one per run slows each run more.
 */
const requestContext = new AsyncLocalStorage<Request>();

function flush(): Promise<void> {
  // Every await the orchestrator crosses is a gate, so once the microtask queue
  // drains it is parked on gates only. setImmediate runs after that drain.
  return new Promise((resolve) => setImmediate(resolve));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A run handed back by the fake runner. Every pull on its event stream is a gate. */
class FuzzRun implements RunHandle {
  cancelCalls = 0;
  /** A cancel of this run succeeded. */
  cancelled = false;
  /** A stop by task id succeeded after this run existed. */
  stopped = false;
  readonly pause?: () => Promise<void>;
  readonly resume?: () => Promise<void>;
  /** The stream handed the orchestrator `finished` or `failed`: the run ended on its own. */
  reported = false;
  /** Cumulative spend reported so far, in cents. */
  private cents = 0;
  /** The last cumulative spend handed to the orchestrator, in dollars. */
  reportedUsd = 0;
  private over = false;
  readonly events: AsyncIterable<RunnerEvent>;

  constructor(
    private readonly world: FuzzWorld,
    readonly epoch: number,
    readonly taskId: TaskId,
  ) {
    if (world.rng.chance(0.9)) {
      this.pause = () => this.control('pause');
      this.resume = () => this.control('resume');
    }
    this.events = {
      [Symbol.asyncIterator]: () => ({
        next: () => this.next(),
        return: () => this.close(),
      }),
    };
  }

  private control(kind: 'pause' | 'resume'): Promise<void> {
    return new Promise<void>((resolve, reject) =>
      this.world.gate(this.epoch, kind, this.taskId, (draining) => {
        // A drained world answers every call, so what the runner owes is always settled.
        if (!draining && this.world.rng.chance(0.2)) {
          reject(new Error(`${kind} failed`));
          return 'rejected';
        }
        resolve();
        return 'done';
      }),
    );
  }

  cancel(): Promise<void> {
    this.cancelCalls += 1;
    if (this.world.rng.chance(0.1)) {
      this.world.note(`cancel ${this.taskId} throws synchronously`);
      throw new Error('cancel threw');
    }
    return new Promise<void>((resolve, reject) =>
      this.world.gate(this.epoch, 'cancel', this.taskId, () => {
        if (this.world.rng.chance(0.2)) {
          reject(new Error('cancel failed'));
          return 'rejected';
        }
        this.cancelled = true;
        resolve();
        return 'done';
      }),
    );
  }

  private next(): Promise<IteratorResult<RunnerEvent>> {
    if (this.over) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) =>
      this.world.gate(this.epoch, 'next', this.taskId, (draining) => {
        const kind = this.world.rng.weighted([
          ['progress', draining ? 0 : 55],
          ['usage', draining ? 0 : 15],
          ['finished', 8],
          ['failed', 8],
          ['eof', 6],
          ['throw', 8],
        ] as const);
        if (kind !== 'progress' && kind !== 'usage') this.over = true;
        if (kind === 'progress') resolve({ done: false, value: { type: 'progress', note: 'p' } });
        else if (kind === 'usage') {
          this.cents += 5 + this.world.rng.int(60);
          this.reportedUsd = this.cents / 100;
          resolve({ done: false, value: { type: 'usage', costUsd: this.cents / 100 } });
          return `usage ${this.cents / 100}`;
        } else if (kind === 'finished') {
          this.reported = true;
          this.world.writeManifest(this.taskId);
          resolve({ done: false, value: { type: 'finished' } });
        } else if (kind === 'failed') {
          this.reported = true;
          resolve({ done: false, value: { type: 'failed', reason: 'runner gave up' } });
        } else if (kind === 'eof') resolve({ done: true, value: undefined });
        else reject(new Error('stream broke'));
        return kind;
      }),
    );
  }

  private close(): Promise<IteratorResult<RunnerEvent>> {
    this.over = true;
    return new Promise((resolve, reject) =>
      this.world.gate(this.epoch, 'return', this.taskId, () => {
        if (this.world.rng.chance(0.15)) {
          reject(new Error('stream close failed'));
          return 'rejected';
        }
        resolve({ done: true, value: undefined });
        return 'closed';
      }),
    );
  }
}

export interface FuzzResult {
  seed: number;
  catalog: Catalog;
  violations: string[];
  trace: string[];
  steps: number;
  tasks: number;
}

/**
 * One deterministic run: an orchestrator over gated fakes, driven by a seeded
 * PRNG that picks, at every step, which parked await point to release or which
 * request to issue next. Invariants are checked after every step and once
 * everything is released.
 */
export class FuzzWorld {
  readonly rng: Prng;
  /** Whether the runner can stop a task's work by id. Taken from the seed, so the PRNG stream is unchanged. */
  private readonly stopsById: boolean;
  /** Whether the runner has `recover`, so a restart resumes its started tasks. Also taken from the seed. */
  private readonly recovers: boolean;
  readonly clock = new FakeClock();
  readonly trace: string[] = [];
  readonly violations: string[] = [];
  private readonly store = new MemoryTaskStore();
  private readonly sessions = new MemorySessionStore();
  private epoch = 0;
  private gates: Gate[] = [];
  private orchestrator: Orchestrator | undefined;
  private restarts = 0;
  private readonly tasks = new Map<TaskId, ModelTask>();
  private readonly runs: FuzzRun[] = [];
  /** Runner starts of this process not answered yet, per task. */
  private readonly startsOut = new Map<TaskId, number>();
  /**
   * Starts a dead process never heard back from: each may have left work running
   * that only a stop by task id can end.
   */
  private readonly lostStarts: Array<{ taskId: TaskId; epoch: number; stopped: boolean }> = [];
  private readonly credentials: Credential[] = [];
  private readonly labels = new Map<SessionId, string>();
  private readonly executorOf = new Map<SessionId, TaskId>();
  private readonly executorTokens = new Map<TaskId, string[]>();
  private readonly revoked = new Set<SessionId>();
  /** Conductor sessions whose public-API credential was revoked. */
  private readonly operatorRevoked = new Set<SessionId>();
  private readonly rotatedTokens = new Set<string>();
  private readonly manifests = new Set<TaskId>();
  /** session + key of each cancel by key that found no task, in this process. */
  private readonly tombstones = new Set<string>();
  private readonly requests: Request[] = [];
  private requestCount = 0;
  private taskCount = 0;
  private conductors = 0;
  private step = 0;

  constructor(
    readonly seed: number,
    readonly catalog: Catalog,
  ) {
    this.rng = new Prng(seed);
    this.stopsById = seed % 4 !== 0;
    this.recovers = seed % 2 === 0;
  }

  async run(): Promise<FuzzResult> {
    const steps = 40 + this.rng.int(120);
    this.boot(new Set());
    await flush();
    if (this.orchestrator) this.addConductor();
    for (this.step = 1; this.step <= steps && this.violations.length === 0; this.step += 1) {
      this.act();
      await flush();
      this.checkStep();
    }
    if (this.violations.length === 0) await this.quiesce();
    return {
      seed: this.seed,
      catalog: this.catalog,
      violations: this.violations,
      trace: this.trace,
      steps,
      tasks: this.tasks.size,
    };
  }

  note(line: string): void {
    this.trace.push(`[${this.step}] ${line}`);
  }

  violation(what: string): void {
    this.violations.push(`[${this.step}] ${what}`);
  }

  gate(epoch: number, kind: GateKind, label: string, open: (draining: boolean) => string): void {
    this.gates.push({ epoch, kind, label, open });
  }

  writeManifest(taskId: TaskId): void {
    if (this.rng.chance(0.8)) this.manifests.add(taskId);
  }

  // Building an orchestrator.

  private boot(expectedOrphans: Set<TaskId>): void {
    const epoch = this.epoch;
    const archivedTasks: CacheLimits =
      this.catalog === 'memory' ? DEFAULT_ARCHIVE_CACHE : { maxEntries: 0 };
    Orchestrator.create({
      store: this.storeFor(epoch),
      runners: new RunnerRegistry([this.runnerFor(epoch)]),
      handoffRoot: '/fuzz',
      now: () => this.clock.now,
      maxDepth: MAX_DEPTH,
      controlTimeoutMs: 1_500,
      newTaskId: () => `t${++this.taskCount}`,
      sessions: this.sessions,
      quotas: QUOTAS,
      caches: { archivedTasks },
      // Resumed runs start once the handoff and the endpoint below are in place.
      resume: 'manual',
    }).then(
      (orchestrator) => {
        if (epoch !== this.epoch) return;
        // Brief writes and manifest reads become gates too.
        (orchestrator as unknown as { handoff: unknown }).handoff = this.handoffFor(epoch);
        orchestrator.setEndpoint('http://fuzz.invalid/mcp');
        this.orchestrator = orchestrator;
        this.note(
          `epoch ${epoch} ready, orphaned [${orchestrator.orphanedTaskIds.join(' ')}], resumed [${orchestrator.resumedTaskIds.join(' ')}]`,
        );
        this.checkRestore(orchestrator, expectedOrphans);
        orchestrator.startRestored();
      },
      (error: unknown) => this.violation(`restore failed: ${errorMessage(error)}`),
    );
  }

  /** The process dies: nothing parked in it ever resumes, and a new one restores from the store. */
  private restart(): void {
    this.restarts += 1;
    this.epoch += 1;
    this.gates = [];
    this.clock.dropAll();
    this.orchestrator = undefined;
    // Cancels by key are remembered in memory only.
    this.tombstones.clear();
    for (const [taskId, out] of this.startsOut) {
      for (let i = 0; i < out; i += 1) {
        this.lostStarts.push({ taskId, epoch: this.epoch - 1, stopped: false });
      }
    }
    this.startsOut.clear();
    const active = new Set(this.store.activeTaskIds());
    this.note(`restart -> epoch ${this.epoch}, active [${[...active].join(' ')}]`);
    this.boot(active);
  }

  private storeFor(epoch: number): TaskStore {
    const inner = this.store;
    return {
      append: (event, at, fence) => {
        // The append is decided here, after the guard ran; the gate is the write's I/O.
        this.checkCommit(event, at, requestContext.getStore());
        return new Promise<StoredEvent>((resolve) =>
          this.gate(epoch, 'append', this.describeEvent(event), () => {
            this.apply(event, at);
            resolve(inner.append(event, at, fence));
            return 'written';
          }),
        );
      },
      read: (afterSeq) => inner.read(afterSeq),
      readTask: (taskId) => inner.readTask(taskId),
      childrenOf: (taskId) => inner.childrenOf(taskId),
      activeTaskIds: () => inner.activeTaskIds(),
      taskIds: () => inner.taskIds(),
      stopPendingTaskIds: () => inner.stopPendingTaskIds(),
      countCreatedSince: (root, since) => inner.countCreatedSince(root, since),
    };
  }

  private handoffFor(epoch: number) {
    const paths = (taskId: TaskId): HandoffPaths => ({
      dir: `/fuzz/${taskId}`,
      briefPath: `/fuzz/${taskId}/brief.md`,
      resultPath: `/fuzz/${taskId}/result.json`,
    });
    return {
      paths,
      writeBrief: (taskId: TaskId) =>
        new Promise<HandoffPaths>((resolve, reject) =>
          this.gate(epoch, 'brief', taskId, () => {
            if (this.rng.chance(0.05)) {
              reject(new Error('disk full'));
              return 'failed';
            }
            resolve(paths(taskId));
            return 'written';
          }),
        ),
      discard: async () => undefined,
      readManifest: (taskId: TaskId) =>
        new Promise<{ ok: true; manifest: ResultManifest } | { ok: false; reason: string }>(
          (resolve) =>
            this.gate(epoch, 'manifest', taskId, () => {
              if (this.manifests.has(taskId)) {
                resolve({ ok: true, manifest: MANIFEST });
                return 'valid';
              }
              resolve({ ok: false, reason: 'invalid manifest: result.json was not written' });
              return 'missing';
            }),
        ),
    };
  }

  private runnerFor(epoch: number): Runner {
    const start = (spec: RunSpec): Promise<RunHandle> => {
      this.noteExecutor(spec);
      if (this.rng.chance(0.05)) {
        this.note(`start ${spec.taskId} throws synchronously`);
        throw new Error('start threw');
      }
      this.startsOut.set(spec.taskId, (this.startsOut.get(spec.taskId) ?? 0) + 1);
      return new Promise<RunHandle>((resolve, reject) =>
        this.gate(epoch, 'start', spec.taskId, () => {
          this.startsOut.set(spec.taskId, (this.startsOut.get(spec.taskId) ?? 1) - 1);
          if (this.rng.chance(0.15)) {
            reject(new Error('start failed'));
            return 'rejected';
          }
          const run = new FuzzRun(this, epoch, spec.taskId);
          this.runs.push(run);
          resolve(run);
          return 'handle';
        }),
      );
    };
    return {
      name: 'fuzz',
      start,
      ...(this.recovers ? { recover: start } : {}),
      ...(this.stopsById ? { stopOrphaned: (taskId: TaskId) => this.stopById(epoch, taskId) } : {}),
    };
  }

  /** Finds a task's work by id, whichever process started it, as a remote sandbox would. */
  private stopById(epoch: number, taskId: TaskId): Promise<void> {
    if (this.rng.chance(0.05)) {
      this.note(`stop ${taskId} throws synchronously`);
      throw new Error('stop threw');
    }
    return new Promise<void>((resolve, reject) =>
      this.gate(epoch, 'stop', taskId, (draining) => {
        // A drained world answers every call, so what is owed is always settled.
        if (!draining && this.rng.chance(0.3)) {
          reject(new Error('sandbox unreachable'));
          return 'rejected';
        }
        for (const run of this.runs) if (run.taskId === taskId) run.stopped = true;
        for (const lost of this.lostStarts) if (lost.taskId === taskId) lost.stopped = true;
        resolve();
        return 'stopped';
      }),
    );
  }

  /** A run of the task, from any process, that may still be going, or a start of it not answered yet. */
  private liveRun(taskId: TaskId): string | undefined {
    if ((this.startsOut.get(taskId) ?? 0) > 0) return 'a start is still out';
    // Without a stop by id, nothing can reach what a dead process left: only this process's runs count.
    const run = this.runs.find(
      (r) =>
        r.taskId === taskId &&
        !r.reported &&
        !r.cancelled &&
        !r.stopped &&
        (this.stopsById || r.epoch === this.epoch),
    );
    if (run) return `its run from epoch ${run.epoch} may still be live`;
    if (!this.stopsById) return undefined;
    const lost = this.lostStarts.find((l) => l.taskId === taskId && !l.stopped);
    return lost && `a start from epoch ${lost.epoch} may have left a run`;
  }

  /** The runner is handed the executor's token, so the fuzzer can act as that executor. */
  private noteExecutor(spec: RunSpec): void {
    const token = spec.mcp?.token;
    if (token === undefined) {
      this.violation(`runner for ${spec.taskId} got no executor token`);
      return;
    }
    const sessionId = token.slice('mko_'.length, token.indexOf('.'));
    const label = `X(${spec.taskId})`;
    this.credentials.push({ label, sessionId, token, taskId: spec.taskId });
    this.labels.set(sessionId, label);
    this.executorOf.set(sessionId, spec.taskId);
    this.executorTokens.set(spec.taskId, [...(this.executorTokens.get(spec.taskId) ?? []), token]);
  }

  private addConductor(): void {
    const issued = this.orchestrator!.issueSession();
    this.conductors += 1;
    const label = `C${this.conductors}`;
    this.credentials.push({ label, sessionId: issued.sessionId, token: issued.token });
    this.labels.set(issued.sessionId, label);
    this.note(`new conductor ${label}`);
  }

  // The model of the log.

  private apply(event: TaskEvent, at: number): void {
    if (event.type === 'task_created') {
      if (this.tasks.has(event.taskId)) return;
      this.tasks.set(event.taskId, {
        taskId: event.taskId,
        ...(event.parentTaskId === undefined ? {} : { parentTaskId: event.parentTaskId }),
        sessionId: event.sessionId,
        rootSessionId: event.rootSessionId ?? event.sessionId,
        started: false,
        cancelRequested: false,
        pauseRequested: false,
        paused: false,
        resumeRequested: false,
        terminals: 0,
        stopPending: false,
        createdAt: at,
        ...(event.budgetUsd === undefined ? {} : { budgetUsd: event.budgetUsd }),
        spend: new Map(),
      });
      return;
    }
    const task = this.tasks.get(event.taskId);
    if (!task) return;
    if (event.type === 'task_cost') {
      const run = `${event.epoch ?? 0}:${event.fromTaskId}`;
      task.spend.set(run, Math.max(task.spend.get(run) ?? 0, event.costUsd));
    } else if (event.type === 'task_started') task.started = true;
    else if (event.type === 'task_cancel_requested') task.cancelRequested = true;
    else if (event.type === 'task_pause_requested') task.pauseRequested = true;
    else if (event.type === 'task_paused') task.paused = true;
    else if (event.type === 'task_pause_failed') task.pauseRequested = false;
    else if (event.type === 'task_resume_requested') task.resumeRequested = true;
    else if (event.type === 'task_resume_failed') task.resumeRequested = false;
    else if (event.type === 'task_stop_pending') task.stopPending = true;
    else if (event.type === 'task_stopped') task.stopPending = false;
    else if (event.type === 'task_resumed') {
      task.paused = false;
      task.pauseRequested = false;
      task.resumeRequested = false;
    } else if (TERMINAL.has(event.type)) task.terminals += 1;
  }

  private ended(taskId: TaskId): boolean {
    return (this.tasks.get(taskId)?.terminals ?? 0) > 0;
  }

  /** `taskId` and its ancestors, nearest first. */
  private chain(taskId: TaskId | undefined): ModelTask[] {
    const chain: ModelTask[] = [];
    for (let id = taskId; id !== undefined; ) {
      const task = this.tasks.get(id);
      if (!task) break;
      chain.push(task);
      id = task.parentTaskId;
    }
    return chain;
  }

  /** The top-level task of a tree whose recorded spend reached its cap, if `chain` is in one. */
  private overCap(chain: ModelTask[]): ModelTask | undefined {
    const root = chain.at(-1);
    if (root?.budgetUsd === undefined) return undefined;
    const cost = [...root.spend.values()].reduce((sum, usd) => sum + usd, 0);
    return Math.round((root.budgetUsd - cost) * 1e9) <= 0 ? root : undefined;
  }

  private stoppedIn(chain: ModelTask[]): ModelTask | undefined {
    return chain.find((task) => task.terminals > 0 || task.cancelRequested);
  }

  private isRevoked(sessionId: SessionId): boolean {
    const task = this.executorOf.get(sessionId);
    return this.revoked.has(sessionId) || (task !== undefined && this.ended(task));
  }

  private label(sessionId: SessionId | 'system'): string {
    return sessionId === 'system' ? 'system' : (this.labels.get(sessionId) ?? sessionId);
  }

  private describeEvent(event: TaskEvent): string {
    if (event.type === 'task_created') {
      return `${event.type} ${event.taskId} by ${this.label(event.sessionId)}${event.parentTaskId === undefined ? '' : ` under ${event.parentTaskId}`}`;
    }
    if (
      event.type === 'task_cancel_requested' ||
      event.type === 'task_pause_requested' ||
      event.type === 'task_resume_requested'
    ) {
      return `${event.type} ${event.taskId} by ${this.label(event.by)}`;
    }
    if (event.type === 'task_cost') {
      return `${event.type} ${event.taskId} from ${event.fromTaskId} ${event.costUsd}`;
    }
    return `${event.type} ${event.taskId}`;
  }

  // Invariants checked as each append is decided.

  private checkCommit(event: TaskEvent, at: number, request: Request | undefined): void {
    const what = this.describeEvent(event);
    if (event.type === 'task_created') {
      if (!request || request.sessionId !== event.sessionId) {
        this.violation(`${what} was not written by a request of that session`);
      } else {
        this.checkAuthority(request, what);
      }
      const stopped = this.stoppedIn(this.chain(event.parentTaskId));
      if (stopped)
        this.violation(`${what}: ancestor ${stopped.taskId} is ${this.stopState(stopped)}`);
      const capped = this.overCap(this.chain(event.parentTaskId));
      if (capped) this.violation(`${what}: tree ${capped.taskId} spent its budget`);
      if (event.parentTaskId !== undefined && event.budgetUsd !== undefined) {
        this.violation(`${what}: a child task carries its own budget`);
      }
      if (this.tasks.has(event.taskId)) this.violation(`${what}: the task was created before`);
      if (
        event.idempotencyKey !== undefined &&
        this.tombstones.has(`${event.sessionId}\0${event.idempotencyKey}`)
      ) {
        this.violation(`${what}: a cancel by key ${event.idempotencyKey} found nothing before`);
      }
      this.checkQuota(event.rootSessionId ?? event.sessionId, at, what);
      return;
    }
    const task = this.tasks.get(event.taskId);
    if (!task) {
      this.violation(`${what} for a task the log never created`);
      return;
    }
    if (TERMINAL.has(event.type) && task.terminals > 0) {
      this.violation(`a second terminal event: ${what}`);
    }
    if (TERMINAL.has(event.type) && task.cancelRequested && event.type !== 'task_cancelled') {
      this.violation(`${what} after its cancel was requested: it must end cancelled`);
    }
    // A runner that cannot stop by id can be owed nothing: the view check covers it instead.
    if (TERMINAL.has(event.type) && !task.stopPending && this.stopsById) {
      const live = this.liveRun(event.taskId);
      if (live) this.violation(`${what} while ${live}, and no stop is owed`);
    }
    if (event.type === 'task_stop_pending' && task.stopPending) {
      this.violation(`${what}: a stop is already owed`);
    }
    if (event.type === 'task_stopped') {
      if (!task.stopPending) this.violation(`${what}: no stop was owed`);
      const live = this.liveRun(event.taskId);
      if (live) this.violation(`${what} while ${live}`);
    }
    if (event.type === 'task_started') {
      if (task.terminals > 0) this.violation(`${what} after its terminal event`);
      if (task.cancelRequested) this.violation(`${what} after its cancel was requested`);
      const stopped = this.stoppedIn(this.chain(task.parentTaskId));
      if (stopped)
        this.violation(`${what}: ancestor ${stopped.taskId} is ${this.stopState(stopped)}`);
      const capped = this.overCap(this.chain(event.taskId));
      if (capped) this.violation(`${what}: tree ${capped.taskId} spent its budget`);
    }
    if (event.type === 'task_cost') {
      if (task.parentTaskId !== undefined) this.violation(`${what}: not a top-level task`);
      const from = this.chain(event.fromTaskId);
      if (from.at(-1) !== task) this.violation(`${what}: the reporting task is in another tree`);
    }
    this.checkControl(event, task, request, what);
    if (event.type === 'task_cancel_requested' && event.by !== 'system') {
      if (!request || request.sessionId !== event.by) {
        this.violation(`${what} was not written by a request of that session`);
      } else if (!request.accepted) {
        // A cancel is accepted where its session is checked in the write chain,
        // and the rest of its tree is torn down on its own, even after a revoke.
        // That check can pass on a task that is already stopping, which writes
        // nothing, so the first request a cancel writes may come after a revoke.
        // It may then only extend a teardown already under way above the task;
        // a request that starts a new one must come before the revoke.
        request.accepted = true;
        if (!this.stoppedIn(this.chain(task.parentTaskId))) this.checkAuthority(request, what);
      }
    }
  }

  /** Pause and resume are recorded only for the operator, only when nothing is stopping the task. */
  private checkControl(
    event: TaskEvent,
    task: ModelTask,
    request: Request | undefined,
    what: string,
  ): void {
    const stopping = task.terminals > 0 || task.cancelRequested;
    if (event.type === 'task_pause_requested' || event.type === 'task_resume_requested') {
      if (!request?.operator || request.sessionId !== event.by) {
        this.violation(`${what} was not written by an operator request of that session`);
      } else {
        this.checkAuthority(request, what);
      }
      if (stopping) this.violation(`${what} on a task that is ended or being cancelled`);
      const stoppedAbove = this.stoppedIn(this.chain(task.parentTaskId));
      if (stoppedAbove) {
        this.violation(
          `${what}: ancestor ${stoppedAbove.taskId} is ${this.stopState(stoppedAbove)}`,
        );
      }
    }
    switch (event.type) {
      case 'task_pause_requested':
        if (!task.started) this.violation(`${what} before the task started`);
        if (task.pauseRequested) this.violation(`${what}: a pause is already requested`);
        if (task.resumeRequested) this.violation(`${what} while a resume is under way`);
        return;
      case 'task_paused':
      case 'task_pause_failed':
        if (!task.pauseRequested || task.paused) {
          this.violation(`${what} without an open pause request`);
        }
        if (stopping) this.violation(`${what} on a task that is ended or being cancelled`);
        return;
      case 'task_resume_requested':
        if (!task.paused) this.violation(`${what} on a task that is not paused`);
        if (task.resumeRequested) this.violation(`${what}: a resume is already requested`);
        return;
      case 'task_resumed':
      case 'task_resume_failed':
        if (!task.paused || !task.resumeRequested) {
          this.violation(`${what} without an open resume request`);
        }
        if (stopping) this.violation(`${what} on a task that is ended or being cancelled`);
        return;
    }
  }

  /** Counting and appending happen in one step of the write chain, so the limits hold exactly. */
  private checkQuota(rootSessionId: SessionId, at: number, what: string): void {
    const tree = [...this.tasks.values()].filter((task) => task.rootSessionId === rootSessionId);
    const active = tree.filter((task) => task.terminals === 0).length;
    if (active >= QUOTAS.maxActiveTasks!) {
      this.violation(`${what} with ${active} unfinished tasks in the tree already`);
    }
    const recent = tree.filter((task) => task.createdAt >= at - QUOTAS.taskWindowMs!).length;
    if (recent >= QUOTAS.maxTasksPerWindow!) {
      this.violation(`${what} with ${recent} tasks created in the window already`);
    }
  }

  private checkAuthority(request: Request, what: string): void {
    if (request.operator) {
      if (this.operatorRevoked.has(request.sessionId)) {
        this.violation(
          `${what}: ${request.label} committed after its operator credential was revoked`,
        );
      }
      return;
    }
    if (this.isRevoked(request.sessionId)) {
      this.violation(
        `${what}: ${request.label} committed after ${request.credential.label} was revoked`,
      );
    }
    if (this.rotatedTokens.has(request.token)) {
      this.violation(`${what}: ${request.label} committed after its token was rotated`);
    }
  }

  private stopState(task: ModelTask): string {
    return task.terminals > 0 ? 'ended' : 'being cancelled';
  }

  // Invariants checked after every step.

  private checkStep(): void {
    const orchestrator = this.orchestrator;
    if (!orchestrator) return;
    const o = internals(orchestrator);
    const active = [...this.tasks.values()].filter((task) => task.terminals === 0);

    const inMemory = [...o.tasks.keys()].sort();
    const expected = active.map((task) => task.taskId).sort();
    if (inMemory.join(' ') !== expected.join(' ')) {
      this.violation(
        `tasks in memory [${inMemory.join(' ')}] != unfinished in the log [${expected.join(' ')}]`,
      );
    }
    for (const [taskId, record] of o.tasks as Map<
      TaskId,
      { state: string; pauseRequested?: boolean }
    >) {
      const model = this.tasks.get(taskId);
      if (!model) continue;
      const state = model.paused ? 'paused' : model.started ? 'running' : 'queued';
      if (record.state !== state) {
        this.violation(`${taskId} is ${record.state} in memory but ${state} in the log`);
      }
      if ((record.pauseRequested === true) !== model.pauseRequested) {
        this.violation(`${taskId} pauseRequested differs between memory and the log`);
      }
    }
    this.checkCounts(
      'active tasks per tree',
      o.activeByRoot.counts,
      active.map((task) => task.rootSessionId),
    );

    for (const taskId of o.handles.keys()) {
      if (this.ended(taskId)) this.violation(`handles still holds ended ${taskId}`);
    }
    for (const [taskId, set] of o.waiters) {
      if (this.ended(taskId)) this.violation(`waiters still holds ended ${taskId}`);
      if (set.size === 0) this.violation(`waiters holds an empty set for ${taskId}`);
    }
    for (const taskId of o.executorSessions.keys()) {
      if (this.ended(taskId)) this.violation(`executorSessions still holds ended ${taskId}`);
    }

    const live = this.requests.filter((request) => request.epoch === this.epoch);
    const connected = live.filter((request) => request.connection !== undefined);
    if (o.openConnections !== connected.length) {
      this.violation(`openConnections ${o.openConnections} != ${connected.length} open requests`);
    }
    this.checkCounts(
      'connections per session',
      o.connectionsBySession.counts,
      connected.map((r) => r.sessionId),
    );

    const waiting = new Map<SessionId, number>();
    for (const request of live) {
      if (request.waits && !request.settled) {
        waiting.set(request.sessionId, (waiting.get(request.sessionId) ?? 0) + 1);
      }
    }
    // A wait that returned (timeout, abort) must leave the task's waiter set.
    const registered = [...o.waiters.values()].reduce((sum, set) => sum + set.size, 0);
    const waitingRequests = [...waiting.values()].reduce((sum, count) => sum + count, 0);
    if (registered > waitingRequests) {
      this.violation(`${registered} registered waiters with ${waitingRequests} waiting requests`);
    }
    for (const [sessionId, count] of o.waitsBySession.counts) {
      const open = waiting.get(sessionId) ?? 0;
      if (count > open) {
        this.violation(
          `${this.label(sessionId)} holds ${count} wait slots with ${open} waiting requests`,
        );
      }
    }

    for (const [taskId, tokens] of this.executorTokens) {
      if (!this.ended(taskId)) continue;
      for (const token of tokens) {
        if (orchestrator.authenticate(token)) {
          this.violation(`the executor token of ended ${taskId} still authenticates`);
        }
      }
    }
    for (const token of this.rotatedTokens) {
      if (orchestrator.authenticate(token))
        this.violation('a rotated-away token still authenticates');
    }
    for (const run of this.runs) {
      if (
        run.epoch === this.epoch &&
        this.ended(run.taskId) &&
        !run.reported &&
        run.cancelCalls === 0
      ) {
        this.violation(`${run.taskId} ended but its run was never cancelled`);
      }
    }
  }

  private checkCounts(what: string, actual: Map<SessionId, number>, keys: SessionId[]): void {
    const expected = new Map<SessionId, number>();
    for (const key of keys) expected.set(key, (expected.get(key) ?? 0) + 1);
    const render = (counts: Map<SessionId, number>) =>
      [...counts]
        .map(([key, count]) => `${this.label(key)}=${count}`)
        .sort()
        .join(' ');
    if (render(actual) !== render(expected)) {
      this.violation(`${what}: counted {${render(actual)}}, real {${render(expected)}}`);
    }
  }

  private checkRestore(orchestrator: Orchestrator, expected: Set<TaskId>): void {
    const orphans = [...orchestrator.orphanedTaskIds].sort();
    const resumed = [...orchestrator.resumedTaskIds].sort();
    const wanted = [...expected].sort();
    const handled = [...orphans, ...resumed].sort();
    if (handled.join(' ') !== wanted.join(' ')) {
      this.violation(
        `restore ended [${orphans.join(' ')}] and resumed [${resumed.join(' ')}], unfinished were [${wanted.join(' ')}]`,
      );
    }
    if (!this.recovers && resumed.length > 0) {
      this.violation(`restore resumed [${resumed.join(' ')}] with a runner that cannot recover`);
    }
    for (const taskId of resumed) {
      if (this.tasks.get(taskId)?.terminals !== 0) {
        this.violation(`resumed ${taskId} already has a terminal event`);
      }
    }
    for (const taskId of handled) {
      if (!orphans.includes(taskId)) {
        for (const token of this.executorTokens.get(taskId) ?? []) {
          if (orchestrator.authenticate(token)) {
            this.violation(`the executor token of resumed ${taskId} survived the restart`);
          }
        }
        continue;
      }
      if (this.tasks.get(taskId)?.terminals !== 1) {
        this.violation(`orphan ${taskId} has ${this.tasks.get(taskId)?.terminals} terminal events`);
      }
      for (const token of this.executorTokens.get(taskId) ?? []) {
        if (orchestrator.authenticate(token)) {
          this.violation(`the executor token of orphan ${taskId} survived the restart`);
        }
      }
    }
    if (orchestrator.stats().activeTasks !== resumed.length) {
      this.violation(
        `${orchestrator.stats().activeTasks} tasks active after restore, ${resumed.length} resumed`,
      );
    }
  }

  // Release everything, then check that nothing is left behind.

  private async quiesce(): Promise<void> {
    this.note('quiesce');
    for (let released = 0; ; released += 1) {
      if (released > 50_000) {
        this.violation('still not quiet after 50000 releases');
        return;
      }
      if (this.liveGates().length > 0) this.releaseGate(true);
      else if (this.clock.pending > 0) this.note(`clock ${this.clock.fireNext()}`);
      else break;
      await flush();
      this.checkStep();
      if (this.violations.length > 0) return;
    }
    const orchestrator = this.orchestrator;
    if (!orchestrator) {
      this.violation('restore never finished');
      return;
    }
    let settled = false;
    void orchestrator.settled().then(() => {
      settled = true;
    });
    await flush();
    if (!settled) this.violation('settled() did not resolve with nothing left to release');

    for (const task of this.tasks.values()) {
      if (task.terminals !== 1)
        this.violation(`${task.taskId} has ${task.terminals} terminal events`);
      if (task.stopPending) this.violation(`${task.taskId} still owes a stop`);
    }
    for (const run of this.runs) {
      const reachable = this.stopsById || run.epoch === this.epoch;
      if (reachable && !run.reported && !run.cancelled && !run.stopped) {
        this.violation(`the run of ${run.taskId} from epoch ${run.epoch} was never stopped`);
      }
      // A run of a process that died took its unrecorded reports with it.
      if (run.epoch !== this.epoch || run.reportedUsd === 0) continue;
      const root = this.chain(run.taskId).at(-1);
      const recorded = root ? recordedFor(root, run.taskId) : 0;
      if (Math.round(recorded * 100) < Math.round(run.reportedUsd * 100)) {
        this.violation(
          `the run of ${run.taskId} reported $${run.reportedUsd}, but $${recorded} is recorded`,
        );
      }
    }
    for (const lost of this.lostStarts) {
      if (this.stopsById && !lost.stopped) {
        this.violation(`a start of ${lost.taskId} from epoch ${lost.epoch} was never stopped`);
      }
    }
    for (const request of this.requests) {
      if (request.epoch === this.epoch && !request.settled) {
        this.violation(`${request.label} never returned`);
      }
    }
    const o = internals(orchestrator);
    const stats = orchestrator.stats();
    const leftovers: Array<[string, number]> = [
      ['activeTasks', stats.activeTasks],
      ['treesCounted', stats.treesCounted],
      ['waitedTasks', stats.waitedTasks],
      ['sessionsWaiting', stats.sessionsWaiting],
      ['connectionSessions', stats.connectionSessions],
      ['openConnections', o.openConnections],
      ['handles', o.handles.size],
      ['executorSessions', o.executorSessions.size],
      ['cancelling', o.cancelling.size],
      ['starting', o.starting.size],
      ['stopRetries', stats.stopRetries],
      ['background', o.background.size],
    ];
    for (const [name, value] of leftovers) {
      if (value !== 0) this.violation(`${name} is ${value} at quiescence`);
    }
  }

  // Choosing the next step.

  private liveGates(): Gate[] {
    return this.gates.filter((gate) => gate.epoch === this.epoch);
  }

  private releaseGate(draining: boolean): void {
    const live = this.liveGates();
    const gate = this.rng.pick(live);
    this.gates.splice(this.gates.indexOf(gate), 1);
    const outcome = gate.open(draining);
    this.note(`${gate.kind} ${gate.label} -> ${outcome}`);
  }

  private act(): void {
    const gates = this.liveGates().length;
    if (!this.orchestrator) {
      if (this.restarts < MAX_RESTARTS && this.rng.chance(0.05)) this.restart();
      else if (gates > 0) this.releaseGate(false);
      return;
    }
    const choice = this.rng.weighted([
      ['gate', gates > 0 ? 55 : 0],
      ['timer', this.clock.pending > 0 ? 5 : 0],
      ['jump', 1],
      ['request', 40],
    ] as const);
    if (choice === 'gate') this.releaseGate(false);
    else if (choice === 'timer') this.note(`clock ${this.clock.fireNext()}`);
    else if (choice === 'jump') this.note(`clock ${this.clock.advance(1 + this.rng.int(3_000))}`);
    else this.operate(this.orchestrator);
  }

  private operate(orchestrator: Orchestrator): void {
    const open = this.requests.filter(
      (request) =>
        request.epoch === this.epoch && !request.settled && !request.abort.signal.aborted,
    );
    const choice = this.rng.weighted([
      ['delegate', 30],
      ['cancel', 12],
      ['cancelKey', 4],
      ['wait', 12],
      ['status', 4],
      ['abort', open.length > 0 ? 6 : 0],
      ['pause', 12],
      ['resume', 12],
      ['operatorCancel', 4],
      ['revokeOperator', 0.5],
      ['revoke', 3],
      ['rotate', 3],
      ['conductor', this.conductors < MAX_CONDUCTORS ? (this.anyConductorUsable() ? 2 : 20) : 0],
      ['restart', this.restarts < MAX_RESTARTS ? 1.5 : 0],
    ] as const);
    switch (choice) {
      case 'delegate': {
        const mode = this.rng.chance(0.35) ? 'wait' : 'async';
        const timeoutMs = this.rng.pick(WAIT_TIMEOUTS);
        const budgetUsd = this.rng.pick(BUDGETS);
        const key = this.rng.chance(0.3) ? this.rng.pick(KEYS) : undefined;
        const what = `delegate ${mode}${budgetUsd === undefined ? '' : ` $${budgetUsd}`}${key === undefined ? '' : ` key ${key}`}`;
        this.request(what, mode === 'wait', (session, signal) =>
          orchestrator.delegate(
            session,
            {
              runner: 'fuzz',
              brief: 'do it',
              mode,
              ...(timeoutMs === undefined ? {} : { timeoutMs }),
              ...(budgetUsd === undefined ? {} : { budgetUsd }),
              ...(key === undefined ? {} : { idempotencyKey: key }),
            },
            signal,
          ),
        );
        return;
      }
      case 'cancelKey': {
        const key = this.rng.pick(KEYS);
        const epoch = this.epoch;
        this.request(`cancel key ${key}`, false, (session) =>
          orchestrator.cancelByKey(session, key).then((view) => {
            if (view === undefined && epoch === this.epoch) {
              this.tombstones.add(`${session.sessionId}\0${key}`);
            }
            return view;
          }),
        );
        return;
      }
      case 'cancel': {
        this.request('cancel', false, (session, _signal, credential) =>
          orchestrator.cancel(session, this.pickTask(credential)),
        );
        return;
      }
      case 'wait': {
        const timeoutMs = this.rng.pick(WAIT_TIMEOUTS);
        this.request(`wait ${timeoutMs ?? 'default'}ms`, true, (session, signal, credential) =>
          orchestrator.wait(session, this.pickTask(credential), timeoutMs, signal),
        );
        return;
      }
      case 'status': {
        this.request('status', false, (session, _signal, credential) =>
          orchestrator.status(session, this.pickTask(credential)),
        );
        return;
      }
      case 'pause':
        this.operatorRequest(
          'pause',
          (task) => task.started && task.terminals === 0 && !task.pauseRequested,
          (access, taskId) => orchestrator.pauseAs(access, taskId),
        );
        return;
      case 'resume':
        this.operatorRequest(
          'resume',
          (task) => task.paused && task.terminals === 0 && !task.resumeRequested,
          (access, taskId) => orchestrator.resumeAs(access, taskId),
        );
        return;
      case 'operatorCancel':
        this.operatorRequest('operator cancel', undefined, (access, taskId) =>
          orchestrator.cancelAs(access, taskId),
        );
        return;
      case 'revokeOperator': {
        const conductors = this.credentials.filter((credential) => credential.taskId === undefined);
        if (conductors.length === 0) return;
        const credential = this.rng.pick(conductors);
        this.operatorRevoked.add(credential.sessionId);
        this.note(`revoke operator credential of ${credential.label}`);
        return;
      }
      case 'abort': {
        const request = this.rng.pick(open);
        this.note(`connection of ${request.label} drops`);
        this.drop(request);
        return;
      }
      case 'revoke': {
        const credential = this.rng.pick(this.credentials);
        orchestrator.revokeSession(credential.sessionId);
        this.revoked.add(credential.sessionId);
        this.note(`revoke ${credential.label}`);
        return;
      }
      case 'rotate': {
        const credential = this.rng.pick(this.credentials);
        const issued = orchestrator.rotateSession(credential.sessionId);
        this.note(`rotate ${credential.label} -> ${issued ? 'new token' : 'unknown session'}`);
        if (!issued) return;
        this.rotatedTokens.add(credential.token);
        credential.token = issued.token;
        if (credential.taskId !== undefined) {
          this.executorTokens.get(credential.taskId)?.push(issued.token);
        }
        return;
      }
      case 'conductor':
        this.addConductor();
        return;
      case 'restart':
        this.restart();
        return;
    }
  }

  private anyConductorUsable(): boolean {
    return this.credentials.some(
      (credential) => credential.taskId === undefined && !this.revoked.has(credential.sessionId),
    );
  }

  /** Mostly a session that should still work; sometimes any, to cover revoked and ended ones. */
  private pickCredential(): Credential {
    const usable = this.credentials.filter(
      (credential) =>
        !this.revoked.has(credential.sessionId) &&
        (credential.taskId === undefined || !this.ended(credential.taskId)),
    );
    if (usable.length === 0 || this.rng.chance(0.1)) return this.rng.pick(this.credentials);
    // Executors get half the calls when there are any, so nested work is common.
    const executors = usable.filter((credential) => credential.taskId !== undefined);
    return executors.length > 0 && this.rng.chance(0.5)
      ? this.rng.pick(executors)
      : this.rng.pick(usable);
  }

  /** Mostly a task the session can see, ended and archived ones included. */
  private pickTask(credential: Credential): TaskId {
    const all = [...this.tasks.keys()];
    if (all.length === 0 || this.rng.chance(0.03)) return 't0';
    const visible = all.filter((taskId) =>
      this.chain(taskId).some((task) => task.sessionId === credential.sessionId),
    );
    return visible.length > 0 && this.rng.chance(0.8) ? this.rng.pick(visible) : this.rng.pick(all);
  }

  /**
   * A tool call through the MCP endpoint: authenticate the bearer token, take a
   * connection slot, check the session again when the tool runs, then call.
   */
  private request(
    what: string,
    waits: boolean,
    call: (session: SessionInfo, signal: AbortSignal, credential: Credential) => unknown,
  ): void {
    const orchestrator = this.orchestrator!;
    const credential = this.pickCredential();
    const session = orchestrator.authenticate(credential.token);
    if (!session) {
      this.note(`${what} by ${credential.label}: 401`);
      return;
    }
    let release: () => void;
    try {
      release = orchestrator.acquireConnection(session);
    } catch (error) {
      this.note(`${what} by ${credential.label}: 429`);
      if (!(error instanceof OrchestratorError))
        this.violation(`acquireConnection threw ${errorMessage(error)}`);
      return;
    }
    this.requestCount += 1;
    const request: Request = {
      label: `r${this.requestCount} ${what}`,
      credential,
      token: credential.token,
      sessionId: session.sessionId,
      epoch: this.epoch,
      waits,
      settled: false,
      connection: release,
      abort: new AbortController(),
      accepted: false,
    };
    this.requests.push(request);
    this.note(`${request.label} by ${credential.label}`);
    // The caller can be gone before the tool even runs.
    if (this.rng.chance(0.03)) {
      this.note(`connection of ${request.label} already dropped`);
      this.drop(request);
    }
    const result = requestContext.run(request, () => {
      try {
        orchestrator.assertSessionActive(session);
        return Promise.resolve(call(session, request.abort.signal, credential));
      } catch (error) {
        return Promise.reject(error);
      }
    });
    result.then(
      (value) => {
        this.checkSettleView(request, value);
        this.settle(request, `ok ${describeView(value)}`);
      },
      (error: unknown) => {
        if (!(error instanceof OrchestratorError)) {
          this.violation(
            `${request.label} failed with a non-orchestrator error: ${errorMessage(error)}`,
          );
          this.settle(request, `threw ${errorMessage(error)}`);
          return;
        }
        this.settle(request, `${error.code}: ${error.message}`);
      },
    );
  }

  /**
   * A call through the public API: the user's own credential was checked by the
   * server, and the orchestrator acts for the conversation's session. No session
   * token and no connection slot are involved.
   */
  private operatorRequest(
    what: string,
    wanted: ((task: ModelTask) => boolean) | undefined,
    call: (access: OperatorAccess, taskId: TaskId) => unknown,
  ): void {
    const conductors = this.credentials.filter((credential) => credential.taskId === undefined);
    if (conductors.length === 0) return;
    // Mostly a task that fits the request, asked through the conductor whose tree holds it.
    const fits = wanted ? [...this.tasks.values()].filter(wanted) : [...this.tasks.values()];
    const target = fits.length > 0 && this.rng.chance(0.85) ? this.rng.pick(fits) : undefined;
    const owner = conductors.find((candidate) => candidate.sessionId === target?.rootSessionId);
    const trusted = conductors.filter(
      (candidate) => !this.operatorRevoked.has(candidate.sessionId),
    );
    const credential =
      owner ?? this.rng.pick(trusted.length > 0 && this.rng.chance(0.9) ? trusted : conductors);
    const taskId = target?.taskId ?? this.pickTask(credential);
    this.requestCount += 1;
    const request: Request = {
      label: `r${this.requestCount} ${what}`,
      credential,
      token: '',
      sessionId: credential.sessionId,
      epoch: this.epoch,
      waits: false,
      settled: false,
      connection: undefined,
      abort: new AbortController(),
      accepted: false,
      operator: true,
    };
    this.requests.push(request);
    this.note(`${request.label} by operator of ${credential.label}`);
    const access: OperatorAccess = {
      sessionId: credential.sessionId,
      authorize: () => {
        if (this.operatorRevoked.has(credential.sessionId)) {
          throw new OrchestratorError('unauthorized', 'The operator credential was revoked');
        }
      },
    };
    const result = requestContext.run(request, () => {
      try {
        // The server checks the credential when the request arrives.
        access.authorize();
        return Promise.resolve(call(access, taskId));
      } catch (error) {
        return Promise.reject(error);
      }
    });
    result.then(
      (value) => {
        this.checkSettleView(request, value);
        this.settle(request, `ok ${describeView(value)}`);
      },
      (error: unknown) => {
        if (!(error instanceof OrchestratorError)) {
          this.violation(
            `${request.label} failed with a non-orchestrator error: ${errorMessage(error)}`,
          );
          this.settle(request, `threw ${errorMessage(error)}`);
          return;
        }
        this.settle(request, `${error.code}: ${error.message}`);
      },
    );
  }

  /**
   * A view of an ended task that marks nothing in its tree as still running is
   * what lets a caller settle the tree's budget: nothing in that tree may still run.
   */
  private checkSettleView(request: Request, value: unknown): void {
    if (request.epoch !== this.epoch || typeof value !== 'object' || value === null) return;
    const view = value as Partial<TaskView>;
    if (typeof view.taskId !== 'string') return;
    if (!['succeeded', 'failed', 'cancelled'].includes(String(view.state))) return;
    if (view.stopPending || view.treeStopPending) return;
    for (const taskId of this.treeOf(view.taskId)) {
      const live = this.liveRun(taskId);
      if (live) {
        this.violation(
          `${request.label}: ${view.taskId} reads ${view.state} with nothing still running, but ${taskId}: ${live}`,
        );
      }
      const unrecorded = this.unrecordedSpend(taskId);
      if (unrecorded) {
        this.violation(
          `${request.label}: ${view.taskId} reads ${view.state} with nothing still running, but ${taskId}: ${unrecorded}`,
        );
      }
    }
  }

  /** Spend a run of this process handed the orchestrator that is not in the log yet. */
  private unrecordedSpend(taskId: TaskId): string | undefined {
    for (const run of this.runs) {
      if (run.taskId !== taskId || run.epoch !== this.epoch || run.reportedUsd === 0) continue;
      const root = this.chain(taskId).at(-1);
      const recorded = root ? recordedFor(root, taskId) : 0;
      if (Math.round(recorded * 100) < Math.round(run.reportedUsd * 100)) {
        return `its run reported $${run.reportedUsd}, but $${recorded} is recorded`;
      }
    }
    return undefined;
  }

  /** The task and everything below it. */
  private treeOf(rootId: TaskId): TaskId[] {
    const tree = [rootId];
    for (let i = 0; i < tree.length; i += 1) {
      for (const task of this.tasks.values()) {
        if (task.parentTaskId === tree[i]) tree.push(task.taskId);
      }
    }
    return tree;
  }

  /** The server aborts the request's signal and gives the connection slot back when the socket closes. */
  private drop(request: Request): void {
    request.abort.abort();
    request.connection?.();
    request.connection = undefined;
  }

  private settle(request: Request, outcome: string): void {
    request.settled = true;
    request.connection?.();
    request.connection = undefined;
    if (request.epoch === this.epoch) this.note(`${request.label} -> ${outcome}`);
  }
}

function describeView(value: unknown): string {
  if (typeof value !== 'object' || value === null || !('taskId' in value)) return '';
  const view = value as TaskView;
  return `${view.taskId} ${view.state}${view.waitTimedOut ? ' (timed out)' : ''}`;
}

export async function runSeed(seed: number, catalog: Catalog): Promise<FuzzResult> {
  const world = new FuzzWorld(seed, catalog);
  const uninstall = world.clock.install();
  try {
    return await world.run();
  } finally {
    uninstall();
  }
}

export function formatFailure(result: FuzzResult): string {
  return [
    `Schedule fuzzer violation, seed ${result.seed}, ${result.catalog} catalog:`,
    ...result.violations.map((violation) => `  ${violation}`),
    `Replay: FUZZ_SEED=${result.seed} (runs both catalogs)`,
    'Trace:',
    ...result.trace.map((line) => `  ${line}`),
  ].join('\n');
}

/** The most any attempt of `taskId` has had recorded on its tree's top-level task. */
function recordedFor(root: { spend: Map<string, number> }, taskId: TaskId): number {
  let most = 0;
  for (const [key, usd] of root.spend) {
    if (key.endsWith(`:${taskId}`)) most = Math.max(most, usd);
  }
  return most;
}
