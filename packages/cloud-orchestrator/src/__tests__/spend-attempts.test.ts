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

test('a journal that is read again after a crash books each attempt where it belongs and double counts nothing', async (t) => {
  const { store, first, taskId } = await capped(t);
  first.fake.runFor(taskId).usage(3);
  await recorded(store, taskId, 3);

  // A process that dies before it tells the journal it booked the rows is read again by the next one.
  const rows = [{ taskId, attempt: 1, usd: 3.4 }];
  const journal = { unrecorded: () => rows, recorded: () => undefined };
  const second = await makeHarness(t, {
    store,
    dir: first.dir,
    fake: { recover: true },
    orchestrator: { recoveredSpend: journal },
  });
  assert.equal(costOf(store, taskId), 3.4, 'attempt 1 spent 3.4 in all, not 3 and 3.4');
  await eventually(() => second.fake.runs.length === 1, 'the second attempt');
  second.fake.runFor(taskId).usage(0.6);
  await recorded(store, taskId, 4);
  rows.push({ taskId, attempt: 2, usd: 0.6 });

  // The third attempt reads attempt 1's row again, and attempt 2's: the task has still spent 4.
  const third = await makeHarness(t, {
    store,
    dir: second.dir,
    fake: { recover: true },
    orchestrator: { recoveredSpend: journal },
  });
  await eventually(() => third.fake.runs.length === 1, 'the third attempt');
  assert.equal(costOf(store, taskId), 4, 'rows booked before are replaced, not added again');
  assert.equal(
    third.fake.runFor(taskId).spec.budgetUsd,
    1,
    'and the run is given what is left of the 5',
  );
});

test('real spend under the cap is not stopped because a row was booked under the wrong attempt', async (t) => {
  const { store, first, taskId } = await capped(t);
  first.fake.runFor(taskId).usage(3);
  await recorded(store, taskId, 3);
  const journal = {
    unrecorded: () => [{ taskId, attempt: 1, usd: 3.4 }],
    recorded: () => undefined,
  };
  const second = await makeHarness(t, {
    store,
    dir: first.dir,
    fake: { recover: true },
    orchestrator: { recoveredSpend: journal },
  });
  await eventually(() => second.fake.runs.length === 1, 'the second attempt');
  assert.equal(
    second.fake.runFor(taskId).spec.budgetUsd,
    1.6,
    '$3.40 of a $5 cap leaves the resumed run $1.60, not a stop',
  );
});

test('calls a restart cut off are charged in full and the task log says so, once, under the attempt that resumes it', async (t) => {
  const { store, first, taskId } = await capped(t);
  first.fake.runFor(taskId).usage(1);
  await recorded(store, taskId, 1);
  let handed = false;
  const journal = {
    unrecorded: () => (handed ? [] : [{ taskId, usd: 1.75, cutOffCalls: 2, cutOffUsd: 0.75 }]),
    recorded: () => {
      handed = true;
    },
  };
  await makeHarness(t, {
    store,
    dir: first.dir,
    fake: { recover: true },
    orchestrator: { recoveredSpend: journal },
  });
  assert.equal(
    costOf(store, taskId),
    1.75,
    'the open calls are in the spend at their reserved amount',
  );
  const notes = store
    .readTask(taskId)
    .flatMap(({ event }) => (event.type === 'task_progress' ? [event.note] : []))
    .filter((note) => /cut off by the restart/u.test(note));
  assert.deepEqual(notes, [
    '2 calls to the model gateway cut off by the restart were charged in full ($0.75) because the vendor may have billed them',
  ]);

  // A restart with nothing cut off writes no such note.
  const quiet = await capped(t);
  await makeHarness(t, {
    store: quiet.store,
    dir: quiet.first.dir,
    fake: { recover: true },
    orchestrator: { recoveredSpend: { unrecorded: () => [], recorded: () => undefined } },
  });
  assert.equal(
    quiet.store
      .readTask(quiet.taskId)
      .filter(({ event }) => event.type === 'task_progress' && /cut off/u.test(event.note)).length,
    0,
  );
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
