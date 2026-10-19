import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SupervisorDatabaseInUseError, openDatabase } from '../db.js';
import { FakeHost, Gate, HOUR, MANIFEST, MINUTE, firstItem, rig, tmpDb } from './harness.js';

test('stop releases the subscription, the timer and everything in flight, and may be called twice', async () => {
  let cancelled = 0;
  const r = await rig({
    tickMs: 1000,
    schedule: () => () => {
      cancelled += 1;
    },
  });
  await r.supervisor.settled();
  assert.deepEqual(r.supervisor.stats(), {
    inflight: 0,
    feedSubscriptions: 1,
    timers: 1,
    verifications: 0,
  });
  assert.equal(r.host.feed.listening(), 1);
  await Promise.all([r.stop(), r.stop()]);
  await r.stop();
  assert.deepEqual(r.supervisor.stats(), {
    inflight: 0,
    feedSubscriptions: 0,
    timers: 0,
    verifications: 0,
  });
  assert.equal(r.host.feed.listening(), 0);
  assert.equal(cancelled, 1);
});

test('a feed entry after stop is not processed', async () => {
  const r = await rig();
  await r.stop();
  r.host.feed.append('conductor.question', 'cnv_1', {}, r.clock.t);
  await r.supervisor.tick();
  assert.equal(r.host.interrupts.length, 0);
});

test('stop during a delivery aborts it and waits for it; the answer stays pending for the next start', async () => {
  const dbPath = tmpDb();
  const host = new FakeHost();
  const first = await rig({ host, dbPath });
  await first.question('q1');
  const item = await firstItem(first);
  const entered = new Gate();
  let signalAborted = false;
  host.script.deliver = (_delivery, signal) => {
    entered.resolve();
    return new Promise((_, reject) =>
      signal.addEventListener('abort', () => {
        signalAborted = true;
        reject(new Error('aborted'));
      }),
    );
  };
  const answering = first.supervisor.answer({
    itemId: item.itemId,
    answerId: 'a1',
    optionId: 'a',
    preconditionHash: item.preconditionHash,
  });
  await entered.promise;
  await first.stop();
  assert.equal(signalAborted, true);
  assert.equal(first.supervisor.stats().inflight, 0);
  await answering;

  host.script.deliver = undefined;
  const second = await rig({ host, dbPath, clock: first.clock });
  assert.equal(second.supervisor.getItem(item.itemId)?.state, 'answering');
  second.clock.advance(5 * MINUTE);
  await second.supervisor.tick();
  assert.equal(second.supervisor.getItem(item.itemId)?.state, 'closed');
  assert.equal(host.applied.get('q1'), 'a');
  await second.stop();
});

test('stop does not wait for a push channel that never answers', async () => {
  const r = await rig();
  const entered = new Gate();
  r.host.script.interrupt = () => {
    entered.resolve();
    return new Promise<void>(() => {});
  };
  void r.question('q1');
  await entered.promise;
  await r.stop();
  assert.equal(r.supervisor.stats().inflight, 0);
});

test('stop does not wait for a publish that never answers', async () => {
  const r = await rig();
  const entered = new Gate();
  r.host.script.publish = () => {
    entered.resolve();
    return new Promise<void>(() => {});
  };
  void r.question('q1');
  await entered.promise;
  await r.stop();
  assert.equal(r.supervisor.stats().inflight, 0);
});

test('a notifier that throws is reported once and does not stop the feed or repeat the push', async () => {
  const r = await rig();
  r.host.script.interrupt = async () => {
    throw new Error('channel down');
  };
  await r.question('q1');
  await r.question('q2');
  assert.equal(r.host.interrupts.length, 2, 'each item is pushed once');
  assert.equal(r.supervisor.listItems().items.length, 2);
  assert.equal(r.host.warnings.filter((message) => message.includes('Notifying')).length, 2);
  await r.supervisor.tick();
  assert.equal(r.host.interrupts.length, 2, 'a failed push is not retried');
  await r.stop();
});

test('a publish that fails is retried at the next pass and then cleared', async () => {
  const r = await rig();
  let fail = true;
  r.host.script.publish = async () => {
    if (fail) throw new Error('feed busy');
  };
  await r.question('q1');
  assert.equal(r.host.published.length, 0);
  fail = false;
  await r.supervisor.tick();
  assert.equal(r.host.published.filter((event) => event.kind === 'inbox.item').length, 1);
  await r.supervisor.tick();
  assert.equal(r.host.published.filter((event) => event.kind === 'inbox.item').length, 1);
  await r.stop();
});

