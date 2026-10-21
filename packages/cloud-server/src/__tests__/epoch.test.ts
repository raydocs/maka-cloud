import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type TestContext, test } from 'node:test';
import { StaleEpochError, type TaskEvent } from '@maka-cloud/orchestrator';
import { MIGRATIONS, openDatabase } from '../db.js';
import { FeedHub, readFeed } from '../feed.js';
import { SqliteTaskStore } from '../sqlite-task-store.js';

async function open(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'epoch-test-'));
  const path = join(root, 'db.sqlite');
  const db = openDatabase(path);
  t.after(async () => {
    try {
      db.close();
    } catch {
      // Closed by the test.
    }
    await rm(root, { recursive: true, force: true });
  });
  return { db, store: new SqliteTaskStore(db, new FeedHub()), path, root };
}

const created: TaskEvent = {
  type: 'task_created',
  taskId: 'a',
  sessionId: 's1',
  runner: 'fake',
  mode: 'async',
};
const attempt = (epoch: number): TaskEvent => ({
  type: 'task_attempt',
  taskId: 'a',
  epoch,
  cause: 'restart',
});
const progress: TaskEvent = { type: 'task_progress', taskId: 'a', note: 'n' };

const epochOf = (db: DatabaseSync) =>
  (db.prepare("SELECT epoch FROM task_index WHERE task_id = 'a'").get() as { epoch: number }).epoch;

test('a task starts at epoch 1 and only the next epoch is let in; of two racing for it, one wins', async (t) => {
  const { db, store } = await open(t);
  await store.append(created, 1);
  assert.equal(epochOf(db), 1);
  await assert.rejects(store.append(attempt(1), 2), StaleEpochError);
  await assert.rejects(store.append(attempt(3), 2), StaleEpochError);
  const raced = await Promise.allSettled([
    store.append(attempt(2), 3),
    store.append(attempt(2), 3),
  ]);
  assert.deepEqual(raced.map((result) => result.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(epochOf(db), 2);
});

test('a stale write is refused in the append transaction: no log row, no feed row, no gap in seq', async (t) => {
  const { db, store } = await open(t);
  await store.append(created, 1);
  await store.append(attempt(2), 2);
  const rows = () => (db.prepare('SELECT COUNT(*) AS n FROM task_log').get() as { n: number }).n;
  const feed = () => readFeed(db, 0, 100).length;
  const [logBefore, feedBefore] = [rows(), feed()];
  await assert.rejects(store.append(progress, 3, { taskId: 'a', epoch: 1 }), StaleEpochError);
  await assert.rejects(store.append(progress, 3, { taskId: 'ghost', epoch: 1 }), StaleEpochError);
  assert.deepEqual([rows(), feed()], [logBefore, feedBefore]);
  const next = await store.append(progress, 4, { taskId: 'a', epoch: 2 });
  assert.equal(next.seq, logBefore + 1);
});

test('attempts and steps are in the log and never in a client feed', async (t) => {
  const { db, store } = await open(t);
  await store.append(created, 1);
  await store.append(attempt(2), 2);
  await store.append(
    {
      type: 'step_intent',
      taskId: 'a',
      epoch: 2,
      stepId: 's',
      kind: 'tool',
      replay: 'safe',
      label: 'l',
    },
    3,
    { taskId: 'a', epoch: 2 },
  );
  await store.append(
    { type: 'step_outcome', taskId: 'a', epoch: 2, stepId: 's', status: 'done' },
    4,
  );
  await store.append({ type: 'step_interrupted', taskId: 'a', epoch: 2, stepId: 's' }, 5);
  await store.append(progress, 6);
  assert.deepEqual(
    store.readTask('a').map((entry) => entry.event.type),
    [
      'task_created',
      'task_attempt',
      'step_intent',
      'step_outcome',
      'step_interrupted',
      'task_progress',
    ],
  );
  assert.deepEqual(
    readFeed(db, 0, 100, undefined, { internal: true })
      .filter((entry) => entry.kind === 'task.event')
      .map((entry) => (entry.data as { event: TaskEvent }).event.type),
    ['task_created', 'task_progress'],
  );
});

test('the epoch is derived from the log: a rebuilt index has it, and a log from before it counts as epoch 1', async (t) => {
  const { db, store, root } = await open(t);
  await store.append(created, 1);
  await store.append(attempt(2), 2);
  await store.append(attempt(3), 3);
  store.rebuildTaskIndex();
  assert.equal(epochOf(db), 3);
  db.close();

  // A database written before the column existed gains it, at 1, when it is opened.
  const old = new DatabaseSync(join(root, 'old.sqlite'));
  for (const step of MIGRATIONS.slice(0, MIGRATIONS.length - 1)) old.exec(step);
  old.exec(`PRAGMA user_version = ${MIGRATIONS.length - 1}`);
  old.exec(
    `INSERT INTO task_index (task_id, session_id, root_session_id, state, created_at)
     VALUES ('a', 's1', 's1', 'running', 1)`,
  );
  old.close();
  const upgraded = openDatabase(join(root, 'old.sqlite'));
  t.after(() => upgraded.close());
  assert.equal(epochOf(upgraded), 1);
  await new SqliteTaskStore(upgraded, new FeedHub()).append(attempt(2), 5);
  assert.equal(epochOf(upgraded), 2);
});
