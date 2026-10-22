import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeHost, rig } from './harness.js';

function twoOwners() {
  const host = new FakeHost();
  host.ownerOf = (conversationId) => (conversationId === 'cnv_a' ? 'inv_a' : 'inv_b');
  return host;
}

test('one owner’s mute holds back only their own pushes', async () => {
  const r = await rig({ host: twoOwners() });
  r.supervisor.setOwnerMute('inv_a', 'budget', true);
  await r.question('qa', 'budget_overrun', 'cnv_a');
  await r.question('qb', 'budget_overrun', 'cnv_b');
  assert.equal(r.host.interrupts.length, 1, 'only the other owner’s budget question pushed');
  assert.equal(r.host.interrupts[0]?.items[0]?.conversationId, 'cnv_b');
  // Both stay listed: a mute holds back the push, not the item.
  assert.equal(r.supervisor.listItems().items.length, 2);
  await r.stop();
});

test('an owner’s quiet hours hold their pushes, and the other owner’s go on', async () => {
  const r = await rig({ host: twoOwners() });
  r.supervisor.setOwnerSettings('inv_a', { quietHours: { start: '00:00', end: '23:59' } });
  await r.question('qa', 'taste', 'cnv_a');
  await r.question('qb', 'taste', 'cnv_b');
  assert.deepEqual(
    r.host.interrupts.map((interrupt) => interrupt.items[0]?.conversationId),
    ['cnv_b'],
  );
  await r.stop();
});

test('an owner’s settings are theirs: read back as the operator’s with their choices over them, and never another owner’s', async () => {
  const r = await rig({ host: twoOwners(), settings: { stallAfterMinutes: 45 } });
  const set = r.supervisor.setOwnerSettings('inv_a', {
    mutedKinds: ['budget'],
    timeZone: 'Europe/Paris',
  });
  assert.deepEqual(set.mutedKinds, ['budget']);
  assert.equal(set.timeZone, 'Europe/Paris');
  assert.equal(set.stallAfterMinutes, 45, 'the operator’s settings show through');
  const other = r.supervisor.getOwnerSettings('inv_b');
  assert.deepEqual(other.mutedKinds, []);
  assert.equal(other.timeZone, 'UTC');
  // The operator's own are unchanged.
  assert.deepEqual(r.supervisor.getSettings().mutedKinds, []);
  await r.stop();
});

test('an owner cannot set what belongs to the operator', async () => {
  const r = await rig({ host: twoOwners() });
  for (const patch of [
    { stallAfterMinutes: 1 },
    { maxInterruptsPerHour: 1000 },
    { digestAt: '03:00' },
    { verifierDailyCapUsd: 1000 },
  ]) {
    assert.throws(() => r.supervisor.setOwnerSettings('inv_a', patch as never), patch.toString());
  }
  assert.throws(() => r.supervisor.setOwnerSettings('inv_a', { timeZone: 'Not/AZone' }));
  assert.equal(r.supervisor.getOwnerSettings('inv_a').stallAfterMinutes, 30);
  await r.stop();
});

test('held pushes are released by their own owner’s quiet hours', async () => {
  const r = await rig({ host: twoOwners() });
  r.supervisor.setOwnerSettings('inv_a', { quietHours: { start: '00:00', end: '23:59' } });
  await r.question('qa', 'taste', 'cnv_a');
  assert.equal(r.host.interrupts.length, 0);
  // Owner b is not in quiet hours, so b's held push (none) is not blocked by a's.
  r.supervisor.setOwnerSettings('inv_a', { quietHours: null });
  await r.supervisor.tick();
  assert.equal(r.host.interrupts.length, 1);
  assert.equal(r.host.interrupts[0]?.batch, true);
  await r.stop();
});

test('an owner can add to the operator’s mutes and cannot lift them', async () => {
  const r = await rig({ host: twoOwners(), settings: { mutedKinds: ['budget'] } });
  const added = r.supervisor.setOwnerMute('inv_a', 'decision', true);
  assert.deepEqual([...added.mutedKinds].sort(), ['budget', 'decision']);
  // Unmuting the operator's kind changes nothing for the owner: it reads back still muted.
  const lifted = r.supervisor.setOwnerMute('inv_a', 'budget', false);
  assert.deepEqual([...lifted.mutedKinds].sort(), ['budget', 'decision']);
  await r.question('qa', 'budget_overrun', 'cnv_a');
  assert.equal(r.host.interrupts.length, 0, 'the operator’s mute still holds the push back');
  // Unmuting the owner's own kind works.
  assert.deepEqual(r.supervisor.setOwnerMute('inv_a', 'decision', false).mutedKinds, ['budget']);
  await r.stop();
});

test('one owner’s unreadable settings row does not fail the pass for the others', async () => {
  const r = await rig({ host: twoOwners() });
  const store = (
    r.supervisor as unknown as { store: { putOwnerSettings(o: string, s: never): void } }
  ).store;
  store.putOwnerSettings('inv_a', { mutedKinds: ['no_such_kind'] } as never);
  await r.question('qa', 'taste', 'cnv_a');
  await r.question('qb', 'taste', 'cnv_b');
  assert.equal(r.host.interrupts.length, 2, 'both owners are still told');
  assert.ok(
    r.host.warnings.some((message) => /unreadable settings of owner inv_a/u.test(message)),
    'and the row is reported',
  );
  await r.stop();
});
