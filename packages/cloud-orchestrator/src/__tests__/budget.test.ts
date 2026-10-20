import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FakeRun } from '../fake-runner.js';
import type { RunnerEvent } from '../runner.js';
import { MemoryTaskStore } from '../store.js';
import { OrchestratorError, type StoredEvent, type TaskEvent } from '../types.js';
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

/** A run whose stream reaches the orchestrator a macrotask late, as a slow transport does. */
function slowStream(run: FakeRun): void {
  const source = run.events;
  const slow: AsyncIterable<RunnerEvent> = {
    [Symbol.asyncIterator]: () => {
      const iterator = source[Symbol.asyncIterator]();
      return {
        next: async () => {
          await new Promise<void>((resolve) => setImmediate(resolve));
          return iterator.next();
        },
        return: () => iterator.return?.() ?? Promise.resolve({ done: true, value: undefined }),
      };
    },
  };
  Object.defineProperty(run, 'events', { value: slow });
}

test('a cancel returns the spend the run reported while it stopped', async (t) => {
  const h = await makeHarness(t, {
    fake: {
      onStart: (run: FakeRun) => {
        settlesOnCancel(run, 0.7);
        slowStream(run);
      },
    },
  });
  const conductor = h.session();
  const task = await h.orchestrator.delegate(conductor, {
    runner: 'fake',
    brief: 'x',
    budgetUsd: 5,
  });
  await eventually(() => h.fake.runs.length === 1, 'the run');
  const view = await h.orchestrator.cancel(conductor, task.taskId);
  assert.equal(view.state, 'cancelled');
  assert.equal(view.costUsd, 0.7, 'what settled during the cancel is in the view it returns');
  assert.equal(view.treeStopPending, undefined);
});

test('a cancel whose stream stays open reads as possibly spending until the stream ends', async (t) => {
  // The run stops on cancel() but keeps its stream open: the spend it will still report is not in yet.
  const h = await makeHarness(t, {
    orchestrator: { controlTimeoutMs: 10 },
    fake: {
      onStart: (run: FakeRun) => {
        run.cancel = async () => {
          run.cancelCalls += 1;
        };
      },
    },
  });
  const conductor = h.session();
  const task = await h.orchestrator.delegate(conductor, {
    runner: 'fake',
    brief: 'x',
    budgetUsd: 5,
  });
  await eventually(() => h.fake.runs.length === 1, 'the run');
  const run = h.fake.runFor(task.taskId);
  const view = await h.orchestrator.cancel(conductor, task.taskId);
  assert.equal(view.state, 'cancelled');
  assert.equal(view.treeStopPending, true, 'the cost of the task is not final');
  run.usage(0.7);
  run.end();
  await eventually(
    () => h.orchestrator.status(conductor, task.taskId).treeStopPending === undefined,
    'the stream ended',
  );
  assert.equal(h.orchestrator.status(conductor, task.taskId).costUsd, 0.7);
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

function gate() {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

test('spend a run reports while it is cancelled at the hand-off is recorded', async (t) => {
  const started = gate();
  const h = await makeHarness(t, {
    fake: {
      onStart: async (run: FakeRun) => {
        settlesOnCancel(run, 0.6);
        await started.promise;
      },
    },
  });
  const conductor = h.session();
  const task = await h.orchestrator.delegate(conductor, {
    runner: 'fake',
    brief: 'x',
    budgetUsd: 5,
  });
  await eventually(() => h.fake.runs.length === 1, 'the run is starting');
  // Cancelled while its runner is still starting: the late handle is cancelled when it comes up.
  await h.orchestrator.cancel(conductor, task.taskId);
  started.open();
  await h.orchestrator.settled();
  assert.equal(h.fake.runFor(task.taskId).cancelCalls, 1);
  assert.equal(h.orchestrator.status(conductor, task.taskId).costUsd, 0.6);
});

test('spend a run reports after its start was dropped is recorded', async (t) => {
  const store = new GatedStore();
  const childStarted = gate();
  const finalUsd = [2, 0, 0.3];
  const h = await makeHarness(t, {
    store,
    fake: {
      onStart: async (run: FakeRun) => {
        const index = h.fake.runs.length - 1;
        settlesOnCancel(run, finalUsd[index] ?? 0);
        if (index === 2) await childStarted.promise;
      },
    },
  });
  const conductor = h.session();
  const top = await h.orchestrator.delegate(conductor, {
    runner: 'fake',
    brief: 'top',
    budgetUsd: 1,
  });
  await eventually(() => h.fake.runs.length === 1, 'the top run');
  const executor = h.executorSession(top.taskId);
  const sibling = await h.orchestrator.delegate(executor, { runner: 'fake', brief: 'sibling' });
  await eventually(() => h.fake.runs.length === 2, 'the sibling run');
  const child = await h.orchestrator.delegate(executor, { runner: 'fake', brief: 'child' });
  await eventually(() => h.fake.runs.length === 3, 'the child is starting');

  // Hold the write chain, then queue the spend that crosses the cap ahead of the child's start.
  const release = store.holdNext('task_progress');
  h.fake.runFor(sibling.taskId).progress('busy');
  await eventually(() => store.held, 'the chain is held');
  const costQueued = eventQueued(h, 'task_cost');
  h.fake.runFor(top.taskId).usage(2);
  await costQueued;
  const startQueued = eventQueued(h, 'task_started');
  childStarted.open();
  await startQueued;
  release();

  await h.orchestrator.settled();
  const log = (await h.store.read()).map(({ event }) => event);
  assert.ok(
    !log.some((event) => event.type === 'task_started' && event.taskId === child.taskId),
    'the child start was dropped: the tree was over budget by then',
  );
  assert.equal(h.fake.runFor(child.taskId).cancelCalls, 1);
  await eventually(
    () => h.orchestrator.status(conductor, top.taskId).costUsd === 2.3,
    'the child spend settled during its cancel',
  );
});

/** A store whose next append of one kind fails once, as a transient store error would. */
class FlakyStore extends MemoryTaskStore {
  failNext: TaskEvent['type'] | undefined;

  override async append(event: TaskEvent, at: number): Promise<StoredEvent> {
    if (event.type === this.failNext) {
      this.failNext = undefined;
      throw new Error('the store is unavailable');
    }
    return super.append(event, at);
  }
}

test('a run whose start cannot be recorded is cancelled, and what it spent is still read', async (t) => {
  const store = new FlakyStore();
  store.failNext = 'task_started';
  const h = await makeHarness(t, {
    store,
    fake: {
      onStart: (run: FakeRun) => {
        // Spend reported before the start is written, and spend that settles during the cancel.
        run.usage(0.2);
        settlesOnCancel(run, 0.5);
      },
    },
  });
  const conductor = h.session();
  const task = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'x' });
  await eventually(() => h.fake.runs.length === 1, 'the run');
  await h.orchestrator.settled();
  assert.equal(h.fake.runFor(task.taskId).cancelCalls, 1, 'the unrecorded run is stopped');
  await eventually(
    () => h.orchestrator.status(conductor, task.taskId).costUsd === 0.5,
    'the final spend is read after the start failed',
  );
  const status = h.orchestrator.status(conductor, task.taskId);
  assert.equal(status.state, 'failed');
});
