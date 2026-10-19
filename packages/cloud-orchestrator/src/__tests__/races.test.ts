import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryTaskStore } from '../store.js';
import {
  isTerminal,
  OrchestratorError,
  type SessionId,
  type TaskEvent,
  type TaskId,
} from '../types.js';
import type { FakeRun } from '../fake-runner.js';
import { eventually, GatedStore, type Harness, makeHarness } from './harness.js';

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function events(h: Harness, taskId?: TaskId): Promise<TaskEvent[]> {
  const all = (await h.store.read()).map(({ event }) => event);
  return taskId === undefined ? all : all.filter((event) => event.taskId === taskId);
}

function terminalEvents(log: TaskEvent[]): TaskEvent[] {
  return log.filter(
    (event) =>
      event.type === 'task_succeeded' ||
      event.type === 'task_failed' ||
      event.type === 'task_cancelled',
  );
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof OrchestratorError && error.code === 'unauthorized';
}

// Start and cancel interleave.

test('a runner that finishes starting while the cancel is committing is cancelled and never recorded as started', async (t) => {
  const store = new GatedStore();
  const startGate = deferred();
  const h = await makeHarness(t, { store, fake: { onStart: () => startGate.promise } });
  const conductor = h.session();
  const { taskId } = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'x' });
  await eventually(() => h.fake.runs.length === 1, 'run created');

  // The cancel has asked for the task to stop and is writing task_cancelled.
  const release = store.holdNext('task_cancelled');
  const cancelling = h.orchestrator.cancel(conductor, taskId);
  await eventually(() => store.held, 'task_cancelled held');

  // The runner comes up in that window. Nothing has ended yet, so a check for
  // "ended" would let it through; it has to be cancelled right here.
  startGate.resolve();
  await eventually(() => h.fake.runFor(taskId).cancelCalls === 1, 'late handle cancelled', 1000);
  release();

  assert.equal((await cancelling).state, 'cancelled');
  await h.orchestrator.settled();
  const log = await events(h, taskId);
  assert.ok(!log.some((event) => event.type === 'task_started'), JSON.stringify(log));
  assert.equal(terminalEvents(log).length, 1);
  assert.equal(h.fake.runFor(taskId).cancelCalls, 1);
});

test('a task that ends with a runner handle still registered has that handle cancelled', async (t) => {
  const h = await makeHarness(t);
  const conductor = h.session();
  const { taskId } = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'x' });
  await eventually(() => h.fake.runs.length === 1, 'run created');
  const run = h.fake.runFor(taskId);
  // A broken connection says nothing about whether the remote process is still alive.
  const crashed = h.orchestrator.wait(conductor, taskId, 2000);
  await eventually(
    () => (h.orchestrator as unknown as { handles: Map<TaskId, unknown> }).handles.has(taskId),
    'handle registered',
  );
  run.crash(new Error('connection lost'));
  const view = await crashed;
  assert.equal(view.state, 'failed');
  assert.match(view.failureReason ?? '', /connection lost/u);
  assert.equal(run.cancelCalls, 1);
});

// A cancel is only accepted for a session that is still valid.

test('a cancel whose session was revoked before it was accepted changes nothing', async (t) => {
  const store = new GatedStore();
  const h = await makeHarness(t, { store });
  const conductor = h.session();
  const { taskId } = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'x' });
  await eventually(() => h.fake.runs.length === 1, 'run created');

  // The cancel queues behind a write that is still in flight.
  const release = store.holdNext('task_progress');
  h.fake.runFor(taskId).progress('working');
  await eventually(() => store.held, 'progress held');
  const rejected = assert.rejects(h.orchestrator.cancel(conductor, taskId), isUnauthorized);
  h.orchestrator.revokeSession(conductor.sessionId);
  release();
  await rejected;

  const log = await events(h, taskId);
  assert.ok(!log.some((event) => event.type === 'task_cancel_requested'));
  assert.equal(h.orchestrator.status(conductor, taskId).state, 'running');
  assert.equal(h.fake.runFor(taskId).cancelCalls, 0);
});

test('a cancel that was accepted finishes even when its session is revoked afterwards', async (t) => {
  const store = new GatedStore();
  const h = await makeHarness(t, { store });
  const conductor = h.session();
  const parent = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'p' });
  const child = await h.orchestrator.delegate(h.executorSession(parent.taskId), {
    runner: 'fake',
    brief: 'c',
  });
  await eventually(() => h.fake.runs.length === 2, 'runs');

  const release = store.holdNext('task_cancelled');
  const cancelling = h.orchestrator.cancel(conductor, parent.taskId);
  await eventually(() => store.held, 'first task_cancelled held');
  h.orchestrator.revokeSession(conductor.sessionId);
  release();

  assert.equal((await cancelling).state, 'cancelled');
  for (const id of [parent.taskId, child.taskId]) {
    assert.equal(terminalEvents(await events(h, id)).length, 1, id);
    assert.equal(h.fake.runFor(id).cancelCalls, 1, id);
  }
});

