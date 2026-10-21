import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FakeRunnerOptions } from '../fake-runner.js';
import { reduce } from '../reducer.js';
import { MemorySessionStore } from '../auth.js';
import { MemoryTaskStore } from '../store.js';
import type { TaskId } from '../types.js';
import { eventually, makeHarness } from './harness.js';

type Test = Parameters<typeof makeHarness>[0];

/** A task running under a plain runner, as a crashed process would leave it. */
async function running(t: Test) {
  const store = new MemoryTaskStore();
  const first = await makeHarness(t, { store });
  const conductor = first.session();
  const { taskId } = await first.orchestrator.delegate(conductor, { runner: 'fake', brief: 'x' });
  await eventually(() => first.fake.runs.length === 1, 'run');
  await eventually(
    () => first.orchestrator.status(conductor, taskId).state === 'running',
    'running',
  );
  return { store, first, taskId };
}

/** A restart that decided to resume the task and has not started its run yet. */
const waiting = (t: Test, store: MemoryTaskStore, dir: string, fake: FakeRunnerOptions = {}) =>
  makeHarness(t, {
    store,
    dir,
    fake: { recover: true, ...fake },
    orchestrator: { resume: 'manual' },
  });

const epochOf = (store: MemoryTaskStore, taskId: TaskId) =>
  reduce(store.readTask(taskId)).get(taskId)?.epoch;

test('a restart whose turn to start comes late finds a newer attempt drives the task: it starts no second run and writes nothing', async (t) => {
  const { store, first, taskId } = await running(t);
  // A (epoch 2) decided to resume and waits; B (epoch 3) took the task over after it and runs it.
  const a = await waiting(t, store, first.dir);
  assert.equal(epochOf(store, taskId), 2);
  const b = await waiting(t, store, first.dir);
  assert.equal(epochOf(store, taskId), 3);
  b.orchestrator.startRestored();
  await eventually(() => b.fake.recoveries.length === 1, 'the newer attempt to run the task');

  const before = (await store.read()).length;
  a.orchestrator.startRestored();
  await a.orchestrator.settled();
  assert.equal(a.fake.recoveries.length, 0, 'the stale plan did not start a second run');
  assert.equal(a.fake.runs.length, 0);
  assert.equal(b.fake.recoveries.length, 1);
  assert.equal(a.orchestrator.stats().activeTasks, 0, 'it let go of the task');
  const added = (await store.read()).slice(before).map((entry) => entry.event.type);
  assert.deepEqual(added, [], 'nothing of the stale plan reached the log');
  assert.equal(reduce(store.readTask(taskId)).get(taskId)?.state, 'running');
});

test('a takeover that lands while the run is starting cancels the late run at once, not at its first write', async (t) => {
  const { store, first, taskId } = await running(t);
  // The run A starts is slow to come back; the newer attempt B gets in meanwhile.
  let arrive!: () => void;
  const arrives = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  let starting!: () => void;
  const underWay = new Promise<void>((resolve) => {
    starting = resolve;
  });
  const a = await waiting(t, store, first.dir, {
    onStart: async () => {
      starting();
      await arrives;
    },
  });
  a.orchestrator.startRestored();
  await underWay;
  const b = await waiting(t, store, first.dir);
  assert.equal(epochOf(store, taskId), 3);
  b.orchestrator.startRestored();
  await eventually(() => b.fake.recoveries.length === 1, 'the newer attempt to run the task');
  arrive();
  await a.orchestrator.settled();
  const late = a.fake.runs[0];
  assert.ok(late, 'the run was started');
  await eventually(() => late.cancelCalls > 0, 'the late run to be cancelled');
  assert.equal(a.orchestrator.stats().activeTasks, 0);
});

/**
 * A restart (A, epoch 2) whose stop of the leftover run is slow, and a second restart (B,
 * epoch 3) that takes the task over and runs it meanwhile. `finish` lets A's stop come back.
 */
async function slowStop(
  t: Test,
  stop: 'fails' | 'works',
  options: { recoverable: boolean } = { recoverable: false },
) {
  const { store, first, taskId } = await running(t);
  const sessions = new MemorySessionStore();
  let finish!: () => void;
  const stopReturns = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let stopping!: () => void;
  const stopStarted = new Promise<void>((resolve) => {
    stopping = resolve;
  });
  const asked: Array<number | undefined> = [];
  const aStarting = makeHarness(t, {
    store,
    dir: first.dir,
    fake: {
      recover: options.recoverable,
      stopOrphaned: async (_id, callOptions) => {
        asked.push(callOptions.epoch);
        stopping();
        await stopReturns;
        if (stop === 'fails') throw new Error('the sandbox did not answer');
      },
    },
    orchestrator: { sessions, orphanStopTimeoutMs: 60_000 },
  });
  await stopStarted;
  assert.equal(epochOf(store, taskId), 2);
  const b = await makeHarness(t, {
    store,
    dir: first.dir,
    fake: { recover: true },
    orchestrator: { sessions, resume: 'manual' },
  });
  b.orchestrator.setEndpoint('http://orchestrator.test/mcp');
  b.orchestrator.startRestored();
  await eventually(() => b.fake.recoveries.length === 1, 'the newer attempt to run the task');
  assert.equal(epochOf(store, taskId), 3);
  const token = b.fake.recoveries[0]?.mcp?.token ?? '';
  assert.ok(b.orchestrator.authenticate(token), 'the newer attempt holds a session');
  const before = (await store.read()).length;
  finish();
  const a = await aStarting;
  await a.orchestrator.settled();
  return { store, taskId, a, b, before, token, asked };
}

test('a restart whose stop of the old run comes back after a newer attempt took over writes nothing, ends nothing and revokes nothing of the new attempt', async (t) => {
  const { store, taskId, a, b, before, token, asked } = await slowStop(t, 'fails');
  const added = (await store.read()).slice(before).map((entry) => entry.event.type);
  assert.deepEqual(added, [], 'no note, owed stop or outcome from the stale restart');
  assert.equal(reduce(store.readTask(taskId)).get(taskId)?.state, 'running');
  assert.equal(b.orchestrator.taskStateOf(taskId), 'running');
  assert.ok(b.orchestrator.authenticate(token), "the newer attempt's session survived");
  assert.equal(a.orchestrator.stats().activeTasks, 0, 'it let go of the task');
  assert.deepEqual(asked, [2], 'the stop was asked for the attempt that wanted it');
});

test('the same when the stop worked and the task would have been ended as an orphan', async (t) => {
  const { store, taskId, b, before, token } = await slowStop(t, 'works');
  const added = (await store.read()).slice(before).map((entry) => entry.event.type);
  assert.deepEqual(added, []);
  assert.equal(b.orchestrator.taskStateOf(taskId), 'running');
  assert.ok(b.orchestrator.authenticate(token));
});
