import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { boxName, LABEL } from '../labels.js';
import { BoxPool } from '../pool.js';
import { flush, labelsOf, setup } from './support.js';

const A = 'inv_aaaaaaaaaaaa';
const MIN = 60_000;
const HOUR = 60 * MIN;

const labels = (slot: number, task?: string) => ({
  [LABEL.pool]: '1',
  [LABEL.invite]: A,
  [LABEL.slot]: String(slot),
  ...(task ? { [LABEL.task]: task } : {}),
});

/** A pool holding one box that was marked lost by a failed wake. */
async function lostBox(overrides: Parameters<typeof setup>[0] = {}) {
  const t = setup({ wakeTimeoutsMs: [60_000, 180_000], ...overrides });
  const first = await t.pool.acquire({ tenantId: A, taskId: 't1' });
  await first.release();
  t.clock.now += 30 * MIN;
  await t.pool.sweepIdle();
  t.fleet.wakeScript = ['fail', 'fail'];
  const second = await t.pool.acquire({ tenantId: A, taskId: 't2' });
  assert.notEqual(second.machineId, first.machineId);
  await second.release();
  assert.equal(t.pool.state().find((box) => box.machineId === first.machineId)?.state, 'lost');
  return { ...t, lostId: first.machineId, otherId: second.machineId };
}

