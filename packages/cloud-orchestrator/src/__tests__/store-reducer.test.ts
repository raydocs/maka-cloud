import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyEvent, reduce, toView } from '../reducer.js';
import { MemoryTaskStore } from '../store.js';
import type { ResultManifest, TaskEvent } from '../types.js';

const manifest: ResultManifest = {
  summary: 's',
  done: ['a'],
  notDone: [],
  confidence: 'medium',
  knownIssues: [],
};

const created: TaskEvent = {
  type: 'task_created',
  taskId: 't1',
  sessionId: 'ses_a',
  runner: 'fake',
  mode: 'async',
};

test('store assigns increasing seq and reads after a position', async () => {
  const store = new MemoryTaskStore();
  const first = await store.append(created, 10);
  const second = await store.append({ type: 'task_started', taskId: 't1' }, 20);
  assert.deepEqual([first.seq, second.seq], [1, 2]);
  assert.deepEqual(
    (await store.read()).map((entry) => entry.seq),
    [1, 2],
  );
  assert.deepEqual(
    (await store.read(1)).map((entry) => entry.seq),
    [2],
  );
});

test('stored entries are frozen and detached from the appended object', async () => {
  const store = new MemoryTaskStore();
  const event: TaskEvent = { type: 'task_progress', taskId: 't1', note: 'x' };
  const stored = await store.append(event, 1);
  assert.throws(() => {
    (stored.event as { type: string }).type = 'task_failed';
  }, TypeError);
  (event as { note: string }).note = 'changed';
  assert.equal((stored.event as { note: string }).note, 'x');
});

test('reduce folds a full lifecycle', async () => {
  const store = new MemoryTaskStore();
  for (const [index, event] of (
    [
      created,
      { type: 'task_started', taskId: 't1' },
      { type: 'task_progress', taskId: 't1', note: 'half way' },
      { type: 'task_succeeded', taskId: 't1', manifest },
    ] satisfies TaskEvent[]
  ).entries()) {
    await store.append(event, (index + 1) * 100);
  }
  const task = reduce(await store.read()).get('t1');
  assert.equal(task?.state, 'succeeded');
  assert.equal(task?.createdAt, 100);
  assert.equal(task?.startedAt, 200);
  assert.equal(task?.finishedAt, 400);
  assert.deepEqual(task?.progress, ['half way']);
  assert.deepEqual(task?.manifest, manifest);
});

test('the first terminal event wins', async () => {
  const store = new MemoryTaskStore();
  await store.append(created, 1);
  await store.append({ type: 'task_cancelled', taskId: 't1' }, 2);
  await store.append({ type: 'task_succeeded', taskId: 't1', manifest }, 3);
  await store.append({ type: 'task_failed', taskId: 't1', reason: 'late' }, 4);
  const task = reduce(await store.read()).get('t1');
  assert.equal(task?.state, 'cancelled');
  assert.equal(task?.manifest, undefined);
  assert.equal(task?.failureReason, undefined);
});

test('events for unknown tasks are ignored and progress is bounded', () => {
  const tasks = new Map();
  applyEvent(tasks, { seq: 1, at: 1, event: { type: 'task_started', taskId: 'ghost' } });
  assert.equal(tasks.size, 0);
  applyEvent(tasks, { seq: 2, at: 2, event: created });
  for (let index = 0; index < 50; index += 1) {
    applyEvent(tasks, {
      seq: 3 + index,
      at: 3,
      event: { type: 'task_progress', taskId: 't1', note: `n${index}` },
    });
  }
  assert.equal(tasks.get('t1').progress.length, 20);
  assert.equal(toView(tasks.get('t1')).progress.length, 10);
  assert.equal(toView(tasks.get('t1')).progress.at(-1), 'n49');
});

test('views are copies', () => {
  const tasks = reduce([{ seq: 1, at: 1, event: created }]);
  const record = tasks.get('t1');
  assert.ok(record);
  const view = toView(record);
  view.progress.push('tamper');
  assert.deepEqual(record.progress, []);
});