// Exactly one terminal event per task.

test('two cancels of the same task in flight write one request, one cancel and one terminal event', async (t) => {
  const store = new GatedStore();
  const h = await makeHarness(t, { store });
  const conductor = h.session();
  const { taskId } = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'x' });
  await eventually(() => h.fake.runs.length === 1, 'run created');

  const release = store.holdNext('task_cancelled');
  const first = h.orchestrator.cancel(conductor, taskId);
  const second = h.orchestrator.cancel(conductor, taskId);
  // Held means the first cancel got as far as writing task_cancelled. The write
  // chain is serial, so the second one's request has been through by now.
  await eventually(() => store.held, 'task_cancelled held');
  release();

  assert.equal((await first).state, 'cancelled');
  assert.equal((await second).state, 'cancelled');
  const log = await events(h, taskId);
  assert.equal(log.filter((event) => event.type === 'task_cancel_requested').length, 1);
  assert.equal(log.filter((event) => event.type === 'task_cancelled').length, 1);
  assert.equal(terminalEvents(log).length, 1);
  assert.equal(h.fake.runFor(taskId).cancelCalls, 1);
});

test('cancels of a task and of its child at the same time leave one terminal event per task', async (t) => {
  const store = new GatedStore();
  const h = await makeHarness(t, { store });
  const conductor = h.session();
  const parent = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'p' });
  const child = await h.orchestrator.delegate(h.executorSession(parent.taskId), {
    runner: 'fake',
    brief: 'c',
  });
  await eventually(() => h.fake.runs.length === 2, 'runs');

  const release = store.holdNext('task_cancelled');
  const both = Promise.all([
    h.orchestrator.cancel(conductor, parent.taskId),
    h.orchestrator.cancel(conductor, child.taskId),
  ]);
  await eventually(() => store.held, 'task_cancelled held');
  release();
  await both;

  for (const id of [parent.taskId, child.taskId]) {
    assert.equal(terminalEvents(await events(h, id)).length, 1, id);
    assert.equal(h.fake.runFor(id).cancelCalls, 1, id);
  }
});

// An ancestor that ends takes its descendants with it.

test('a child whose start is pending when its parent fails is cancelled and never runs', async (t) => {
  const startGate = deferred();
  // The second run is the child's; it stays in start() until the gate opens.
  const h = await makeHarness(t, {
    fake: { onStart: () => (h.fake.runs.length === 2 ? startGate.promise : undefined) },
  });
  const conductor = h.session();
  const root = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'root' });
  const child = await h.orchestrator.delegate(h.executorSession(root.taskId), {
    runner: 'fake',
    brief: 'child',
  });
  await eventually(() => h.fake.runs.length === 2, 'both runs created');

  h.fake.runFor(root.taskId).fail('gave up');
  const view = await h.orchestrator.wait(conductor, child.taskId, 1000);
  assert.equal(view.state, 'cancelled');

  startGate.resolve();
  await h.orchestrator.settled();
  const log = await events(h, child.taskId);
  assert.ok(!log.some((event) => event.type === 'task_started'), JSON.stringify(log));
  assert.equal(terminalEvents(log).length, 1);
  assert.equal(h.fake.runFor(child.taskId).cancelCalls, 1);
});

test('a runner that comes up under an ancestor that already ended is cancelled at the hand-off', async (t) => {
  const store = new GatedStore();
  const startGate = deferred();
  const h = await makeHarness(t, {
    store,
    fake: { onStart: () => (h.fake.runs.length === 2 ? startGate.promise : undefined) },
  });
  const conductor = h.session();
  const root = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'root' });
  const child = await h.orchestrator.delegate(h.executorSession(root.taskId), {
    runner: 'fake',
    brief: 'child',
  });
  await eventually(() => h.fake.runs.length === 2, 'both runs created');

  // Hold the cascade at its first write, so the child is not marked yet when
  // the root has ended and its runner comes up.
  const release = store.holdNext('task_cancel_requested');
  h.fake.runFor(root.taskId).fail('gave up');
  await eventually(() => store.held, 'cascade request held');
  assert.equal(h.orchestrator.status(conductor, child.taskId).cancelRequested, false);

  startGate.resolve();
  await eventually(() => h.fake.runFor(child.taskId).cancelCalls === 1, 'handle cancelled', 1000);
  release();

  const view = await h.orchestrator.wait(conductor, child.taskId, 2000);
  assert.equal(view.state, 'cancelled');
  await h.orchestrator.settled();
  const log = await events(h, child.taskId);
  assert.ok(!log.some((event) => event.type === 'task_started'), JSON.stringify(log));
  assert.equal(terminalEvents(log).length, 1);
  assert.equal(h.fake.runFor(child.taskId).cancelCalls, 1);
  assert.ok(isTerminal(h.orchestrator.status(conductor, child.taskId).state));
});

