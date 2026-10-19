import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OrchestratorError } from '../types.js';
import { eventually, GatedStore, makeHarness } from './harness.js';

test('a delegation with an idempotency key creates one task; a repeat returns it', async (t) => {
  const h = await makeHarness(t);
  const conductor = h.session();
  const first = await h.orchestrator.delegate(conductor, {
    runner: 'fake',
    brief: 'x',
    idempotencyKey: 'k1',
  });
  const again = await h.orchestrator.delegate(conductor, {
    runner: 'fake',
    brief: 'x',
    idempotencyKey: 'k1',
  });
  assert.equal(again.taskId, first.taskId);
  // Two at once are one task too.
  const [a, b] = await Promise.all([
    h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'y', idempotencyKey: 'k2' }),
    h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'y', idempotencyKey: 'k2' }),
  ]);
  assert.equal(a.taskId, b.taskId);
  // Keys are per session.
  const other = await h.orchestrator.delegate(h.session(), {
    runner: 'fake',
    brief: 'x',
    idempotencyKey: 'k1',
  });
  assert.notEqual(other.taskId, first.taskId);
  await eventually(() => h.fake.runs.length === 3, 'three runs');
  await h.orchestrator.settled();
  assert.equal(h.fake.runs.length, 3);
});

test('cancel by key: a task that exists is cancelled, one that does not is never created', async (t) => {
  const h = await makeHarness(t);
  const conductor = h.session();
  const task = await h.orchestrator.delegate(conductor, {
    runner: 'fake',
    brief: 'x',
    idempotencyKey: 'k1',
  });
  await eventually(() => h.fake.runs.length === 1, 'the run');
  const cancelled = await h.orchestrator.cancelByKey(conductor, 'k1');
  assert.equal(cancelled?.taskId, task.taskId);
  assert.equal(cancelled?.state, 'cancelled');
  assert.equal(h.fake.runs[0]?.cancelled, true);

  assert.equal(await h.orchestrator.cancelByKey(conductor, 'k2'), undefined);
  await assert.rejects(
    h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'x', idempotencyKey: 'k2' }),
    (error: unknown) => error instanceof OrchestratorError && error.code === 'cancelled',
  );
  await h.orchestrator.settled();
  assert.equal(h.fake.runs.length, 1);
});

test('race: a cancel by key while the delegation is being written cancels what it creates', async (t) => {
  const store = new GatedStore();
  const h = await makeHarness(t, { store });
  const conductor = h.session();
  const release = store.holdNext('task_created');
  const delegated = h.orchestrator.delegate(conductor, {
    runner: 'fake',
    brief: 'x',
    idempotencyKey: 'k1',
  });
  await eventually(() => store.held, 'the create append held');
  const cancelled = h.orchestrator.cancelByKey(conductor, 'k1');
  release();
  const view = await delegated;
  assert.equal((await cancelled)?.taskId, view.taskId);
  await h.orchestrator.settled();
  assert.equal(h.orchestrator.status(conductor, view.taskId).state, 'cancelled');
  assert.equal(h.orchestrator.stats().activeTasks, 0);
  assert.ok(h.fake.runs.every((run) => run.cancelled));
});

test('race: a cancel by key before the delegation reaches the write chain stops it', async (t) => {
  const h = await makeHarness(t);
  const conductor = h.session();
  // The brief is still being written when the cancel arrives.
  const handoff = (h.orchestrator as unknown as { handoff: { writeBrief: Function } }).handoff;
  const write = handoff.writeBrief.bind(handoff);
  let releaseBrief!: () => void;
  const briefHeld = new Promise<void>((resolve) => {
    handoff.writeBrief = async (...args: unknown[]) => {
      resolve();
      await new Promise<void>((open) => {
        releaseBrief = open;
      });
      return write(...args);
    };
  });
  const delegated = h.orchestrator.delegate(conductor, {
    runner: 'fake',
    brief: 'x',
    idempotencyKey: 'k1',
  });
  await briefHeld;
  assert.equal(await h.orchestrator.cancelByKey(conductor, 'k1'), undefined);
  releaseBrief();
  await assert.rejects(
    delegated,
    (error: unknown) => error instanceof OrchestratorError && error.code === 'cancelled',
  );
  await h.orchestrator.settled();
  assert.equal(h.fake.runs.length, 0);
  assert.equal(h.orchestrator.stats().activeTasks, 0);
});
