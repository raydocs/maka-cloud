import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunnerSessionRecord } from '../types.js';
import { collect, notes, setup, terminal } from './harness.js';

function record(taskId: string, snapshotIds: string[], turns: number): RunnerSessionRecord {
  return {
    taskId,
    runner: 'claude-agent-sdk',
    tenantId: 'default',
    machineId: 'm_aaaaaaaaaaaaaaaaaaaaaaaaaa',
    turns,
    snapshotIds,
    updatedAt: 0,
  };
}

test('a snapshot is taken after the turn and recorded', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  h.fake.snapshotPolls = 3;
  const events = await collect(await h.runners.claude.start(await h.spec('tsk_Snap_1')));
  assert.equal(terminal(events)?.type, 'finished');
  const [snapshot] = [...h.fake.snapshots.values()];
  assert.equal(snapshot?.status, 'ready');
  assert.equal(snapshot?.name, 'maka-tsk-snap-1-t1', 'lowercase, letters digits and hyphens only');
  assert.deepEqual((await h.sessions.get('tsk_Snap_1'))?.snapshotIds, [snapshot?.id]);
  assert.ok(h.fake.requestsTo('POST', /\/snapshots$/).every((r) => r.headers['idempotency-key']));
});

test('a snapshot that cannot be made is reported and the task still finishes', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  h.fake.failNextSnapshot = true;
  const first = await collect(await h.runners.claude.start(await h.spec('tsk_snapfail1')));
  assert.equal(terminal(first)?.type, 'finished');
  assert.ok(
    notes(first).some(
      (note) => note.startsWith('snapshot skipped: ') && note.includes('upload failed'),
    ),
  );

  h.fake.failNextSnapshotCreate = { status: 400, code: 'bad_request', retryable: false };
  const second = await collect(await h.runners.claude.start(await h.spec('tsk_snapfail2')));
  assert.equal(terminal(second)?.type, 'finished');
  assert.ok(notes(second).some((note) => note.startsWith('snapshot skipped: ')));
  assert.deepEqual((await h.sessions.get('tsk_snapfail2'))?.snapshotIds, []);
});

test('snapshots can be switched off', async (t) => {
  const h = await setup({ cloud: { snapshots: false } });
  t.after(() => h.cleanup());
  const events = await collect(await h.runners.claude.start(await h.spec('tsk_nosnap')));
  assert.equal(terminal(events)?.type, 'finished');
  assert.equal(h.fake.snapshots.size, 0);
});

test('retention is per machine: twenty one-turn tasks keep as many snapshots as one task would', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  const { fleet } = h.runners;
  const machine = fleet.machine(h.fake.machineId);
  for (let i = 0; i < 20; i++) {
    const taskId = `task${i}`;
    await h.sessions.put(record(taskId, [], 1));
    await fleet.snapshotTurn((await h.sessions.get(taskId)) as RunnerSessionRecord, machine);
  }
  assert.equal(h.fake.snapshots.size, 2, 'the default keeps two per machine');
  for (const r of await h.sessions.list()) {
    assert.ok(r.snapshotIds.length >= 1, `${r.taskId} can still be restored`);
    for (const id of r.snapshotIds)
      assert.ok(h.fake.snapshots.has(id), `${r.taskId} points at ${id}`);
  }
});

test('a task whose own snapshots were evicted is pointed at the newest one', async (t) => {
  const h = await setup({ cloud: { keepSnapshots: 1 } });
  t.after(() => h.cleanup());
  const { fleet } = h.runners;
  const machine = fleet.machine(h.fake.machineId);
  await h.sessions.put(record('a', [], 1));
  await h.sessions.put(record('b', [], 1));
  const first = await fleet.snapshotTurn(
    (await h.sessions.get('a')) as RunnerSessionRecord,
    machine,
  );
  const second = await fleet.snapshotTurn(
    (await h.sessions.get('b')) as RunnerSessionRecord,
    machine,
  );
  assert.deepEqual([...h.fake.snapshots.keys()], [second.snapshotId]);
  assert.equal(h.fake.snapshots.has(first.snapshotId), false);
  assert.deepEqual((await h.sessions.get('a'))?.snapshotIds, [second.snapshotId]);
  assert.deepEqual((await h.sessions.get('b'))?.snapshotIds, [second.snapshotId]);
});

test('a snapshot that a record on another machine still points at is never deleted', async (t) => {
  const h = await setup({ cloud: { keepSnapshots: 1 } });
  t.after(() => h.cleanup());
  const { fleet } = h.runners;
  const machine = fleet.machine(h.fake.machineId);
  await h.sessions.put(record('a', [], 1));
  const first = await fleet.snapshotTurn(
    (await h.sessions.get('a')) as RunnerSessionRecord,
    machine,
  );
  await h.sessions.put({ ...record('elsewhere', [first.snapshotId], 1), machineId: 'm_other' });

  const second = await fleet.snapshotTurn(
    { ...((await h.sessions.get('a')) as RunnerSessionRecord), turns: 2 },
    machine,
  );
  assert.deepEqual((await h.sessions.get('a'))?.snapshotIds, [second.snapshotId]);
  assert.ok(h.fake.snapshots.has(first.snapshotId), 'the other record still points at it');
});

test('snapshots taken at the same time on one machine keep every record restorable', async (t) => {
  const h = await setup({ cloud: { keepSnapshots: 2 } });
  t.after(() => h.cleanup());
  const { fleet } = h.runners;
  const machine = fleet.machine(h.fake.machineId);
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  for (const id of ids) await h.sessions.put(record(id, [], 1));
  await Promise.all(
    ids.map(async (id) =>
      fleet.snapshotTurn((await h.sessions.get(id)) as RunnerSessionRecord, machine),
    ),
  );
  assert.equal(h.fake.snapshots.size, 2);
  for (const r of await h.sessions.list()) {
    assert.ok(r.snapshotIds.length >= 1);
    for (const id of r.snapshotIds) assert.ok(h.fake.snapshots.has(id));
  }
});

test('a snapshot that fails to delete does not fail the turn', async (t) => {
  const h = await setup({ cloud: { keepSnapshots: 1 } });
  t.after(() => h.cleanup());
  const { fleet } = h.runners;
  const machine = fleet.machine(h.fake.machineId);
  let a = record('a', [], 1);
  await h.sessions.put(a);
  a = (await fleet.snapshotTurn(a, machine)).record;
  const first = a.snapshotIds[0] as string;
  h.fake.snapshots.delete(first); // already gone: the delete answers 404
  a = (await fleet.snapshotTurn({ ...a, turns: 2 }, machine)).record;
  assert.equal(a.snapshotIds.length, 1);
});
