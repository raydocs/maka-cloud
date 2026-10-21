import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyEvent, reduce } from '../reducer.js';
import type { StepLog } from '../steps.js';
import { assertEpoch, MemoryTaskStore, StaleEpochError } from '../store.js';
import type { StoredEvent, TaskEvent, TaskId } from '../types.js';
import { eventually, makeHarness } from './harness.js';

const created: TaskEvent = {
  type: 'task_created',
  taskId: 't1',
  sessionId: 'ses_a',
  runner: 'fake',
  mode: 'async',
};

test('the store lets only the next epoch in, and exactly one of two writers racing for it wins', async () => {
  const store = new MemoryTaskStore();
  await store.append(created, 1);
  const attempt = (epoch: number): TaskEvent => ({
    type: 'task_attempt',
    taskId: 't1',
    epoch,
    cause: 'restart',
  });
  await assert.rejects(store.append(attempt(1), 2), StaleEpochError);
  await assert.rejects(store.append(attempt(3), 2), StaleEpochError);
  const raced = await Promise.allSettled([
    store.append(attempt(2), 3),
    store.append(attempt(2), 3),
  ]);
  assert.deepEqual(raced.map((result) => result.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(
    (await store.read()).filter((entry) => entry.event.type === 'task_attempt').length,
    1,
  );
});

test('a write fenced with an older epoch is refused and leaves no trace; an unfenced one is not affected', async () => {
  const store = new MemoryTaskStore();
  await store.append(created, 1);
  await store.append({ type: 'task_attempt', taskId: 't1', epoch: 2, cause: 'restart' }, 2);
  const progress: TaskEvent = { type: 'task_progress', taskId: 't1', note: 'n' };
  await assert.rejects(store.append(progress, 3, { taskId: 't1', epoch: 1 }), (error: unknown) => {
    assert.ok(error instanceof StaleEpochError);
    assert.deepEqual([error.writerEpoch, error.currentEpoch], [1, 2]);
    return true;
  });
  await assert.rejects(store.append(progress, 3, { taskId: 'unknown', epoch: 1 }), StaleEpochError);
  assert.equal((await store.read()).length, 2);
  await store.append(progress, 3, { taskId: 't1', epoch: 2 });
  await store.append(progress, 4);
  assert.equal((await store.read()).length, 4);
});

test('a cost event is fenced by the task that spent it, not the tree root it is recorded on', async () => {
  const store = new MemoryTaskStore();
  await store.append(created, 1);
  await store.append({ ...created, taskId: 'child', parentTaskId: 't1' }, 2);
  await store.append({ type: 'task_attempt', taskId: 'child', epoch: 2, cause: 'restart' }, 3);
  const cost: TaskEvent = { type: 'task_cost', taskId: 't1', fromTaskId: 'child', costUsd: 1 };
  await assert.rejects(store.append(cost, 4, { taskId: 'child', epoch: 1 }), StaleEpochError);
  await store.append(cost, 4, { taskId: 'child', epoch: 2 });
});

test('assertEpoch checks against what the store reports for the task', () => {
  const epochs = new Map([['a', 3]]);
  const current = (id: TaskId) => epochs.get(id);
  assertEpoch({ type: 'task_attempt', taskId: 'a', epoch: 4, cause: 'resume' }, undefined, current);
  assertEpoch({ type: 'task_started', taskId: 'a' }, { taskId: 'a', epoch: 3 }, current);
  assert.throws(() =>
    assertEpoch({ type: 'task_started', taskId: 'a' }, { taskId: 'a', epoch: 2 }, current),
  );
});

test('the reducer follows epochs: a stale intent is ignored, an outcome needs its own epoch, and only a safe interrupted step runs again', () => {
  const log: TaskEvent[] = [
    created,
    { type: 'task_started', taskId: 't1' },
    {
      type: 'step_intent',
      taskId: 't1',
      epoch: 1,
      stepId: 'a',
      kind: 'tool',
      replay: 'safe',
      label: 'a',
    },
    {
      type: 'step_intent',
      taskId: 't1',
      epoch: 1,
      stepId: 'p',
      kind: 'push',
      replay: 'never',
      label: 'p',
    },
    { type: 'task_attempt', taskId: 't1', epoch: 2, cause: 'restart' },
    { type: 'step_interrupted', taskId: 't1', epoch: 2, stepId: 'a' },
    { type: 'step_interrupted', taskId: 't1', epoch: 2, stepId: 'p' },
    // A late write of the first attempt that got into the log some other way.
    {
      type: 'step_intent',
      taskId: 't1',
      epoch: 1,
      stepId: 'late',
      kind: 'tool',
      replay: 'safe',
      label: 'l',
    },
    { type: 'step_outcome', taskId: 't1', epoch: 1, stepId: 'a', status: 'done' },
    // The second attempt runs both again: only the safe one may.
    {
      type: 'step_intent',
      taskId: 't1',
      epoch: 2,
      stepId: 'a',
      kind: 'tool',
      replay: 'safe',
      label: 'a again',
    },
    {
      type: 'step_intent',
      taskId: 't1',
      epoch: 2,
      stepId: 'p',
      kind: 'push',
      replay: 'never',
      label: 'p again',
    },
    { type: 'step_outcome', taskId: 't1', epoch: 2, stepId: 'a', status: 'done' },
  ];
  const tasks = reduce(log.map((event, i): StoredEvent => ({ seq: i + 1, at: i, event })));
  const steps = tasks.get('t1')?.steps;
  assert.deepEqual(
    [...(steps?.values() ?? [])].map((step) => [step.stepId, step.state, step.epoch]),
    [
      ['a', 'done', 2],
      ['p', 'interrupted', 1],
    ],
  );
  assert.equal(steps?.get('a')?.label, 'a again');
  assert.equal(steps?.get('p')?.label, 'p');
});

test('a step event after the task ended changes nothing', () => {
  const tasks = new Map();
  const apply = (event: TaskEvent, seq: number) => applyEvent(tasks, { seq, at: seq, event });
  apply(created, 1);
  apply({ type: 'task_failed', taskId: 't1', reason: 'x' }, 2);
  apply(
    {
      type: 'step_intent',
      taskId: 't1',
      epoch: 1,
      stepId: 'a',
      kind: 'tool',
      replay: 'safe',
      label: 'a',
    },
    3,
  );
  assert.equal(tasks.get('t1').steps.size, 0);
});

async function drive(t: Parameters<typeof makeHarness>[0]) {
  const first = await makeHarness(t);
  const conductor = first.session();
  const { taskId } = await first.orchestrator.delegate(conductor, { runner: 'fake', brief: 'x' });
  await eventually(() => first.fake.runs.length === 1, 'run');
  await eventually(
    () => first.orchestrator.status(conductor, taskId).state === 'running',
    'running',
  );
  const run = first.fake.runFor(taskId);
  return { first, conductor, taskId, run, steps: run.spec.steps as StepLog };
}

const kinds = (store: MemoryTaskStore, taskId: TaskId) =>
  store.readTask(taskId).map((entry) => entry.event.type);

test('two processes driving one task: the stale one is refused at its first write, starts nothing and stops its run; the side effect happens once', async (t) => {
  const { first, taskId, run, steps } = await drive(t);
  const store = first.store as MemoryTaskStore;
  const push = { stepId: 'push-1', kind: 'push', replay: 'never', label: 'git push' } as const;
  const pushes: string[] = [];
  const doPush = async (driver: string, log: StepLog) => {
    const verdict = await log.intent(push);
    if (verdict.status === 'recorded') pushes.push(driver);
    return verdict;
  };
  assert.equal((await doPush('first', steps)).status, 'recorded');

  // A restart over the same log while the first process is still alive.
  const second = await makeHarness(t, { store, dir: first.dir });
  const before = (await store.read()).length;
  assert.deepEqual(kinds(store, taskId).slice(-3), [
    'task_attempt',
    'step_interrupted',
    'task_failed',
  ]);

  // Every write of the first process is now stale.
  run.progress('still going');
  run.usage(2.5);
  // The store refuses the first write; from then on this process answers every step with a refusal.
  const another = await steps.intent({ ...push, stepId: 'push-2' });
  assert.equal(another.status, 'refused');
  assert.equal((await doPush('first', steps)).status, 'refused');
  assert.equal(await steps.outcome('push-1', { status: 'done' }), 'ignored');
  await run.complete();
  await first.orchestrator.settled();
  await eventually(() => run.cancelCalls > 0, 'the stale run to be stopped');

  assert.equal((await store.read()).length, before, 'nothing was written after the takeover');
  assert.deepEqual(pushes, ['first'], 'the side effect happened once');
  assert.equal(first.orchestrator.stats().activeTasks, 0);
  assert.equal(reduce(store.readTask(taskId)).get(taskId)?.state, 'failed');
  // The new driver's view is the log's.
  assert.equal(second.orchestrator.taskStateOf(taskId), 'failed');
});

test('a stale writer cannot settle a cost either: it stays out of the log', async (t) => {
  const { first, taskId, run } = await drive(t);
  const store = first.store as MemoryTaskStore;
  await makeHarness(t, { store, dir: first.dir });
  run.usage(9);
  await first.orchestrator.settled();
  await eventually(() => run.cancelCalls > 0, 'the stale run to be stopped');
  assert.ok(!kinds(store, taskId).includes('task_cost'));
});

test('two restarts racing for one task: one takes it over and ends it, the other lets go of it', async (t) => {
  const { first, taskId } = await drive(t);
  const store = first.store as MemoryTaskStore;
  const [a, b] = await Promise.all([
    makeHarness(t, { store, dir: first.dir }),
    makeHarness(t, { store, dir: first.dir }),
  ]);
  const log = kinds(store, taskId);
  assert.equal(log.filter((type) => type === 'task_attempt').length, 1);
  assert.equal(log.filter((type) => type === 'task_failed').length, 1);
  assert.equal(reduce(store.readTask(taskId)).get(taskId)?.epoch, 2);
  assert.equal(a.orchestrator.stats().activeTasks + b.orchestrator.stats().activeTasks, 0);
});