describe('cleanup of boxes nobody uses', () => {
  it('leaves a box that was lost a moment ago alone', async () => {
    const t = await lostBox();
    t.clock.now += 5 * MIN;
    const result = await t.pool.cleanup();
    assert.deepEqual(result, { recovered: [], deleted: [] });
    assert.equal(t.fleet.callsTo('deleteMachine').length, 0);
  });

  it('tries a lost box again after the grace time and puts it back into use if it wakes and passes its guard', async () => {
    const t = await lostBox();
    t.clock.now += 31 * MIN;
    t.guarded.length = 0;
    const result = await t.pool.cleanup();
    assert.deepEqual(result, { recovered: [t.lostId], deleted: [] });
    assert.deepEqual(t.guarded, [{ machineId: t.lostId, reason: 'wake' }]);
    assert.equal(t.pool.state().find((box) => box.machineId === t.lostId)?.state, 'ready');
    // Both are free now, and the recovered one is usable again.
    const one = await t.pool.acquire({ tenantId: A, taskId: 't3' });
    const two = await t.pool.acquire({ tenantId: A, taskId: 't4' });
    assert.deepEqual([one.machineId, two.machineId].sort(), [t.lostId, t.otherId].sort());
  });

  it('keeps a box that fails its recovery guard lost, and does not try it again at once', async () => {
    let fail = false;
    const t = await lostBox({
      beforeUse: async (_id, reason) => {
        if (reason === 'wake' && fail) throw new Error('egress guard refused');
      },
    });
    fail = true;
    t.clock.now += 31 * MIN;
    assert.deepEqual(await t.pool.cleanup(), { recovered: [], deleted: [] });
    assert.equal(t.pool.state().find((box) => box.machineId === t.lostId)?.state, 'lost');
    const calls = t.fleet.callsTo('ensureRunning').length;
    await t.pool.cleanup();
    assert.equal(t.fleet.callsTo('ensureRunning').length, calls, 'it waits before trying again');
  });

  it('deletes a box that has stayed lost for a day, after looking at it again, and frees its slot', async () => {
    const t = await lostBox();
    t.fleet.wakeScript = ['fail'];
    t.clock.now += 25 * HOUR;
    const result = await t.pool.cleanup();
    assert.deepEqual(result, { recovered: [], deleted: [t.lostId] });
    assert.equal(t.fleet.machines.get(t.lostId)?.state, 'deleted');
    assert.equal(
      t.pool.state().some((box) => box.machineId === t.lostId),
      false,
    );
  });

  describe('never deletes a box when the fresh look says no', () => {
    const lostForADay = async (written = false) => {
      const flag = { written: false };
      const t = await lostBox({ recentWrite: async () => flag.written });
      flag.written = written;
      t.clock.now += 25 * HOUR;
      return t;
    };

    it('a live task holds it (its label, read now)', async () => {
      const t = await lostForADay();
      const machine = t.fleet.machines.get(t.lostId);
      if (machine) machine.metadata[LABEL.task] = 'running-elsewhere';
      t.live.add('running-elsewhere');
      assert.deepEqual((await t.pool.cleanup()).deleted, []);
      assert.equal(t.fleet.callsTo('deleteMachine').length, 0);
      assert.equal(t.pool.state().find((box) => box.machineId === t.lostId)?.state, 'lost');
    });

    it('something wrote to it a moment ago', async () => {
      const t = await lostForADay(true);
      const machine = t.fleet.machines.get(t.lostId);
      if (machine) machine.state = 'running';
      assert.deepEqual((await t.pool.cleanup()).deleted, []);
      assert.equal(t.fleet.callsTo('deleteMachine').length, 0);
    });

    it("it no longer carries this pool's labels for this slot", async () => {
      const t = await lostForADay();
      const machine = t.fleet.machines.get(t.lostId);
      if (machine) machine.metadata[LABEL.invite] = 'inv_bbbbbbbbbbbb';
      assert.deepEqual((await t.pool.cleanup()).deleted, []);
      assert.equal(t.fleet.callsTo('deleteMachine').length, 0);
      assert.ok(t.warnings.some((w) => w.includes('not this pool')));
    });

    it('is not tried again until the retry time has passed', async () => {
      const t = await lostForADay(true);
      const machine = t.fleet.machines.get(t.lostId);
      if (machine) machine.state = 'running';
      await t.pool.cleanup();
      const looks = t.fleet.callsTo('getMachine').length;
      await t.pool.cleanup();
      assert.equal(t.fleet.callsTo('getMachine').length, looks);
    });
  });

  it('does not let a task take a box while it is being checked for deletion', async () => {
    const t = await lostBox();
    t.clock.now += 25 * HOUR;
    t.fleet.wakeScript = ['fail'];
    const look = t.fleet.hold('getMachine');
    const cleaning = t.pool.cleanup();
    await look.reached;
    assert.equal(t.pool.state().find((box) => box.machineId === t.lostId)?.state, 'deleting');
    // Slot 0 is the box being deleted; a new task takes the other box or makes a third, never that one.
    const lease = await t.pool.acquire({ tenantId: A, taskId: 't9' });
    assert.notEqual(lease.machineId, t.lostId);
    look.release();
    assert.deepEqual((await cleaning).deleted, [t.lostId]);
  });

  it('puts the box back the way it was when the delete fails', async () => {
    const t = await lostBox();
    t.clock.now += 25 * HOUR;
    t.fleet.wakeScript = ['fail'];
    const fleet = t.fleet;
    fleet.deleteMachine = async () => {
      throw new Error('instabox is down');
    };
    assert.deepEqual((await t.pool.cleanup()).deleted, []);
    assert.equal(t.pool.state().find((box) => box.machineId === t.lostId)?.state, 'lost');
    assert.ok(t.warnings.some((w) => w.includes('instabox is down')));
  });

  it('a box that is already gone leaves the pool without a delete call', async () => {
    const t = await lostBox();
    t.clock.now += 25 * HOUR;
    const machine = t.fleet.machines.get(t.lostId);
    if (machine) machine.state = 'deleted';
    const result = await t.pool.cleanup();
    assert.deepEqual(result.deleted, [t.lostId]);
    assert.equal(t.fleet.callsTo('deleteMachine').length, 0);
  });

  describe('idle boxes', () => {
    it('are kept by default, however long they sit', async () => {
      const t = setup();
      const lease = await t.pool.acquire({ tenantId: A, taskId: 't1' });
      await lease.release();
      t.clock.now += 400 * HOUR;
      assert.deepEqual(await t.pool.cleanup(), { recovered: [], deleted: [] });
    });

    it('are deleted after the set time, but never one a task holds or a person looked at', async () => {
      const t = setup({ cleanup: { idleDeleteMs: 48 * HOUR } });
      const held = await t.pool.acquire({ tenantId: A, taskId: 't1' });
      const idle = await t.pool.acquire({ tenantId: A, taskId: 't2' });
      const watched = await t.pool.acquire({ tenantId: A, taskId: 't3' });
      await idle.release();
      await watched.release();
      t.clock.now += 49 * HOUR;
      t.pool.noteUserActivity(watched.machineId);
      const result = await t.pool.cleanup();
      assert.deepEqual(result.deleted, [idle.machineId]);
      assert.equal(t.fleet.machines.get(held.machineId)?.state, 'running');
      assert.equal(t.fleet.machines.get(watched.machineId)?.state, 'running');
      // The box that is left free is used first; the freed slot is made again when another task needs a box.
      const left = await t.pool.acquire({ tenantId: A, taskId: 't4' });
      assert.equal(left.machineId, watched.machineId);
      const again = await t.pool.acquire({ tenantId: A, taskId: 't5' });
      assert.equal(t.fleet.machines.get(again.machineId)?.name, boxName(A, 1));
    });

    it('are not deleted when the fresh look finds a task label that is live', async () => {
      const t = setup({ cleanup: { idleDeleteMs: HOUR } });
      const lease = await t.pool.acquire({ tenantId: A, taskId: 't1' });
      await lease.release();
      await flush();
      const machine = t.fleet.machines.get(lease.machineId);
      if (machine) machine.metadata[LABEL.task] = 'other-process-task';
      t.live.add('other-process-task');
      t.clock.now += 2 * HOUR;
      assert.deepEqual((await t.pool.cleanup()).deleted, []);
      assert.equal(labelsOf(t.fleet, lease.machineId)?.[LABEL.task], 'other-process-task');
    });
  });

  it('lists the boxes it refused and deletes none of them', async () => {
    const t = setup({ cleanup: { idleDeleteMs: HOUR, lostDeleteMs: HOUR, lostGraceMs: HOUR } });
    const outOfRange = t.fleet.seed({ name: boxName(A, 9), metadata: labels(9) });
    const wrongName = t.fleet.seed({ name: 'mk-wrong-0', metadata: labels(0) });
    await t.pool.knownMachines();
    t.clock.now += 100 * HOUR;
    await t.pool.cleanup();
    assert.deepEqual(
      t.pool
        .refusedBoxes()
        .map((entry) => entry.machineId)
        .sort(),
      [outOfRange.id, wrongName.id].sort(),
    );
    assert.equal(t.fleet.callsTo('deleteMachine').length, 0);
  });
});

describe('creating a box after a restart', () => {
  it('does not reuse the idempotency key of an earlier process, so it never gets a deleted box’s operation', async () => {
    const t = setup({ cleanup: { idleDeleteMs: HOUR } });
    const first = await t.pool.acquire({ tenantId: A, taskId: 't1' });
    await first.release();
    t.clock.now += 2 * HOUR;
    assert.deepEqual((await t.pool.cleanup()).deleted, [first.machineId]);
    // A new process: its counters start again, the account (and its idempotency records) does not.
    const restarted = new BoxPool({
      api: t.fleet,
      source: () => ({ templateId: 't_node' }),
      isTaskLive: () => false,
      beforeUse: async () => undefined,
      timers: t.timers,
      now: () => t.clock.now,
    });
    const lease = await restarted.acquire({ tenantId: A, taskId: 't2' });
    assert.notEqual(lease.machineId, first.machineId);
    assert.equal(t.fleet.machines.get(lease.machineId)?.state, 'running');
    const keys = t.fleet
      .callsTo('createMachine')
      .map((call) => (call[1] as { idempotencyKey?: string }).idempotencyKey);
    assert.equal(new Set(keys).size, keys.length, 'every attempt has its own key');
  });
});
