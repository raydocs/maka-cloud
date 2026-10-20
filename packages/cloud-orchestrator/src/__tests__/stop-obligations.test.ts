import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import type { FakeRun, FakeRunnerOptions } from '../fake-runner.js';
import { RunnerRegistry } from '../runner.js';
import { MemoryTaskStore } from '../store.js';
import type { TaskEvent } from '../types.js';
import { eventually, makeHarness } from './harness.js';

/** Fast retries, so a test waits milliseconds for the next try. */
const FAST = { stopRetry: { firstMs: 1, maxMs: 2 } };

async function types(store: MemoryTaskStore, taskId: string): Promise<TaskEvent['type'][]> {
  return (await store.read()).filter((e) => e.event.taskId === taskId).map((e) => e.event.type);
}

/** A log with one task left running, as a crashed process would leave it. */
async function leftRunning(t: TestContext) {
  const store = new MemoryTaskStore();
  const first = await makeHarness(t, { store });
  const conductor = first.session();
  const { taskId } = await first.orchestrator.delegate(conductor, { runner: 'fake', brief: 'x' });
  await eventually(() => first.fake.runs.length === 1, 'run');
  return { store, dir: first.dir, taskId, conductor };
}

/** stopOrphaned that fails the first `failures` calls, then succeeds. */
function stopsAfter(failures: number): FakeRunnerOptions['stopOrphaned'] {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls <= failures) throw new Error('sandbox unreachable');
  };
}

test('a stop that fails at restart is owed and retried until it is confirmed; the task ending does not count as stopped', async (t) => {
  const { store, dir, taskId, conductor } = await leftRunning(t);
  const second = await makeHarness(t, {
    store,
    dir,
    orchestrator: FAST,
    fake: { stopOrphaned: stopsAfter(2) },
  });
  t.after(() => second.orchestrator.close());
  const ended = second.orchestrator.status(conductor, taskId);
  assert.equal(ended.state, 'failed');
  assert.equal(ended.stopPending, true, 'ended, but not stopped');
  assert.deepEqual((await types(store, taskId)).slice(-3), [
    'task_progress',
    'task_stop_pending',
    'task_failed',
  ]);

  await eventually(() => second.fake.orphanStops.length === 3, 'two retries');
  await eventually(
    () => second.orchestrator.status(conductor, taskId).stopPending === undefined,
    'the stop confirmed',
  );
  assert.deepEqual((await types(store, taskId)).slice(-1), ['task_stopped']);
  assert.equal(second.orchestrator.stats().stopRetries, 0);
});

test('a later process retries a stop that an earlier one could not confirm, though the task has ended', async (t) => {
  const { store, dir, taskId, conductor } = await leftRunning(t);
  const second = await makeHarness(t, {
    store,
    dir,
    fake: { stopOrphaned: stopsAfter(Number.POSITIVE_INFINITY) },
  });
  second.orchestrator.close();
  assert.deepEqual(store.activeTaskIds(), [], 'the task has ended');
  assert.deepEqual(store.stopPendingTaskIds(), [taskId]);

  const third = await makeHarness(t, {
    store,
    dir,
    orchestrator: FAST,
    fake: { stopOrphaned: stopsAfter(0) },
  });
  t.after(() => third.orchestrator.close());
  await eventually(() => store.stopPendingTaskIds().length === 0, 'the stop confirmed');
  assert.deepEqual(third.fake.orphanStops, [taskId]);
  assert.equal(third.orchestrator.status(conductor, taskId).stopPending, undefined);
});

test('close stops the retries and leaves the obligation in the log', async (t) => {
  const { store, dir, taskId } = await leftRunning(t);
  const second = await makeHarness(t, {
    store,
    dir,
    orchestrator: FAST,
    fake: { stopOrphaned: stopsAfter(Number.POSITIVE_INFINITY) },
  });
  await eventually(() => second.fake.orphanStops.length >= 3, 'retries');
  second.orchestrator.close();
  assert.equal(second.orchestrator.stats().stopRetries, 0);
  const calls = second.fake.orphanStops.length;
  // Many retry periods later, nothing more was tried.
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(second.fake.orphanStops.length <= calls + 1, 'at most the try already out finished');
  assert.deepEqual(store.stopPendingTaskIds(), [taskId]);
});

