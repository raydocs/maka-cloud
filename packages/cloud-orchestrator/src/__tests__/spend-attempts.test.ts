import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reduce } from '../reducer.js';
import { MemoryTaskStore } from '../store.js';
import type { TaskId } from '../types.js';
import { eventually, makeHarness } from './harness.js';

type Test = Parameters<typeof makeHarness>[0];

/** A task with a $5 cap, running under a plain runner, as a crashed process would leave it. */
async function capped(t: Test) {
  const store = new MemoryTaskStore();
  const first = await makeHarness(t, { store });
  const conductor = first.session();
  const { taskId } = await first.orchestrator.delegate(conductor, {
    runner: 'fake',
    brief: 'x',
    budgetUsd: 5,
  });
  await eventually(() => first.fake.runs.length === 1, 'run');
  await eventually(
    () => first.orchestrator.status(conductor, taskId).state === 'running',
    'running',
  );
  return { store, first, conductor, taskId };
}

const costOf = (store: MemoryTaskStore, taskId: TaskId) =>
  reduce(store.readTask(taskId)).get(taskId)?.costUsd;

/** Restarts the server over the store; the task is resumed in a new attempt. */
async function restart(t: Test, store: MemoryTaskStore, dir: string, taskId: TaskId) {
  const next = await makeHarness(t, { store, dir, fake: { recover: true } });
  await eventually(() => next.fake.runs.length === 1, 'the resumed run');
  return { next, run: next.fake.runFor(taskId) };
}

async function recorded(store: MemoryTaskStore, taskId: TaskId, usd: number): Promise<void> {
  await eventually(() => costOf(store, taskId) === usd, `$${usd} to be recorded`);
}

test('what a task spends in each attempt adds up: a resumed run counts from zero and loses nothing of the earlier ones', async (t) => {
  const { store, first, taskId } = await capped(t);
  first.fake.runFor(taskId).usage(3);
  await recorded(store, taskId, 3);

  // Two restarts; each resumed run reports its own total, starting again from zero.
  const second = await restart(t, store, first.dir, taskId);
  second.run.usage(1);
  await recorded(store, taskId, 4);
  const third = await restart(t, store, second.next.dir, taskId);
  assert.equal(third.run.spec.budgetUsd, 1, 'the third attempt is given what is really left');
  third.run.usage(1);
  await recorded(store, taskId, 5);
});

test('a run that reports again in the same attempt replaces its figure; a lower one changes nothing', async (t) => {
  const { store, first, taskId } = await capped(t);
  const run = first.fake.runFor(taskId);
  run.usage(2);
  await recorded(store, taskId, 2);
  run.usage(2);
  run.usage(1.5);
  run.usage(2.5);
  await recorded(store, taskId, 2.5);
});

test('spend an earlier process wrote down stands in for the figure its run reported live, and is not added to it', async (t) => {
  const { store, first, taskId } = await capped(t);
  first.fake.runFor(taskId).usage(3);
  await recorded(store, taskId, 3);

  let handed = false;
  const journal = {
    unrecorded: () => (handed ? [] : [{ taskId, usd: 3.4 }]),
    recorded: () => {
      handed = true;
    },
  };
  const second = await makeHarness(t, {
    store,
    dir: first.dir,
    fake: { recover: true },
    orchestrator: { recoveredSpend: journal },
  });
  // The journal said 3.4 for the attempt that reported 3: 3.4 stands, nothing is added twice.
  assert.equal(costOf(store, taskId), 3.4);
  await eventually(() => second.fake.runs.length === 1, 'the resumed run');
  second.fake.runFor(taskId).usage(0.6);
  await recorded(store, taskId, 4);
});

test('events written before attempts were keyed still add up as one run', async (t) => {
  const store = new MemoryTaskStore();
  await store.append(
    {
      type: 'task_created',
      taskId: 'tsk_old',
      sessionId: 'ses_a',
      runner: 'fake',
      mode: 'async',
      budgetUsd: 5,
    },
    1,
  );
  await store.append(
    { type: 'task_cost', taskId: 'tsk_old', fromTaskId: 'tsk_old', costUsd: 1 },
    1,
  );
  await store.append(
    { type: 'task_cost', taskId: 'tsk_old', fromTaskId: 'tsk_old', costUsd: 2 },
    1,
  );
  assert.equal(costOf(store, 'tsk_old'), 2);
});