test('a restart resumes from the cursor: one item, one push, no repeated processing', async () => {
  const dbPath = tmpDb();
  const host = new FakeHost();
  const first = await rig({ host, dbPath });
  await first.question('q1');
  await first.stop();
  assert.equal(host.interrupts.length, 1);

  const second = await rig({ host, dbPath, clock: first.clock });
  await second.supervisor.tick();
  assert.equal(second.supervisor.listItems().items.length, 1);
  assert.equal(host.interrupts.length, 1);
  await second.question('q2');
  assert.equal(second.supervisor.listItems().items.length, 2);
  assert.equal(host.interrupts.length, 2);
  await second.stop();
});

test('task history from before the first start raises no items, while a question still open does', async () => {
  const host = new FakeHost();
  const before = Date.UTC(2026, 9, 1);
  let seq = 0;
  const task = (event: Record<string, unknown>) =>
    host.feed.append('task.event', 'cnv_1', { seq: ++seq, at: before, event }, before, {
      notify: false,
    });
  task({
    type: 'task_created',
    taskId: 'p',
    sessionId: 's',
    runner: 'r',
    mode: 'async',
    title: 'parent',
  });
  for (const id of ['a', 'b']) {
    task({
      type: 'task_created',
      taskId: id,
      sessionId: 's',
      runner: 'r',
      mode: 'async',
      parentTaskId: 'p',
      title: 'run tests',
    });
    task({ type: 'task_failed', taskId: id, reason: 'broke' });
  }
  task({ type: 'task_succeeded', taskId: 'p', manifest: { ...MANIFEST, confidence: 'low' } });
  const r = await rig({ host });
  await r.supervisor.tick();
  assert.equal(r.supervisor.listItems({ state: 'all' }).items.length, 0);
  assert.equal(host.interrupts.length, 0);
  await r.question('q_now');
  assert.equal(r.supervisor.listItems().items.length, 1);
  await r.stop();
});

test('a second opener of the same database fails at once, and the first keeps working', async () => {
  const dbPath = tmpDb();
  const first = await rig({ dbPath });
  await assert.rejects(rig({ dbPath }), SupervisorDatabaseInUseError);
  await first.question('q1');
  assert.equal(first.supervisor.listItems().items.length, 1);
  await first.stop();
  const again = await rig({ dbPath, clock: first.clock });
  await again.stop();
});

test('the item log and the answer log are append-only', async () => {
  const dbPath = tmpDb();
  const r = await rig({ dbPath });
  await r.question('q1');
  const item = await firstItem(r);
  await r.supervisor.answer({
    itemId: item.itemId,
    answerId: 'a1',
    optionId: 'a',
    preconditionHash: item.preconditionHash,
  });
  await r.stop();
  const db = openDatabase(dbPath);
  try {
    assert.throws(() => db.exec('UPDATE item_events SET kind = 1'), /append-only/);
    assert.throws(() => db.exec('DELETE FROM item_events'), /append-only/);
    assert.throws(() => db.exec('UPDATE answer_log SET outcome = 1'), /append-only/);
    assert.throws(() => db.exec('DELETE FROM answer_log'), /append-only/);
    const count = db.prepare('SELECT COUNT(*) AS n FROM item_events').get() as { n: number };
    assert.ok(count.n > 0);
  } finally {
    db.close();
  }
});

test('a newer schema version is refused rather than opened', () => {
  const dbPath = tmpDb();
  const raw = new DatabaseSync(dbPath);
  raw.exec('PRAGMA user_version = 99');
  raw.close();
  assert.throws(() => openDatabase(dbPath), /schema version 99/);
});

test('runner names never appear in a view, a digest or an interrupt', async () => {
  const r = await rig();
  await r.taskCreated('p', { title: 'parent', runner: 'secret-runner-xyz' });
  await r.taskCreated('a', { parent: 'p', title: 'run tests', runner: 'secret-runner-xyz' });
  await r.taskEvent({ type: 'task_failed', taskId: 'a', reason: 'broke' });
  await r.taskCreated('b', { parent: 'p', title: 'run tests', runner: 'secret-runner-xyz' });
  await r.taskEvent({ type: 'task_failed', taskId: 'b', reason: 'broke' });
  await r.question('q1');
  r.clock.advance(HOUR);
  await r.supervisor.tick();
  const digest = await r.supervisor.digest();
  const everything = JSON.stringify([
    r.supervisor.listItems({ state: 'all' }),
    digest,
    r.host.interrupts,
    r.host.published,
  ]);
  assert.ok(r.supervisor.listItems({ state: 'all' }).items.length >= 2);
  assert.doesNotMatch(everything, /secret-runner-xyz/);
  await r.stop();
});
