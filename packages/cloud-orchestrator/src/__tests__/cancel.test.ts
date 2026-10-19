import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { OrchestratorError, type TaskId } from '../types.js';
import { eventQueued, eventually, GatedStore, type Harness, makeHarness } from './harness.js';

async function startTree(h: Harness) {
  const conductor = h.session();
  const parent = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'parent' });
  const parentSession = h.executorSession(parent.taskId);
  const childA = await h.orchestrator.delegate(parentSession, { runner: 'fake', brief: 'a' });
  const childB = await h.orchestrator.delegate(parentSession, { runner: 'fake', brief: 'b' });
  const grandchild = await h.orchestrator.delegate(h.executorSession(childA.taskId), {
    runner: 'fake',
    brief: 'a1',
  });
  const other = await h.orchestrator.delegate(h.session(), { runner: 'fake', brief: 'unrelated' });
  await eventually(() => h.fake.runs.length === 5, 'five runs');
  return { conductor, parent, parentSession, childA, childB, grandchild, other };
}

test('cancel propagates to every descendant, children first, and leaves other trees alone', async (t) => {
  const h = await makeHarness(t);
  const cancelOrder: TaskId[] = [];
  const tree = await startTree(h);
  for (const run of h.fake.runs) {
    const original = run.cancel.bind(run);
    run.cancel = async () => {
      cancelOrder.push(run.spec.taskId);
      await original();
    };
  }

  const view = await h.orchestrator.cancel(tree.conductor, tree.parent.taskId);
  assert.equal(view.state, 'cancelled');

  for (const id of [
    tree.parent.taskId,
    tree.childA.taskId,
    tree.childB.taskId,
    tree.grandchild.taskId,
  ]) {
    assert.equal(h.orchestrator.status(tree.conductor, id).state, 'cancelled', id);
    assert.equal(h.fake.runFor(id).cancelCalls, 1, id);
  }
  assert.ok(cancelOrder.indexOf(tree.grandchild.taskId) < cancelOrder.indexOf(tree.childA.taskId));
  assert.ok(cancelOrder.indexOf(tree.childA.taskId) < cancelOrder.indexOf(tree.parent.taskId));
  assert.ok(cancelOrder.indexOf(tree.childB.taskId) < cancelOrder.indexOf(tree.parent.taskId));

  const other = h.fake.runFor(tree.other.taskId);
  assert.equal(other.cancelCalls, 0);
});

test('cancelling a child leaves its parent and siblings running', async (t) => {
  const h = await makeHarness(t);
  const tree = await startTree(h);
  await h.orchestrator.cancel(tree.parentSession, tree.childA.taskId);
  assert.equal(h.orchestrator.status(tree.conductor, tree.childA.taskId).state, 'cancelled');
  assert.equal(h.orchestrator.status(tree.conductor, tree.grandchild.taskId).state, 'cancelled');
  assert.equal(h.orchestrator.status(tree.conductor, tree.childB.taskId).state, 'running');
  assert.equal(h.orchestrator.status(tree.conductor, tree.parent.taskId).state, 'running');
});

test('cancel keeps the final state of tasks that already ended', async (t) => {
  const h = await makeHarness(t);
  const conductor = h.session();
  const parent = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'p' });
  const child = await h.orchestrator.delegate(h.executorSession(parent.taskId), {
    runner: 'fake',
    brief: 'c',
  });
  await eventually(() => h.fake.runs.length === 2, 'runs');
  await h.fake.runFor(child.taskId).complete();
  await h.orchestrator.wait(conductor, child.taskId, 2000);
  await h.orchestrator.cancel(conductor, parent.taskId);
  assert.equal(h.orchestrator.status(conductor, child.taskId).state, 'succeeded');
  assert.equal(h.fake.runFor(child.taskId).cancelCalls, 0);
  const again = await h.orchestrator.cancel(conductor, child.taskId);
  assert.equal(again.state, 'succeeded');
});

test('a task that ends cancels the children still running below it, without a cancel call', async (t) => {
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
  await h.fake.runFor(parent.taskId).complete();
  // Waiting on the descendants is the signal that the cascade ran.
  await h.orchestrator.wait(conductor, child.taskId, 2000);
  await h.orchestrator.wait(conductor, grandchild.taskId, 2000);
  assert.equal(h.orchestrator.status(conductor, parent.taskId).state, 'succeeded');
  assert.equal(h.orchestrator.status(conductor, child.taskId).state, 'cancelled');
  assert.equal(h.orchestrator.status(conductor, grandchild.taskId).state, 'cancelled');
  assert.equal(h.fake.runFor(child.taskId).cancelCalls, 1);
  assert.equal(h.fake.runFor(grandchild.taskId).cancelCalls, 1);
  assert.equal(h.fake.runFor(parent.taskId).cancelCalls, 0);
  // An explicit cancel afterwards finds nothing left to do.
  const view = await h.orchestrator.cancel(conductor, parent.taskId);
  assert.equal(view.state, 'succeeded');
  assert.equal(h.fake.runFor(child.taskId).cancelCalls, 1);
});

