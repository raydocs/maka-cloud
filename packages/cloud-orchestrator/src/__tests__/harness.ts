import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { SessionInfo } from '../auth.js';
import { FakeRunner, type FakeRunnerOptions } from '../fake-runner.js';
import { Orchestrator, type OrchestratorOptions } from '../orchestrator.js';
import { RunnerRegistry } from '../runner.js';
import { MemoryTaskStore, type TaskStore } from '../store.js';
import type { TaskId } from '../types.js';

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
