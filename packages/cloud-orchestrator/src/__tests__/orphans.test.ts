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
