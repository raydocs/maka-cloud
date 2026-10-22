import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryTaskStore } from '../store.js';
import { eventually, makeHarness, sleep } from './harness.js';

test('a process that closes lets go of its runs: nothing is cancelled or recorded, and the task is still running for the next process', async (t) => {
  const store = new MemoryTaskStore();
  const h = await makeHarness(t, { store });
  const conductor = h.session();
  const { taskId } = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'x' });
  await eventually(() => h.fake.runs.length === 1, 'run');
  await eventually(() => h.orchestrator.status(conductor, taskId).state === 'running', 'running');
  const run = h.fake.runFor(taskId);
  const before = store.readTask(taskId).length;

  h.orchestrator.detachRuns();
  // What the run still reports while it lets go is not recorded: no end, and no "exited without a result".
  run.progress('late note');
  run.fail('torn down by the closing process');
  await sleep(50);

  assert.equal(run.detachCalls, 1);
  assert.equal(run.cancelCalls, 0, 'a detach is not a cancel');
  assert.equal(h.orchestrator.status(conductor, taskId).state, 'running');
  assert.equal(store.readTask(taskId).length, before, 'the log gained nothing');

  // The next process over the same store takes the task over, as it does after a crash.
  h.orchestrator.close();
  const second = await makeHarness(t, { store, dir: h.dir, fake: { recover: true } });
  assert.deepEqual(second.orchestrator.resumedTaskIds, [taskId]);
});

test('a run whose start finishes after the process began closing is let go of at once', async (t) => {
  const h = await makeHarness(t, {});
  h.orchestrator.detachRuns();
  const conductor = h.session();
  const { taskId } = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'x' });
  await eventually(() => h.fake.runs.length === 1, 'run');
  await eventually(() => h.fake.runFor(taskId).detachCalls === 1, 'the late run to be let go of');
  assert.equal(h.fake.runFor(taskId).cancelCalls, 0);
});
