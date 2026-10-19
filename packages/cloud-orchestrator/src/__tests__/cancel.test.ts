import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { OrchestratorError, type TaskId } from '../types.js';
import { eventually, type Harness, makeHarness } from './harness.js';

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

test('a parent that already ended does not shield its running children from cancel', async (t) => {
  const h = await makeHarness(t);
  const conductor = h.session();
  const parent = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'p' });
  const child = await h.orchestrator.delegate(h.executorSession(parent.taskId), {
    runner: 'fake',
    brief: 'c',
  });
  await eventually(() => h.fake.runs.length === 2, 'runs');
  await h.fake.runFor(parent.taskId).complete();
  await h.orchestrator.wait(conductor, parent.taskId, 2000);
  // The parent is terminal, so cancelling it is a no-op, but the child can be cancelled directly.
  await h.orchestrator.cancel(conductor, child.taskId);
  assert.equal(h.orchestrator.status(conductor, child.taskId).state, 'cancelled');
  assert.equal(h.fake.runFor(child.taskId).cancelCalls, 1);
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
