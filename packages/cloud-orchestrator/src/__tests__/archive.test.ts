import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_FAKE_MANIFEST } from '../fake-runner.js';
import { MemoryTaskStore } from '../store.js';
import { OrchestratorError, type TaskId } from '../types.js';
import { eventually, type Harness, makeHarness } from './harness.js';

/** A store that counts the lookups the orchestrator makes. */
class CountingStore extends MemoryTaskStore {
  readTaskCalls: TaskId[] = [];
  childrenCalls: TaskId[] = [];

  override readTask(taskId: TaskId) {
    this.readTaskCalls.push(taskId);
    return super.readTask(taskId);
  }

  override childrenOf(taskId: TaskId) {
    this.childrenCalls.push(taskId);
    return super.childrenOf(taskId);
  }
}

async function finish(h: Harness, session: ReturnType<Harness['session']>, taskId: TaskId) {
  await eventually(() => h.fake.runs.some((run) => run.spec.taskId === taskId), 'run');
  await h.fake.runFor(taskId).complete();
  await h.orchestrator.wait(session, taskId, 2000);
}

test('a finished task leaves memory and is still served from the store', async (t) => {
  const h = await makeHarness(t);
  const conductor = h.session();
  const { taskId } = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'x' });
  assert.equal(h.orchestrator.stats().activeTasks, 1);
  await finish(h, conductor, taskId);
  assert.equal(h.orchestrator.stats().activeTasks, 0);
  assert.equal(h.orchestrator.stats().treesCounted, 0);
  const view = h.orchestrator.status(conductor, taskId);
  assert.equal(view.state, 'succeeded');
  assert.equal(view.manifest?.summary, DEFAULT_FAKE_MANIFEST.summary);
});

test('a wait on a finished task returns at once and takes no wait slot', async (t) => {
  const h = await makeHarness(t, { orchestrator: { quotas: { maxWaits: 0 } } });
  const conductor = h.session();
  const { taskId } = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'x' });
  await eventually(() => h.fake.runs.length === 1, 'run');
  await h.fake.runFor(taskId).complete();
  await eventually(() => h.orchestrator.stats().activeTasks === 0, 'task archived');
  const view = await h.orchestrator.wait(conductor, taskId, 60_000);
  assert.equal(view.state, 'succeeded');
  assert.equal(view.waitTimedOut, undefined);
  assert.equal(h.orchestrator.stats().waitedTasks, 0);
});

test('a task whose ancestor ended and left memory cannot delegate', async (t) => {
  const h = await makeHarness(t);
  const conductor = h.session();
  const parent = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'p' });
  const parentSession = h.executorSession(parent.taskId);
  await finish(h, conductor, parent.taskId);
  assert.equal(h.orchestrator.stats().activeTasks, 0);
  await assert.rejects(
    h.orchestrator.delegate(parentSession, { runner: 'fake', brief: 'late child' }),
    (error: unknown) => error instanceof OrchestratorError && error.code === 'invalid_request',
  );
  assert.equal(h.fake.runs.length, 1);
});

test('cancel on an ended parent that left memory still reaches its running descendants', async (t) => {
  const h = await makeHarness(t);
  const conductor = h.session();
  const parent = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'p' });
  const child = await h.orchestrator.delegate(h.executorSession(parent.taskId), {
    runner: 'fake',
    brief: 'c',
  });
  const grandchild = await h.orchestrator.delegate(h.executorSession(child.taskId), {
    runner: 'fake',
    brief: 'g',
  });
  await eventually(() => h.fake.runs.length === 3, 'runs');
  await finish(h, conductor, parent.taskId);
  await finish(h, conductor, child.taskId);
  // Only the grandchild is still in memory; both ancestors above it have ended.
  assert.equal(h.orchestrator.stats().activeTasks, 1);

  const view = await h.orchestrator.cancel(conductor, parent.taskId);
  assert.equal(view.state, 'succeeded');
  assert.equal(h.orchestrator.status(conductor, grandchild.taskId).state, 'cancelled');
  assert.equal(h.fake.runFor(grandchild.taskId).cancelCalls, 1);
  assert.equal(h.orchestrator.status(conductor, child.taskId).state, 'succeeded');
});