test('a cancel the runner refuses leaves the task cancelled and owing a stop, which is retried by id', async (t) => {
  const store = new MemoryTaskStore();
  const h = await makeHarness(t, {
    store,
    orchestrator: FAST,
    fake: {
      onStart: (run: FakeRun) => {
        run.cancel = async () => {
          throw new Error('sandbox unreachable');
        };
      },
      stopOrphaned: stopsAfter(1),
    },
  });
  t.after(() => h.orchestrator.close());
  const conductor = h.session();
  const { taskId } = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'x' });
  await eventually(() => h.fake.runs.length === 1, 'run');
  await eventually(() => h.orchestrator.status(conductor, taskId).state === 'running', 'started');
  const view = await h.orchestrator.cancel(conductor, taskId);
  assert.equal(view.state, 'cancelled');
  assert.equal(view.stopPending, true);
  const log = await types(store, taskId);
  assert.ok(
    log.indexOf('task_stop_pending') < log.indexOf('task_cancelled'),
    'owed before the task ended',
  );
  await eventually(() => store.stopPendingTaskIds().length === 0, 'the stop confirmed');
  assert.deepEqual(h.fake.orphanStops, [taskId, taskId]);
});

test('a task whose run stream broke owes a stop until the cancel of that run confirms it', async (t) => {
  const store = new MemoryTaskStore();
  const h = await makeHarness(t, { store, fake: { stopOrphaned: stopsAfter(0) } });
  t.after(() => h.orchestrator.close());
  const conductor = h.session();
  const { taskId } = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'x' });
  await eventually(() => h.fake.runs.length === 1, 'run');
  await eventually(() => h.orchestrator.status(conductor, taskId).state === 'running', 'started');
  h.fake.runFor(taskId).crash(new Error('connection lost'));
  await h.orchestrator.wait(conductor, taskId, 2000);
  await h.orchestrator.settled();
  assert.equal(h.fake.runFor(taskId).cancelled, true);
  assert.deepEqual((await types(store, taskId)).slice(-3), [
    'task_stop_pending',
    'task_failed',
    'task_stopped',
  ]);
  assert.equal(h.orchestrator.status(conductor, taskId).stopPending, undefined);
});

test('a task that ends while its runner is still starting owes a stop until the late run is cancelled', async (t) => {
  const store = new MemoryTaskStore();
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = await makeHarness(t, {
    store,
    fake: { onStart: () => held, stopOrphaned: stopsAfter(0) },
  });
  t.after(() => h.orchestrator.close());
  const conductor = h.session();
  const { taskId } = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'x' });
  await eventually(() => h.fake.runs.length === 1, 'start called');
  const view = await h.orchestrator.cancel(conductor, taskId);
  assert.equal(view.state, 'cancelled');
  assert.equal(view.stopPending, true, 'the start may still hand back a run');
  release();
  await eventually(() => store.stopPendingTaskIds().length === 0, 'the late run cancelled');
  assert.equal(h.fake.runFor(taskId).cancelled, true);
  assert.deepEqual((await types(store, taskId)).slice(-1), ['task_stopped']);
});

test('a runner that cannot stop by id never owes a stop', async (t) => {
  const store = new MemoryTaskStore();
  const h = await makeHarness(t, { store });
  const conductor = h.session();
  const { taskId } = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'x' });
  await eventually(() => h.fake.runs.length === 1, 'run');
  await eventually(() => h.orchestrator.status(conductor, taskId).state === 'running', 'started');
  h.fake.runFor(taskId).crash(new Error('connection lost'));
  await h.orchestrator.wait(conductor, taskId, 2000);
  await h.orchestrator.settled();
  const log = await types(store, taskId);
  assert.ok(!log.includes('task_stop_pending'));
  assert.equal(h.orchestrator.status(conductor, taskId).stopPending, undefined);
});

/** A log whose ended task owes a stop that its process could not confirm. */
async function owingStop(t: TestContext) {
  const { store, dir, taskId, conductor } = await leftRunning(t);
  const second = await makeHarness(t, {
    store,
    dir,
    fake: { stopOrphaned: stopsAfter(Number.POSITIVE_INFINITY) },
  });
  second.orchestrator.close();
  assert.deepEqual(store.stopPendingTaskIds(), [taskId]);
  return { store, dir, taskId, conductor };
}

/** Lets many retry periods of FAST pass. */
const manyRetryPeriods = () => new Promise((resolve) => setTimeout(resolve, 30));

