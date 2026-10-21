import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { TaskEvent } from '@maka-cloud/orchestrator';
import { MIGRATIONS, openDatabase } from '../db.js';
import { FeedHub } from '../feed.js';
import { SqliteTaskStore } from '../sqlite-task-store.js';

async function openStore(t: TestContext, dir?: string) {
  const root = dir ?? (await mkdtemp(join(tmpdir(), 'store-test-')));
  const path = join(root, 'db.sqlite');
  const db = openDatabase(path);
  const hub = new FeedHub();
  t.after(async () => {
    try {
      db.close();
    } catch {
      // Already closed by the test.
    }
    await rm(root, { recursive: true, force: true });
  });
  return { db, hub, store: new SqliteTaskStore(db, hub), path };
}

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

test('seq is exactly 1, 2, 3 across appends, concurrent appends and a reopen', async (t) => {
  const { db, store, path } = await openStore(t);
  await store.append(created('a', 's1'), 1);
  await Promise.all(
    Array.from({ length: 40 }, (_, i) =>
      store.append({ type: 'task_progress', taskId: 'a', note: `n${i}` }, 2 + i),
    ),
  );
  db.close();
  const reopened = openDatabase(path);
  t.after(() => reopened.close());
  const again = new SqliteTaskStore(reopened, new FeedHub());
  const last = await again.append({ type: 'task_started', taskId: 'a' }, 99);
  assert.equal(last.seq, 42);
  assert.deepEqual(
    (await again.read()).map((entry) => entry.seq),
    Array.from({ length: 42 }, (_, i) => i + 1),
  );
  assert.deepEqual(
    (await again.read(40)).map((entry) => entry.seq),
    [41, 42],
  );
});

test('stored entries round-trip, are frozen and detached from the appended object', async (t) => {
  const { store } = await openStore(t);
  const event: TaskEvent = { ...created('a', 's1'), title: 'hello' } as TaskEvent;
  const stored = await store.append(event, 5);
  (event as { title?: string }).title = 'changed';
  assert.ok(Object.isFrozen(stored) && Object.isFrozen(stored.event));
  const [read] = store.readTask('a');
  assert.deepEqual(read, stored);
  assert.equal((read?.event as { title?: string } | undefined)?.title, 'hello');
});

test('the log, the messages and the feed cannot be updated or deleted', async (t) => {
  const { db, store } = await openStore(t);
  await store.append(created('a', 's1'), 1);
  db.prepare(
    "INSERT INTO conversations (conversation_id, n, session_id, created_at) VALUES ('c', 1, 's1', 1)",
  ).run();
  db.prepare(
    "INSERT INTO messages (n, message_id, conversation_id, role, text, at) VALUES (1, 'm', 'c', 'user', 'x', 1)",
  ).run();
  for (const sql of [
    'UPDATE task_log SET at = 0 WHERE seq = 1',
    'DELETE FROM task_log WHERE seq = 1',
    "UPDATE messages SET text = 'y' WHERE n = 1",
    'DELETE FROM messages WHERE n = 1',
    "UPDATE feed SET kind = 'x' WHERE id = 1",
    'DELETE FROM feed WHERE id = 1',
  ]) {
    assert.throws(() => db.exec(sql), /append-only/u, sql);
  }
  assert.equal((await store.read()).length, 1);
});

test('the index follows the log: children, unfinished tasks, ids and counts', async (t) => {
  const { store } = await openStore(t);
  await store.append(created('a', 's1'), 100);
  await store.append(created('b', 'e1', { parentTaskId: 'a', rootSessionId: 's1' }), 200);
  await store.append(created('c', 'e1', { parentTaskId: 'a', rootSessionId: 's1' }), 300);
  await store.append(created('d', 's2'), 400);
  await store.append({ type: 'task_started', taskId: 'b' }, 410);
  await store.append({ type: 'task_failed', taskId: 'b', reason: 'x' }, 420);
  await store.append({ type: 'task_cancelled', taskId: 'd' }, 430);
  await store.append({ type: 'task_succeeded', taskId: 'd', manifest: manifest() }, 440);

  assert.deepEqual(store.childrenOf('a'), ['b', 'c']);
  assert.deepEqual(store.childrenOf('b'), []);
  assert.deepEqual(store.activeTaskIds(), ['a', 'c']);
  assert.deepEqual([...store.taskIds()], ['a', 'b', 'c', 'd']);
  assert.deepEqual(
    store.readTask('b').map((entry) => entry.event.type),
    ['task_created', 'task_started', 'task_failed'],
  );
  assert.deepEqual(store.readTask('nope'), []);
  assert.equal(store.countCreatedSince('s1', 0), 3);
  assert.equal(store.countCreatedSince('s1', 250), 1);
  assert.equal(store.countCreatedSince('s2', 0), 1);
  assert.equal(store.countCreatedSince('nobody', 0), 0);
});

function manifest() {
  return {
    summary: 's',
    done: [],
    notDone: [],
    confidence: 'low' as const,
    knownIssues: [],
  };
}