test('cancel walks only the subtree it was asked to cancel', async (t) => {
  const store = new CountingStore();
  const h = await makeHarness(t, { store });
  const conductor = h.session();
  const root = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'r' });
  const child = await h.orchestrator.delegate(h.executorSession(root.taskId), {
    runner: 'fake',
    brief: 'c',
  });
  const others = [];
  for (let i = 0; i < 5; i += 1) {
    others.push(await h.orchestrator.delegate(conductor, { runner: 'fake', brief: `o${i}` }));
  }
  await eventually(() => h.fake.runs.length === 7, 'runs');
  store.childrenCalls = [];

  await h.orchestrator.cancel(conductor, root.taskId);
  const visited = new Set(store.childrenCalls);
  assert.ok(visited.has(root.taskId) && visited.has(child.taskId));
  for (const other of others) assert.ok(!visited.has(other.taskId), other.taskId);
});

test('a restart loads only unfinished tasks from the store', async (t) => {
  const store = new CountingStore();
  const first = await makeHarness(t, { store });
  const conductor = first.session();
  const finished: TaskId[] = [];
  for (let i = 0; i < 20; i += 1) {
    const { taskId } = await first.orchestrator.delegate(conductor, {
      runner: 'fake',
      brief: `done ${i}`,
    });
    await finish(first, conductor, taskId);
    finished.push(taskId);
  }
  const running = await first.orchestrator.delegate(conductor, { runner: 'fake', brief: 'live' });
  await eventually(() => first.fake.runs.length === 21, 'run');
  store.readTaskCalls = [];

  const second = await makeHarness(t, { store, dir: first.dir });
  assert.deepEqual(store.readTaskCalls.sort(), [running.taskId]);
  assert.deepEqual(second.orchestrator.orphanedTaskIds, [running.taskId]);
  assert.equal(second.orchestrator.stats().activeTasks, 0);
  assert.equal(second.orchestrator.stats().treesCounted, 0);
});

test('with the cache on, a finished task is read from the store once', async (t) => {
  const store = new CountingStore();
  const h = await makeHarness(t, {
    store,
    orchestrator: { caches: { archivedTasks: { maxEntries: 8 } } },
  });
  const conductor = h.session();
  const { taskId } = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'x' });
  await finish(h, conductor, taskId);
  for (let i = 0; i < 5; i += 1) h.orchestrator.status(conductor, taskId);
  // One read when the wait returned the finished task; every later one is a cache hit.
  assert.equal(store.readTaskCalls.filter((id) => id === taskId).length, 1);
});

test('the archive cache never holds more than its limits, by entries or bytes', async (t) => {
  const h = await makeHarness(t, {
    orchestrator: { caches: { archivedTasks: { maxEntries: 3, maxBytes: 1500 } } },
  });
  const conductor = h.session();
  for (let i = 0; i < 8; i += 1) {
    const { taskId } = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: `t${i}` });
    await finish(h, conductor, taskId);
    h.orchestrator.status(conductor, taskId);
    const { archivedCached, archivedCachedBytes } = h.orchestrator.stats();
    assert.ok(archivedCached <= 3, `entries ${archivedCached}`);
    assert.ok(archivedCachedBytes <= 1500, `bytes ${archivedCachedBytes}`);
  }
  assert.ok(h.orchestrator.stats().archivedCached > 0);
});

test('a cached finished task is never served after the store says otherwise: it cannot change', async (t) => {
  const h = await makeHarness(t, {
    orchestrator: { caches: { archivedTasks: { maxEntries: 8 } } },
  });
  const conductor = h.session();
  const { taskId } = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'x' });
  await eventually(() => h.fake.runs.length === 1, 'run');
  await h.orchestrator.cancel(conductor, taskId);
  const before = h.orchestrator.status(conductor, taskId);
  await h.fake.runFor(taskId).complete();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(h.orchestrator.status(conductor, taskId), before);
  assert.equal(before.state, 'cancelled');
});