test("a restart without the task's runner keeps the stop it owes: an unknown runner is not a stopped one", async (t) => {
  const { store, dir, taskId, conductor } = await owingStop(t);
  const third = await makeHarness(t, {
    store,
    dir,
    orchestrator: { ...FAST, runners: new RunnerRegistry([]) },
  });
  t.after(() => third.orchestrator.close());
  assert.equal(third.orchestrator.stats().stopRetries, 1, 'the stop is being retried');
  await manyRetryPeriods();
  assert.deepEqual(store.stopPendingTaskIds(), [taskId]);
  assert.ok(!(await types(store, taskId)).includes('task_stopped'));
  assert.equal(third.orchestrator.status(conductor, taskId).stopPending, true);
});

test('a restart whose runner can no longer stop by id keeps the stop owed until a runner confirms it', async (t) => {
  const { store, dir, taskId } = await owingStop(t);
  const third = await makeHarness(t, { store, dir, orchestrator: FAST });
  await manyRetryPeriods();
  third.orchestrator.close();
  assert.deepEqual(store.stopPendingTaskIds(), [taskId]);
  assert.ok(!(await types(store, taskId)).includes('task_stopped'));

  const fourth = await makeHarness(t, {
    store,
    dir,
    orchestrator: FAST,
    fake: { stopOrphaned: stopsAfter(0) },
  });
  t.after(() => fourth.orchestrator.close());
  await eventually(() => store.stopPendingTaskIds().length === 0, 'the stop confirmed');
  assert.deepEqual(fourth.fake.orphanStops, [taskId]);
});

test('a task left running whose runner is not registered at restart ends owing a stop', async (t) => {
  const { store, dir, taskId, conductor } = await leftRunning(t);
  const second = await makeHarness(t, {
    store,
    dir,
    orchestrator: { ...FAST, runners: new RunnerRegistry([]) },
  });
  t.after(() => second.orchestrator.close());
  const ended = second.orchestrator.status(conductor, taskId);
  assert.equal(ended.state, 'failed');
  assert.equal(ended.stopPending, true);
  assert.deepEqual(store.stopPendingTaskIds(), [taskId]);
});

test("a task's view says its tree may still run while a task below it owes a stop", async (t) => {
  const store = new MemoryTaskStore();
  let parentId = '';
  let starts = 0;
  let childStops = 0;
  const h = await makeHarness(t, {
    store,
    orchestrator: FAST,
    fake: {
      onStart: (run: FakeRun) => {
        starts += 1;
        // The first run is the parent's; its cancel works. The child's cannot.
        if (starts > 1) {
          run.cancel = async () => {
            throw new Error('sandbox unreachable');
          };
        }
      },
      stopOrphaned: async (taskId) => {
        if (taskId === parentId) return;
        childStops += 1;
        if (childStops <= 2) throw new Error('sandbox unreachable');
        // The run is gone, and its stream with it: the spend it reported is all there is.
        h.fake.runFor(taskId).end();
      },
    },
  });
  t.after(() => h.orchestrator.close());
  const conductor = h.session();
  const parent = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'parent' });
  parentId = parent.taskId;
  await eventually(() => h.fake.runs.length === 1, 'parent run');
  await eventually(
    () => h.orchestrator.status(conductor, parentId).state === 'running',
    'parent started',
  );
  const executor = h.executorSession(parentId);
  const child = await h.orchestrator.delegate(executor, { runner: 'fake', brief: 'child' });
  await eventually(() => h.fake.runs.length === 2, 'child run');
  await eventually(
    () => h.orchestrator.status(conductor, child.taskId).state === 'running',
    'child started',
  );

  const view = await h.orchestrator.cancel(conductor, parentId);
  assert.equal(view.state, 'cancelled');
  assert.equal(view.stopPending, undefined, 'the parent itself stopped');
  assert.equal(view.treeStopPending, true, 'its child may still run');
  assert.equal(
    h.orchestrator.status(conductor, parentId).treeStopPending,
    true,
    'status says so too',
  );
  assert.equal(h.orchestrator.status(conductor, child.taskId).stopPending, true);

  await eventually(() => store.stopPendingTaskIds().length === 0, 'the child stop confirmed');
  assert.equal(h.orchestrator.status(conductor, parentId).treeStopPending, undefined);
});