test('a task that fails cancels its descendants, deepest first', async (t) => {
  const h = await makeHarness(t);
  const conductor = h.session();
  const root = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'root' });
  const mid = await h.orchestrator.delegate(h.executorSession(root.taskId), {
    runner: 'fake',
    brief: 'mid',
  });
  const leaf = await h.orchestrator.delegate(h.executorSession(mid.taskId), {
    runner: 'fake',
    brief: 'leaf',
  });
  await eventually(() => h.fake.runs.length === 3, 'runs');
  const cancelOrder: TaskId[] = [];
  for (const id of [mid.taskId, leaf.taskId]) {
    const run = h.fake.runFor(id);
    const original = run.cancel.bind(run);
    run.cancel = async () => {
      cancelOrder.push(id);
      await original();
    };
  }
  h.fake.runFor(root.taskId).fail('gave up');
  await h.orchestrator.wait(conductor, mid.taskId, 2000);
  await h.orchestrator.wait(conductor, leaf.taskId, 2000);
  assert.equal(h.orchestrator.status(conductor, root.taskId).state, 'failed');
  assert.equal(h.orchestrator.status(conductor, mid.taskId).state, 'cancelled');
  assert.equal(h.orchestrator.status(conductor, leaf.taskId).state, 'cancelled');
  assert.deepEqual(cancelOrder, [leaf.taskId, mid.taskId]);
});

test('a runner that finishes after the cancel does not change the outcome', async (t) => {
  const h = await makeHarness(t);
  const conductor = h.session();
  const { taskId } = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'x' });
  await eventually(() => h.fake.runs.length === 1, 'run');
  await h.orchestrator.cancel(conductor, taskId);
  await h.fake.runFor(taskId).complete();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const view = h.orchestrator.status(conductor, taskId);
  assert.equal(view.state, 'cancelled');
  assert.equal(view.manifest, undefined);
});

test('a task cancelled while its runner is still starting is cancelled once the runner is up', async (t) => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = await makeHarness(t, { fake: { onStart: () => gate } });
  const conductor = h.session();
  const { taskId } = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'x' });
  await eventually(() => h.fake.runs.length === 1, 'run created');
  await h.orchestrator.cancel(conductor, taskId);
  assert.equal(h.orchestrator.status(conductor, taskId).state, 'cancelled');
  release();
  await eventually(() => h.fake.runFor(taskId).cancelCalls === 1, 'late cancel');
  assert.equal(h.orchestrator.status(conductor, taskId).state, 'cancelled');
});

test('a task whose ancestor is being cancelled cannot delegate', async (t) => {
  const h = await makeHarness(t);
  const conductor = h.session();
  const parent = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'p' });
  const parentSession = h.executorSession(parent.taskId);
  await eventually(() => h.fake.runs.length === 1, 'run');
  await h.orchestrator.cancel(conductor, parent.taskId);
  await assert.rejects(
    h.orchestrator.delegate(parentSession, { runner: 'fake', brief: 'late child' }),
    (error: unknown) => error instanceof OrchestratorError && error.code === 'invalid_request',
  );
});

test('a cancel that finishes while a delegate is writing its brief leaves no child behind', async (t) => {
  let cancelling: Promise<unknown> = Promise.resolve();
  let onNewTask: () => void = () => {};
  const h = await makeHarness(t, {
    orchestrator: {
      // Runs after delegate's first check and before its brief is written. The
      // cancel needs no real I/O, so it finishes before the brief write does.
      newTaskId: () => {
        onNewTask();
        return `tsk_${globalThis.crypto.randomUUID().replaceAll('-', '')}`;
      },
    },
  });
  const conductor = h.session();
  const parent = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'p' });
  const parentSession = h.executorSession(parent.taskId);
  await eventually(() => h.fake.runs.length === 1, 'run');
  const eventsBefore = (await h.store.read()).length;

  onNewTask = () => {
    onNewTask = () => {};
    cancelling = h.orchestrator.cancel(conductor, parent.taskId);
  };
  await assert.rejects(
    h.orchestrator.delegate(parentSession, { runner: 'fake', brief: 'late child' }),
    (error: unknown) => error instanceof OrchestratorError && error.code === 'invalid_request',
  );
  await cancelling;

  const created = (await h.store.read(eventsBefore)).filter(
    ({ event }) => event.type === 'task_created',
  );
  assert.deepEqual(created, []);
  assert.equal(h.fake.runs.length, 1);
  assert.deepEqual(await readdir(h.dir), [parent.taskId]);
});