test('the index follows owed stops, ended tasks included, across a reopen and a rebuild', async (t) => {
  const { db, store, path } = await openStore(t);
  await store.append(created('a', 's1'), 1);
  await store.append(created('b', 's1'), 2);
  await store.append({ type: 'task_stop_pending', taskId: 'a', cause: 'restart' }, 3);
  await store.append({ type: 'task_failed', taskId: 'a', reason: 'orphaned' }, 4);
  await store.append({ type: 'task_stop_pending', taskId: 'b', cause: 'cancel_failed' }, 5);
  await store.append({ type: 'task_stopped', taskId: 'b' }, 6);
  assert.deepEqual(store.stopPendingTaskIds(), ['a']);
  assert.deepEqual(store.activeTaskIds(), ['b']);
  store.rebuildTaskIndex();
  assert.deepEqual(store.stopPendingTaskIds(), ['a']);
  db.close();
  const reopened = openDatabase(path);
  t.after(() => reopened.close());
  assert.deepEqual(new SqliteTaskStore(reopened, new FeedHub()).stopPendingTaskIds(), ['a']);
});

test('a version 5 database gains the owed-stop index with its tasks owing none', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'store-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'db.sqlite');
  const old = new DatabaseSync(path);
  for (const step of MIGRATIONS.slice(0, 5)) old.exec(step);
  old.exec('PRAGMA user_version = 5');
  old
    .prepare(
      "INSERT INTO task_index (task_id, session_id, root_session_id, state, created_at) VALUES ('a', 's1', 's1', 'failed', 1)",
    )
    .run();
  old.close();
  const db = openDatabase(path);
  t.after(() => db.close());
  assert.equal(
    (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    MIGRATIONS.length,
  );
  const store = new SqliteTaskStore(db, new FeedHub());
  assert.deepEqual(store.stopPendingTaskIds(), []);
  await store.append({ type: 'task_stop_pending', taskId: 'a', cause: 'restart' }, 2);
  assert.deepEqual(store.stopPendingTaskIds(), ['a']);
});

test('taskIds pages through more tasks than one page holds', async (t) => {
  const { store } = await openStore(t);
  for (let i = 0; i < 2500; i += 1) await store.append(created(`t${i}`, 's1'), i);
  const ids = [...store.taskIds()];
  assert.equal(ids.length, 2500);
  assert.equal(new Set(ids).size, 2500);
  assert.equal(ids[0], 't0');
  assert.equal(ids.at(-1), 't2499');
});

test('the task index can be thrown away and rebuilt from the log', async (t) => {
  const { db, store } = await openStore(t);
  await store.append(created('a', 's1'), 100);
  await store.append(created('b', 'e1', { parentTaskId: 'a', rootSessionId: 's1' }), 200);
  await store.append({ type: 'task_started', taskId: 'b' }, 210);
  await store.append({ type: 'task_failed', taskId: 'a', reason: 'x' }, 220);
  const dump = (database: DatabaseSync) =>
    database.prepare('SELECT * FROM task_index ORDER BY n').all();
  const before = dump(db);
  store.rebuildTaskIndex();
  assert.deepEqual(dump(db), before);
  assert.equal((await store.read()).length, 4);
});

test('events for a task that was never created are logged and not indexed', async (t) => {
  const { store } = await openStore(t);
  await store.append({ type: 'task_started', taskId: 'ghost' }, 1);
  assert.equal((await store.read()).length, 1);
  assert.deepEqual([...store.taskIds()], []);
});

test('the first terminal event ends a task in the index, as in the reducer', async (t) => {
  const { store } = await openStore(t);
  await store.append(created('a', 's1'), 1);
  await store.append({ type: 'task_cancelled', taskId: 'a' }, 2);
  await store.append({ type: 'task_failed', taskId: 'a', reason: 'late' }, 3);
  assert.deepEqual(store.activeTaskIds(), []);
});

test('the feed gets one row per appended event, in order, and the hub hears of each commit', async (t) => {
  const { db, hub, store } = await openStore(t);
  let notified = 0;
  hub.subscribe(() => {
    notified += 1;
  });
  await store.append(created('a', 's1'), 1);
  await store.append({ type: 'task_started', taskId: 'a' }, 2);
  assert.equal(notified, 2);
  const rows = db.prepare('SELECT id, kind, ref FROM feed ORDER BY id').all();
  assert.deepEqual(
    rows.map((row) => [row.id, row.kind, row.ref]),
    [
      [1, 'task.event', '1'],
      [2, 'task.event', '2'],
    ],
  );
});

test('iterateTask reads one task’s entries in order, a page at a time, past what one page holds', async (t) => {
  const { store } = await openStore(t);
  await store.append(created('a', 's1'), 1);
  await store.append(created('b', 's2'), 2);
  const total = 1300;
  for (let i = 0; i < total; i += 1) {
    await store.append({ type: 'task_progress', taskId: 'a', note: `n${i}` } as TaskEvent, 10 + i);
    if (i % 100 === 0) {
      await store.append(
        { type: 'task_progress', taskId: 'b', note: 'other' } as TaskEvent,
        10 + i,
      );
    }
  }
  const seen = [...store.iterateTask('a')];
  assert.equal(seen.length, total + 1);
  assert.deepEqual(
    seen.map((entry) => entry.seq),
    store.readTask('a').map((entry) => entry.seq),
  );
  assert.ok(seen.every((entry) => (entry.event as { taskId: string }).taskId === 'a'));
  // The caller may stop early.
  const [firstOnly] = store.iterateTask('a');
  assert.equal(firstOnly?.event.type, 'task_created');
  assert.deepEqual([...store.iterateTask('nope')], []);
});
