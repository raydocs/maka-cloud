import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryTaskStore } from '../store.js';
import type { TaskEvent } from '../types.js';

const created = (
  taskId: string,
  sessionId: string,
  extra: Partial<Extract<TaskEvent, { type: 'task_created' }>> = {},
): TaskEvent => ({
  type: 'task_created',
  taskId,
  sessionId,
  runner: 'fake',
  mode: 'async',
  ...extra,
});

test('the index follows the log: per-task events, children, unfinished tasks and ids', async () => {
  const store = new MemoryTaskStore();
  await store.append(created('a', 's1'), 1);
  await store.append(created('b', 'e1', { parentTaskId: 'a', rootSessionId: 's1' }), 2);
  await store.append(created('c', 'e1', { parentTaskId: 'a', rootSessionId: 's1' }), 3);
  await store.append({ type: 'task_started', taskId: 'b' }, 4);
  await store.append({ type: 'task_failed', taskId: 'b', reason: 'x' }, 5);

  assert.deepEqual(
    store.readTask('b').map((s) => s.event.type),
    ['task_created', 'task_started', 'task_failed'],
  );
  assert.deepEqual(store.readTask('nope'), []);
  assert.deepEqual(store.childrenOf('a'), ['b', 'c']);
  assert.deepEqual(store.childrenOf('b'), []);
  assert.deepEqual(store.activeTaskIds().sort(), ['a', 'c']);
  assert.deepEqual([...store.taskIds()].sort(), ['a', 'b', 'c']);
});

test('the first terminal event ends a task for the index, as it does for the reducer', async () => {
  const store = new MemoryTaskStore();
  await store.append(created('a', 's1'), 1);
  await store.append({ type: 'task_cancelled', taskId: 'a' }, 2);
  await store.append({ type: 'task_failed', taskId: 'a', reason: 'late' }, 3);
  assert.deepEqual(store.activeTaskIds(), []);
});

test('events for a task that was never created are logged but not indexed', async () => {
  const store = new MemoryTaskStore();
  await store.append({ type: 'task_started', taskId: 'ghost' }, 1);
  assert.equal((await store.read()).length, 1);
  assert.deepEqual([...store.taskIds()], []);
  assert.deepEqual(store.readTask('ghost'), []);
});

test('creations are counted per tree within a time window', async () => {
  const store = new MemoryTaskStore();
  await store.append(created('a', 's1'), 100);
  await store.append(created('b', 'e1', { parentTaskId: 'a', rootSessionId: 's1' }), 200);
  await store.append(created('c', 's2'), 300);
  assert.equal(store.countCreatedSince('s1', 0), 2);
  assert.equal(store.countCreatedSince('s1', 150), 1);
  assert.equal(store.countCreatedSince('s1', 201), 0);
  assert.equal(store.countCreatedSince('s2', 0), 1);
  assert.equal(store.countCreatedSince('nobody', 0), 0);
});

test('a creation without a root session counts against the session that made it', async () => {
  const store = new MemoryTaskStore();
  await store.append(created('a', 's1'), 1);
  assert.equal(store.countCreatedSince('s1', 0), 1);
});