test('a task cancelled while its runner is still starting says it may still run, though its runner cannot stop by id', async (t) => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = await makeHarness(t, { fake: { onStart: () => held } });
  const conductor = h.session();
  const { taskId } = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'x' });
  await eventually(() => h.fake.runs.length === 1, 'start called');
  const view = await h.orchestrator.cancel(conductor, taskId);
  assert.equal(view.state, 'cancelled');
  assert.equal(view.stopPending, undefined, 'its runner cannot stop it by id');
  assert.equal(view.treeStopPending, true, 'the start may still hand back a run');
  assert.equal(h.orchestrator.status(conductor, taskId).treeStopPending, true);

  release();
  await h.orchestrator.settled();
  assert.equal(h.fake.runFor(taskId).cancelled, true, 'the late run is cancelled');
  assert.equal(h.orchestrator.status(conductor, taskId).treeStopPending, undefined);
});

/** A runner that cannot stop by id, whose runs' cancel fails until `works` is set. */
function cancelFailsUntil(h: { works: boolean; tries: number }) {
  return (run: FakeRun) => {
    const cancel = run.cancel.bind(run);
    run.cancel = async () => {
      h.tries += 1;
      if (!h.works) throw new Error('sandbox unreachable');
      await cancel();
    };
  };
}

test('a late run whose cancel fails, on a runner that cannot stop by id, reads as still running until a retried cancel succeeds', async (t) => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const cancels = { works: false, tries: 0 };
  const failing = cancelFailsUntil(cancels);
  const h = await makeHarness(t, {
    orchestrator: FAST,
    fake: {
      onStart: async (run: FakeRun) => {
        await held;
        failing(run);
      },
    },
  });
  t.after(() => h.orchestrator.close());
  const conductor = h.session();
  const { taskId } = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'x' });
  await eventually(() => h.fake.runs.length === 1, 'start called');
  const view = await h.orchestrator.cancel(conductor, taskId);
  assert.equal(view.state, 'cancelled');
  release();
  await eventually(() => cancels.tries >= 3, 'the cancel retried');
  // The run keeps going, and spending.
  h.fake.runFor(taskId).usage(1.4);
  await eventually(
    () => h.orchestrator.status(conductor, taskId).costUsd === 1.4,
    'spend recorded',
  );
  const running = h.orchestrator.status(conductor, taskId);
  assert.equal(running.stopPending, undefined, 'nothing can be owed by id');
  assert.equal(running.treeStopPending, true, 'its run is still going');

  cancels.works = true;
  await eventually(
    () => h.orchestrator.status(conductor, taskId).treeStopPending === undefined,
    'the cancel succeeded',
  );
  assert.equal(h.orchestrator.stats().stopRetries, 0);
});

test('a running task whose cancel fails, on a runner that cannot stop by id, ends cancelled but reads as still running until a retry succeeds', async (t) => {
  const cancels = { works: false, tries: 0 };
  const h = await makeHarness(t, {
    orchestrator: FAST,
    fake: { onStart: cancelFailsUntil(cancels) },
  });
  t.after(() => h.orchestrator.close());
  const conductor = h.session();
  const parent = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'x' });
  await eventually(
    () => h.orchestrator.status(conductor, parent.taskId).state === 'running',
    'started',
  );
  const view = await h.orchestrator.cancel(conductor, parent.taskId);
  assert.equal(view.state, 'cancelled');
  assert.equal(view.treeStopPending, true);
  cancels.works = true;
  await eventually(
    () => h.orchestrator.status(conductor, parent.taskId).treeStopPending === undefined,
    'the cancel succeeded',
  );
  assert.ok(cancels.tries >= 2);
});

test('a leftover run whose cancel fails, on a runner that cannot stop by id, keeps its task reading as running until a retry succeeds', async (t) => {
  const cancels = { works: false, tries: 0 };
  const h = await makeHarness(t, {
    orchestrator: FAST,
    fake: { onStart: cancelFailsUntil(cancels) },
  });
  t.after(() => h.orchestrator.close());
  const conductor = h.session();
  const { taskId } = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'x' });
  await eventually(() => h.orchestrator.status(conductor, taskId).state === 'running', 'started');
  h.fake.runFor(taskId).crash(new Error('connection lost'));
  const ended = await h.orchestrator.wait(conductor, taskId, 2000);
  assert.equal(ended.state, 'failed');
  assert.equal(ended.treeStopPending, true, 'the leftover run is being cancelled');
  await eventually(() => cancels.tries >= 2, 'the cancel retried');
  assert.equal(h.orchestrator.status(conductor, taskId).treeStopPending, true);
  cancels.works = true;
  await eventually(
    () => h.orchestrator.status(conductor, taskId).treeStopPending === undefined,
    'the cancel succeeded',
  );
});
