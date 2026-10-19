import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryTaskStore } from '../store.js';
import type { TaskEvent } from '../types.js';
import { eventually, makeHarness } from './harness.js';

/** A log with `count` tasks left running, as a crashed process would leave it. */
async function leftRunning(t: Parameters<typeof makeHarness>[0], count: number) {
  const store = new MemoryTaskStore();
  const first = await makeHarness(t, { store });
  const conductor = first.session();
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    ids.push(
      (await first.orchestrator.delegate(conductor, { runner: 'fake', brief: `t${i}` })).taskId,
    );
  }
  await eventually(() => first.fake.runs.length === count, 'runs');
  return { store, dir: first.dir, ids, conductor };
}

function types(events: { event: TaskEvent }[], taskId: string): string[] {
  return events.filter((e) => e.event.taskId === taskId).map((e) => e.event.type);
}

test('restore asks the runner to stop each task that was running, before it records the failure', async (t) => {
  const { store, dir, ids } = await leftRunning(t, 2);
  const logAtStop = new Map<string, string[]>();
  const second = await makeHarness(t, {
    store,
    dir,
    fake: {
      stopOrphaned: async (taskId) => {
        logAtStop.set(taskId, types(await store.read(), taskId));
      },
    },
  });
  assert.deepEqual([...second.fake.orphanStops].sort(), [...ids].sort());
  for (const id of ids) {
    assert.equal(logAtStop.get(id)?.includes('task_failed'), false, 'the stop came first');
    assert.deepEqual(types(await store.read(), id).slice(-1), ['task_failed']);
  }
});

test('tasks that already ended are not passed to the runner', async (t) => {
  const store = new MemoryTaskStore();
  const first = await makeHarness(t, { store });
  const conductor = first.session();
  const { taskId } = await first.orchestrator.delegate(conductor, { runner: 'fake', brief: 'x' });
  await eventually(() => first.fake.runs.length === 1, 'run');
  first.fake.runFor(taskId).fail('boom');
  await first.orchestrator.wait(conductor, taskId, 2000);

  const second = await makeHarness(t, {
    store,
    dir: first.dir,
    fake: { stopOrphaned: async () => {} },
  });
  assert.deepEqual(second.fake.orphanStops, []);
});

test('a runner that throws does not block restore, and the error is kept as a progress note', async (t) => {
  const { store, dir, ids, conductor } = await leftRunning(t, 1);
  const second = await makeHarness(t, {
    store,
    dir,
    fake: {
      stopOrphaned: async () => {
        throw new Error('sandbox said no');
      },
    },
  });
  const view = second.orchestrator.status(conductor, ids[0] as string);
  assert.equal(view.state, 'failed');
  assert.ok(view.progress.some((note) => note.includes('sandbox said no')));
});

test('orphans are stopped concurrently, and a runner that never answers is cut off after the timeout', async (t) => {
  const { store, dir, ids, conductor } = await leftRunning(t, 2);
  const started: string[] = [];
  const aborted: string[] = [];
  let bothStarted: () => void = () => {};
  const both = new Promise<void>((resolve) => {
    bothStarted = resolve;
  });
  const second = await makeHarness(t, {
    store,
    dir,
    orchestrator: { orphanStopTimeoutMs: 50 },
    fake: {
      stopOrphaned: (taskId, { signal }) =>
        new Promise<void>(() => {
          started.push(taskId);
          if (started.length === 2) bothStarted();
          signal?.addEventListener('abort', () => aborted.push(taskId));
        }),
    },
  });
  // Both calls were in flight at once: neither waited for the other to answer.
  await both;
  assert.deepEqual([...started].sort(), [...ids].sort());
  assert.deepEqual([...aborted].sort(), [...ids].sort());
  for (const id of ids) {
    const view = second.orchestrator.status(conductor, id);
    assert.equal(view.state, 'failed');
    assert.ok(view.progress.some((note) => note.includes('no answer after 50 ms')));
  }
});

test('a runner without stopOrphaned is fine', async (t) => {
  const { store, dir, ids, conductor } = await leftRunning(t, 1);
  const second = await makeHarness(t, { store, dir });
  assert.equal(second.orchestrator.status(conductor, ids[0] as string).state, 'failed');
});

test('restore records what runs spent in the crashed process before it ends their tasks', async (t) => {
  const store = new MemoryTaskStore();
  const first = await makeHarness(t, { store });
  const conductor = first.session();
  const top = await first.orchestrator.delegate(conductor, {
    runner: 'fake',
    brief: 'top',
    budgetUsd: 5,
  });
  await eventually(() => first.fake.runs.length === 1, 'top run');
  const child = await first.orchestrator.delegate(first.executorSession(top.taskId), {
    runner: 'fake',
    brief: 'child',
  });
  await eventually(() => first.fake.runs.length === 2, 'child run');
  // Recorded before the crash: 0.2 of the child's spend. The journal holds 0.2 settled plus an
  // open 0.5 reservation, and the top run's 0.1 that never reached the log.
  first.fake.runFor(child.taskId).usage(0.2);
  await eventually(
    () => first.orchestrator.status(conductor, top.taskId).costUsd === 0.2,
    'the child spend recorded',
  );
  const journal = [
    { taskId: child.taskId, usd: 0.7 },
    { taskId: top.taskId, usd: 0.1 },
    { taskId: 'tsk_unknown', usd: 3 },
  ];
  let recordedCalls = 0;
  await makeHarness(t, {
    store,
    dir: first.dir,
    fake: { stopOrphaned: async () => {} },
    orchestrator: {
      recoveredSpend: {
        unrecorded: () => journal,
        recorded: () => {
          recordedCalls++;
        },
      },
    },
  });
  assert.equal(recordedCalls, 1);
  const log = await store.read();
  // task_cost keeps the highest total per run: the child's 0.7 replaces its recorded 0.2.
  const spend = new Map<string, number>();
  for (const { event } of log) {
    if (event.type !== 'task_cost') continue;
    assert.equal(event.taskId, top.taskId, 'charged to the tree');
    spend.set(event.fromTaskId, Math.max(spend.get(event.fromTaskId) ?? 0, event.costUsd));
  }
  assert.deepEqual(Object.fromEntries(spend), { [child.taskId]: 0.7, [top.taskId]: 0.1 });
  const firstEnd = log.findIndex(
    ({ event }) => event.type === 'task_failed' || event.type === 'task_cancelled',
  );
  const lastCost = log.map(({ event }) => event.type).lastIndexOf('task_cost');
  assert.ok(firstEnd >= 0 && lastCost < firstEnd, 'the spend is in the log before any task ends');
});
