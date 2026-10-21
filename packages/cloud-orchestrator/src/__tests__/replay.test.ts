import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reduce } from '../reducer.js';
import { MemoryTaskStore } from '../store.js';
import { eventually, makeHarness } from './harness.js';

test('restarting over the same log restores every task’s state', async (t) => {
  const store = new MemoryTaskStore();
  const first = await makeHarness(t, { store });
  const conductor = first.session();
  const done = await first.orchestrator.delegate(conductor, {
    runner: 'fake',
    brief: 'done',
    title: 'done',
  });
  const failed = await first.orchestrator.delegate(conductor, { runner: 'fake', brief: 'failed' });
  const cancelled = await first.orchestrator.delegate(conductor, {
    runner: 'fake',
    brief: 'cancelled',
  });
  await eventually(() => first.fake.runs.length === 3, 'runs');
  first.fake.runFor(done.taskId).progress('almost');
  await first.fake.runFor(done.taskId).complete();
  first.fake.runFor(failed.taskId).fail('boom');
  await first.orchestrator.cancel(conductor, cancelled.taskId);
  for (const { taskId } of [done, failed, cancelled]) {
    await first.orchestrator.wait(conductor, taskId, 2000);
  }
  const before = [done, failed, cancelled].map(({ taskId }) =>
    first.orchestrator.status(conductor, taskId),
  );

  const second = await makeHarness(t, { store, dir: first.dir });
  const after = [done, failed, cancelled].map(({ taskId }) =>
    second.orchestrator.status(conductor, taskId),
  );
  assert.deepEqual(after, before);
  assert.deepEqual(
    after.map((view) => view.state),
    ['succeeded', 'failed', 'cancelled'],
  );
  assert.equal(second.fake.runs.length, 0);
});

test('a task left running at restart is marked failed by appending, never by editing the log', async (t) => {
  const store = new MemoryTaskStore();
  const first = await makeHarness(t, { store });
  const conductor = first.session();
  const { taskId } = await first.orchestrator.delegate(conductor, { runner: 'fake', brief: 'x' });
  await eventually(() => first.fake.runs.length === 1, 'run');
  await eventually(
    () => first.orchestrator.status(conductor, taskId).state === 'running',
    'running',
  );
  const logBefore = await store.read();

  await makeHarness(t, { store, dir: first.dir });
  const logAfter = await store.read();
  assert.deepEqual(logAfter.slice(0, logBefore.length), logBefore);
  // The restart takes the task over (a new epoch) and then ends it.
  assert.deepEqual(
    logAfter.slice(logBefore.length).map(({ event }) => event.type),
    ['task_attempt', 'task_failed'],
  );

  const view = reduce(logAfter).get(taskId);
  assert.equal(view?.state, 'failed');
  assert.match(view?.failureReason ?? '', /orphaned/u);
});

test('a task with a pending cancel at restart ends cancelled, not failed', async (t) => {
  const store = new MemoryTaskStore();
  await store.append(
    { type: 'task_created', taskId: 'tsk_a', sessionId: 'ses_a', runner: 'fake', mode: 'async' },
    1,
  );
  await store.append({ type: 'task_started', taskId: 'tsk_a' }, 2);
  await store.append({ type: 'task_cancel_requested', taskId: 'tsk_a', by: 'ses_a' }, 3);
  await makeHarness(t, { store });
  assert.equal(reduce(await store.read()).get('tsk_a')?.state, 'cancelled');
});

test('restoring twice is stable: the second restart appends nothing', async (t) => {
  const store = new MemoryTaskStore();
  const first = await makeHarness(t, { store });
  await first.orchestrator.delegate(first.session(), { runner: 'fake', brief: 'x' });
  await eventually(() => first.fake.runs.length === 1, 'run');
  await makeHarness(t, { store, dir: first.dir });
  const length = (await store.read()).length;
  await makeHarness(t, { store, dir: first.dir });
  assert.equal((await store.read()).length, length);
});