test('a task whose ancestor has ended cannot delegate', async (t) => {
  const h = await makeHarness(t);
  const conductor = h.session();
  const root = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'root' });
  const mid = await h.orchestrator.delegate(h.executorSession(root.taskId), {
    runner: 'fake',
    brief: 'mid',
  });
  const midSession = h.executorSession(mid.taskId);
  await eventually(() => h.fake.runs.length === 2, 'runs');
  h.fake.runFor(root.taskId).fail('done early');
  await h.orchestrator.wait(conductor, root.taskId, 2000);
  await assert.rejects(
    h.orchestrator.delegate(midSession, { runner: 'fake', brief: 'late child' }),
    (error: unknown) => error instanceof OrchestratorError && error.code === 'invalid_request',
  );
  assert.equal(h.fake.runs.length, 2);
});

test('an ancestor that ends while a delegate is writing its brief leaves no child behind', async (t) => {
  let onNewTask: () => void = () => {};
  const h = await makeHarness(t, {
    orchestrator: {
      newTaskId: () => {
        onNewTask();
        return `tsk_${globalThis.crypto.randomUUID().replaceAll('-', '')}`;
      },
    },
  });
  const conductor = h.session();
  const root = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'root' });
  const mid = await h.orchestrator.delegate(h.executorSession(root.taskId), {
    runner: 'fake',
    brief: 'mid',
  });
  const midSession = h.executorSession(mid.taskId);
  await eventually(() => h.fake.runs.length === 2, 'runs');
  const eventsBefore = (await h.store.read()).length;

  onNewTask = () => {
    onNewTask = () => {};
    h.fake.runFor(root.taskId).fail('done early');
  };
  await assert.rejects(
    h.orchestrator.delegate(midSession, { runner: 'fake', brief: 'late child' }),
    (error: unknown) => error instanceof OrchestratorError && error.code === 'invalid_request',
  );

  const created = (await h.store.read(eventsBefore)).filter(
    ({ event }) => event.type === 'task_created',
  );
  assert.deepEqual(created, []);
  assert.equal(h.fake.runs.length, 2);
  assert.deepEqual((await readdir(h.dir)).sort(), [mid.taskId, root.taskId].sort());
});

for (const outcome of ['finishes', 'fails'] as const) {
  test(`a runner that ${outcome} after the cancel was requested cannot change the final state`, async (t) => {
    const store = new GatedStore();
    const h = await makeHarness(t, { store });
    const conductor = h.session();
    const { taskId } = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'x' });
    await eventually(() => h.fake.runs.length === 1, 'run');
    const run = h.fake.runFor(taskId);

    // The cancel request is on its way into the log but not applied yet, so the
    // runner's report still sees a live task and queues up behind it.
    const release = store.holdNext('task_cancel_requested');
    const cancelling = h.orchestrator.cancel(conductor, taskId);
    await eventually(() => store.held, 'cancel request held');
    const reported = eventQueued(h, outcome === 'finishes' ? 'task_succeeded' : 'task_failed');
    if (outcome === 'finishes') await run.complete();
    else run.fail('boom');
    await reported;
    release();

    const view = await cancelling;
    assert.equal(view.state, 'cancelled');
    assert.equal(view.manifest, undefined);
    assert.equal(view.failureReason, undefined);
    const types = (await store.read()).map(({ event }) => event.type);
    assert.ok(!types.includes('task_succeeded'), types.join());
    assert.ok(!types.includes('task_failed'), types.join());
  });
}

test('a runner that cannot start after the cancel was requested ends cancelled, not failed', async (t) => {
  const store = new GatedStore();
  let failStart: () => void = () => {};
  const startGate = new Promise<void>((resolve) => {
    failStart = resolve;
  });
  const h = await makeHarness(t, {
    store,
    fake: {
      onStart: async () => {
        await startGate;
        throw new Error('no sandbox');
      },
    },
  });
  const conductor = h.session();
  const { taskId } = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'x' });
  await eventually(() => h.fake.runs.length === 1, 'run created');
  const release = store.holdNext('task_cancel_requested');
  const cancelling = h.orchestrator.cancel(conductor, taskId);
  await eventually(() => store.held, 'cancel request held');
  const reported = eventQueued(h, 'task_failed');
  failStart();
  await reported;
  release();
  assert.equal((await cancelling).state, 'cancelled');
  assert.equal(h.orchestrator.status(conductor, taskId).failureReason, undefined);
});

test('a runner whose cancel throws is still recorded as cancelled', async (t) => {
  const h = await makeHarness(t);
  const conductor = h.session();
  const { taskId } = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'x' });
  await eventually(() => h.fake.runs.length === 1, 'run');
  h.fake.runFor(taskId).cancel = async () => {
    throw new Error('sandbox unreachable');
  };
  const view = await h.orchestrator.cancel(conductor, taskId);
  assert.equal(view.state, 'cancelled');
  assert.ok(view.progress.some((note) => note.includes('sandbox unreachable')));
});