// A runner's own failures must not cut the cleanup short.

/** A runner whose cancel throws before it returns a promise, as a bad adapter would. */
function throwOnCancel(run: FakeRun): void {
  run.cancel = () => {
    run.cancelCalls += 1;
    throw new Error('cancel exploded');
  };
}

test('a runner whose cancel throws synchronously does not stop the terminal cleanup', async (t) => {
  const h = await makeHarness(t, {
    // The first run is the root's; the child's cancel behaves.
    fake: { onStart: (run) => (run === h.fake.runs[0] ? throwOnCancel(run) : undefined) },
  });
  const conductor = h.session();
  const root = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'root' });
  const executor = h.executorSession(root.taskId);
  const child = await h.orchestrator.delegate(executor, { runner: 'fake', brief: 'child' });
  await eventually(() => h.fake.runs.length === 2, 'both runs created');
  const run = h.fake.runFor(root.taskId);
  await eventually(
    () => (h.orchestrator as unknown as { handles: Map<TaskId, unknown> }).handles.has(root.taskId),
    'handle registered',
  );

  // The stream breaks, so the root ends with its handle still registered and
  // the cleanup calls the cancel that throws.
  const internals = h.orchestrator as unknown as {
    executorSessions: Map<TaskId, SessionId>;
  };
  const launched = internals.executorSessions.get(root.taskId);
  assert.ok(launched !== undefined, 'the root was given an executor session');
  const ended = h.orchestrator.wait(conductor, root.taskId, 2000);
  run.crash(new Error('connection lost'));
  const view = await ended;
  assert.equal(view.state, 'failed');
  assert.equal(view.waitTimedOut, undefined, 'the waiter was woken, not timed out');
  assert.equal(run.cancelCalls, 1);

  await h.orchestrator.settled();
  assert.throws(() => h.orchestrator.assertSessionActive({ sessionId: launched }), isUnauthorized);
  assert.equal(h.orchestrator.status(conductor, child.taskId).state, 'cancelled');
  assert.equal(h.fake.runFor(child.taskId).cancelCalls, 1);
  assert.equal(h.orchestrator.stats().activeTasks, 0);
  assert.equal(h.orchestrator.stats().treesCounted, 0);
});

test('a cancel whose runner throws synchronously still ends the task as cancelled', async (t) => {
  const h = await makeHarness(t, { fake: { onStart: throwOnCancel } });
  const conductor = h.session();
  const { taskId } = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'x' });
  await eventually(
    () => (h.orchestrator as unknown as { handles: Map<TaskId, unknown> }).handles.has(taskId),
    'handle registered',
  );
  const view = await h.orchestrator.cancel(conductor, taskId);
  assert.equal(view.state, 'cancelled');
  assert.equal(h.fake.runFor(taskId).cancelCalls, 1);
  assert.equal(h.orchestrator.stats().activeTasks, 0);
});

test('a runner whose event stream ends without a result is cancelled when the task fails', async (t) => {
  const h = await makeHarness(t);
  const conductor = h.session();
  const { taskId } = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'x' });
  await eventually(() => h.fake.runs.length === 1, 'run created');
  const run = h.fake.runFor(taskId);
  const ended = h.orchestrator.wait(conductor, taskId, 2000);
  // A clean end of the stream does not prove the remote process stopped.
  run.end();
  const view = await ended;
  assert.equal(view.state, 'failed');
  assert.match(view.failureReason ?? '', /without reporting a result/u);
  assert.equal(run.cancelCalls, 1);
});

// The cascade has to cope with any number of children.

class WideStore extends MemoryTaskStore {
  /** Extra ended children reported for one parent. */
  wide: { parent: TaskId; count: number } | undefined;

  override childrenOf(taskId: TaskId): TaskId[] {
    const own = super.childrenOf(taskId);
    if (this.wide?.parent !== taskId) return own;
    // Ended children stay in the index, so a busy parent can have far more than
    // an argument list can carry.
    return [...own, ...Array.from({ length: this.wide.count }, (_, i) => `old-${i}`)];
  }
}

test('cancelling a task with a very large number of historical children still cancels it', async (t) => {
  const store = new WideStore();
  const h = await makeHarness(t, { store });
  const conductor = h.session();
  const { taskId } = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'x' });
  await eventually(() => h.fake.runs.length === 1, 'run created');
  store.wide = { parent: taskId, count: 500_000 };
  const view = await h.orchestrator.cancel(conductor, taskId);
  assert.equal(view.state, 'cancelled');
});
