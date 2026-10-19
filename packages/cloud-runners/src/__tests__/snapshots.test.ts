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

test('retention keeps the newest ones per task and never deletes a snapshot another record points at', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  const { fleet } = h.runners;
  const machine = fleet.machine(h.fake.machineId);
  let a = record('a', [], 1);
  await h.sessions.put(a);

  a = (await fleet.snapshotTurn(a, machine)).record;
  const s1 = a.snapshotIds[0] as string;
  a = (await fleet.snapshotTurn({ ...a, turns: 2 }, machine)).record;
  assert.equal(a.snapshotIds.length, 2);

  // Another task's record shares s1 (retention covers the whole machine, not one task).
  await h.sessions.put(record('b', [s1], 1));

  a = (await fleet.snapshotTurn({ ...a, turns: 3 }, machine)).record;
  assert.equal(a.snapshotIds.includes(s1), false, 'a no longer keeps it');
  assert.ok(h.fake.snapshots.has(s1), 'b still points at it, so it stays');

  const s2 = a.snapshotIds[0] as string;
  a = (await fleet.snapshotTurn({ ...a, turns: 4 }, machine)).record;
  assert.equal(a.snapshotIds.includes(s2), false);
  assert.equal(h.fake.snapshots.has(s2), false, 'nobody points at it, so it is deleted');
  assert.ok(h.fake.snapshots.has(s1));
  assert.equal(h.fake.snapshots.size, 3);
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
