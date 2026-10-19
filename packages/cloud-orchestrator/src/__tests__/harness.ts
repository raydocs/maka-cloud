import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { SessionInfo } from '../auth.js';
import { FakeRunner, type FakeRunnerOptions } from '../fake-runner.js';
import { Orchestrator, type OrchestratorOptions } from '../orchestrator.js';
import { RunnerRegistry } from '../runner.js';
import { MemoryTaskStore, type TaskStore } from '../store.js';
import type { StoredEvent, TaskEvent, TaskId } from '../types.js';

export interface Harness {
  dir: string;
  store: TaskStore;
  fake: FakeRunner;
  orchestrator: Orchestrator;
  /** A fresh root-level session, as a conductor would hold. */
  session(): SessionInfo;
  /** The session an executor of `taskId` would hold. */
  executorSession(taskId: TaskId): SessionInfo;
}

export async function makeHarness(
  t: TestContext,
  options: {
    store?: TaskStore;
    dir?: string;
    fake?: FakeRunnerOptions;
    orchestrator?: Partial<OrchestratorOptions>;
  } = {},
): Promise<Harness> {
  const ownsDir = options.dir === undefined;
  const dir = options.dir ?? (await mkdtemp(join(tmpdir(), 'orchestrator-test-')));
  if (ownsDir) t.after(() => rm(dir, { recursive: true, force: true }));
  const store = options.store ?? new MemoryTaskStore();
  const fake = new FakeRunner(options.fake);
  const orchestrator = await Orchestrator.create({
    store,
    runners: new RunnerRegistry([fake]),
    handoffRoot: dir,
    ...options.orchestrator,
  });
  const fromToken = (token: string): SessionInfo => {
    const info = orchestrator.authenticate(token);
    if (!info) throw new Error('token did not resolve');
    return info;
  };
  return {
    dir,
    store,
    fake,
    orchestrator,
    session: () => fromToken(orchestrator.issueSession().token),
    executorSession: (taskId) =>
      fromToken(orchestrator.issueSession({ parentTaskId: taskId }).token),
  };
}

export async function eventually(
  check: () => boolean,
  what: string,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A store that can hold one kind of append until the test lets it through. */
export class GatedStore extends MemoryTaskStore {
  private gate: { type: TaskEvent['type']; open: Promise<void> } | undefined;
  private waitingAtGate = false;

  /** The next append of `type` blocks until the returned function is called. */
  holdNext(type: TaskEvent['type']): () => void {
    let release: () => void = () => {};
    this.gate = {
      type,
      open: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    return release;
  }

  get held(): boolean {
    return this.waitingAtGate;
  }

  override async append(event: TaskEvent, at: number): Promise<StoredEvent> {
    const gate = this.gate;
    if (gate && gate.type === event.type) {
      this.gate = undefined;
      this.waitingAtGate = true;
      await gate.open;
      this.waitingAtGate = false;
    }
    return super.append(event, at);
  }
}

/** Waits registered by `task_wait` and `delegate` in wait mode that are still pending. */
export function pendingWaits(h: Harness): number {
  const waiters = (h.orchestrator as unknown as { waiters: Map<TaskId, Set<unknown>> }).waiters;
  return waiters.size;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
