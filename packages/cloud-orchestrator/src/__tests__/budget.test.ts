import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FakeRun } from '../fake-runner.js';
import { OrchestratorError } from '../types.js';
import { eventQueued, eventually, GatedStore, makeHarness } from './harness.js';

test('a task tree shares its budget: the runner gets it, crossing it cancels the whole tree', async (t) => {
  const h = await makeHarness(t);
  const conductor = h.session();
  const top = await h.orchestrator.delegate(conductor, {
    runner: 'fake',
    brief: 'top',
    budgetUsd: 2,
  });
  await eventually(() => h.fake.runs.length === 1, 'the top run');
  const topRun = h.fake.runFor(top.taskId);
  assert.equal(topRun.spec.budgetUsd, 2);
  assert.equal(topRun.spec.budgetRootId, top.taskId);
  topRun.usage(0.5);

  // A child shares the tree's cap whatever it asks for: its runner gets what is left.
  const executor = h.executorSession(top.taskId);
  await eventually(() => h.orchestrator.status(conductor, top.taskId).costUsd === 0.5, 'usage');
  const child = await h.orchestrator.delegate(executor, {
    runner: 'fake',
    brief: 'child',
    budgetUsd: 50,
  });
  await eventually(() => h.fake.runs.length === 2, 'the child run');
  const childRun = h.fake.runFor(child.taskId);
  assert.equal(childRun.spec.budgetUsd, 1.5);
  assert.equal(
    childRun.spec.budgetRootId,
    top.taskId,
    'the child draws on its tree, not its own cap',
  );

  childRun.usage(1);
  await eventually(() => h.orchestrator.status(conductor, top.taskId).costUsd === 1.5, 'tree cost');
  assert.equal(h.orchestrator.status(conductor, top.taskId).state, 'running');

  // Usage is cumulative per run: 1.6 replaces 1, so the tree is at 2.1 of 2.
  childRun.usage(1.6);
  await eventually(
    () => h.orchestrator.status(conductor, top.taskId).state === 'cancelled',
    'the tree cancelled',
  );
  await h.orchestrator.settled();
  const view = h.orchestrator.status(conductor, top.taskId);
  assert.equal(view.costUsd, 2.1);
  assert.equal(view.budgetUsd, 2);
  assert.equal(view.budgetExceeded, true);
  assert.equal(h.orchestrator.status(conductor, child.taskId).state, 'cancelled');
  assert.equal(topRun.cancelled, true);
  assert.equal(childRun.cancelled, true);
  assert.equal(h.orchestrator.stats().activeTasks, 0);
});

test('nothing is created in a tree once its spend reached the cap, even before the cancel lands', async (t) => {
  const store = new GatedStore();
  const h = await makeHarness(t, { store });
  const conductor = h.session();
  const top = await h.orchestrator.delegate(conductor, {
    runner: 'fake',
    brief: 'top',
    budgetUsd: 1,
  });
  await eventually(() => h.fake.runs.length === 1, 'the top run');
  const executor = h.executorSession(top.taskId);
  // The usage that crosses the cap is held at its append; a delegation queues behind it.
  const releaseCost = store.holdNext('task_cost');
  h.fake.runFor(top.taskId).usage(1.25);
  await eventually(() => store.held, 'the usage append held');
  const queued = eventQueued(h, 'task_created');
  const child = h.orchestrator.delegate(executor, { runner: 'fake', brief: 'child' });
  await queued;
  releaseCost();
  await assert.rejects(
    child,
    (error: unknown) => error instanceof OrchestratorError && error.code === 'budget_exceeded',
  );
  await h.orchestrator.settled();
  assert.equal(h.orchestrator.status(conductor, top.taskId).state, 'cancelled');
  assert.equal(h.fake.runs.length, 1);
});

test('a tree without a budget is not capped, and its spend stays readable after it ended', async (t) => {
  const h = await makeHarness(t, {
    fake: { onStart: (run: FakeRun) => run.usage(30) },
  });
  const conductor = h.session();
  const task = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'x' });
  await eventually(() => h.orchestrator.status(conductor, task.taskId).costUsd === 30, 'usage');
  assert.equal(h.orchestrator.status(conductor, task.taskId).state, 'running');
  assert.equal(h.orchestrator.status(conductor, task.taskId).budgetUsd, undefined);
  assert.equal(h.fake.runFor(task.taskId).spec.budgetRootId, undefined);
  await h.fake.runFor(task.taskId).complete();
  await eventually(
    () => h.orchestrator.status(conductor, task.taskId).state === 'succeeded',
    'done',
  );
  assert.equal(h.orchestrator.status(conductor, task.taskId).costUsd, 30);
});

test('a budget must be a positive number', async (t) => {
  const h = await makeHarness(t);
  for (const budgetUsd of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      h.orchestrator.delegate(h.session(), { runner: 'fake', brief: 'x', budgetUsd }),
      (error: unknown) => error instanceof OrchestratorError && error.code === 'invalid_request',
    );
  }
});

/** A run whose cancel reports what settled while it stopped, as a metered runner's does. */
function settlesOnCancel(run: FakeRun, finalUsd: number): void {
  const cancel = run.cancel.bind(run);
  run.cancel = async () => {
    run.usage(finalUsd);
    await cancel();
  };
}

test('spend a run reports while it is cancelled is recorded', async (t) => {
  const h = await makeHarness(t, {
    fake: { onStart: (run: FakeRun) => settlesOnCancel(run, 0.7) },
  });
  const conductor = h.session();
  const task = await h.orchestrator.delegate(conductor, {
    runner: 'fake',
    brief: 'x',
    budgetUsd: 5,
  });
  await eventually(() => h.fake.runs.length === 1, 'the run');
  h.fake.runFor(task.taskId).usage(0.2);
  await eventually(() => h.orchestrator.status(conductor, task.taskId).costUsd === 0.2, 'usage');
  await h.orchestrator.cancel(conductor, task.taskId);
  await eventually(
    () => h.orchestrator.status(conductor, task.taskId).costUsd === 0.7,
    'the spend that settled during the cancel',
  );
  assert.equal(h.orchestrator.status(conductor, task.taskId).state, 'cancelled');
});

test('spend a child reports after its top-level task ended is recorded on the ended task', async (t) => {
  const h = await makeHarness(t, {
    fake: { onStart: (run: FakeRun) => settlesOnCancel(run, 0.4) },
  });
  const conductor = h.session();
  const top = await h.orchestrator.delegate(conductor, {
    runner: 'fake',
    brief: 'top',
    budgetUsd: 5,
  });
  await eventually(() => h.fake.runs.length === 1, 'the top run');
  const child = await h.orchestrator.delegate(h.executorSession(top.taskId), {
    runner: 'fake',
    brief: 'child',
  });
  await eventually(() => h.fake.runs.length === 2, 'the child run');
  // Read once ended, so the ended record is cached before the late spend arrives.
  await h.fake.runFor(top.taskId).complete();
  await eventually(
    () => h.orchestrator.status(conductor, top.taskId).state === 'succeeded',
    'the top task ended',
  );
  await h.orchestrator.settled();
  assert.equal(h.fake.runFor(child.taskId).cancelled, true, 'the end cancelled the child');
  await eventually(
    () => h.orchestrator.status(conductor, top.taskId).costUsd === 0.4,
    'the child spend after the end',
  );
  assert.equal(h.orchestrator.status(conductor, top.taskId).state, 'succeeded');
});
