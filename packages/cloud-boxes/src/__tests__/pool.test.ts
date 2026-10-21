import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { boxName, LABEL } from '../labels.js';
import { BoxRefusedError, NoFreeBoxError } from '../types.js';
import { flush, labelsOf, setup } from './support.js';

const A = 'inv_aaaaaaaaaaaa';
const B = 'inv_bbbbbbbbbbbb';

describe('BoxPool', () => {
  it('makes a box when a task needs one, named and labelled for its invite and slot, and guards it first', async () => {
    const { pool, fleet, guarded } = setup();
    const lease = await pool.acquire({ tenantId: A, taskId: 't1' });
    assert.equal(fleet.callsTo('createMachine').length, 1);
    const machine = fleet.machines.get(lease.machineId);
    assert.equal(machine?.name, boxName(A, 0));
    assert.deepEqual(machine?.metadata, {
      [LABEL.pool]: '1',
      [LABEL.invite]: A,
      [LABEL.slot]: '0',
      [LABEL.task]: 't1',
    });
    assert.deepEqual(guarded, [{ machineId: lease.machineId, reason: 'create' }]);
  });

  it('gives two overlapping acquires of one task each its own claim: releasing the older lease frees nothing', async () => {
    const { pool, fleet } = setup({ maxPerInvite: 1 });
    const creating = fleet.hold('createMachine');
    const first = pool.acquire({ tenantId: A, taskId: 't1' });
    await creating.reached;
    const second = pool.acquire({ tenantId: A, taskId: 't1' });
    creating.release();
    const [lease1, lease2] = await Promise.all([first, second]);
    assert.equal(lease1.machineId, lease2.machineId);
    const other = pool.acquire({ tenantId: A, taskId: 't2' });
    let otherDone = false;
    void other.then(
      () => {
        otherDone = true;
      },
      () => undefined,
    );
    await lease1.release();
    await flush();
    assert.equal(otherDone, false, 'the second claim still holds the box');
    await lease2.release();
    assert.equal((await other).machineId, lease1.machineId);
  });

  it('keeps a box that instabox accepted but could not be read back, as lost, so later tasks are not refused', async () => {
    const t = setup();
    const real = t.fleet.getMachine.bind(t.fleet);
    let failed = false;
    t.fleet.getMachine = async (id: string) => {
      if (!failed) {
        failed = true;
        throw new Error('network dropped');
      }
      return await real(id);
    };
    await assert.rejects(t.pool.acquire({ tenantId: A, taskId: 't1' }), /network dropped/);
    const [kept] = t.pool.state();
    assert.equal(kept?.state, 'lost', 'the slot keeps the machine instead of forgetting it');
    assert.ok(kept?.machineId);
    assert.ok(t.fleet.machines.has(kept?.machineId as string));
    // The real machine still carries t1's label; the next tasks take other slots and are not refused.
    const second = await t.pool.acquire({ tenantId: A, taskId: 't2' });
    const third = await t.pool.acquire({ tenantId: A, taskId: 't3' });
    assert.notEqual(second.machineId, kept?.machineId);
    assert.notEqual(third.machineId, kept?.machineId);
    // The next cleanup looks at it at once and puts it back into use.
    const cleaned = await t.pool.cleanup();
    assert.deepEqual(cleaned.recovered, [kept?.machineId]);
    assert.equal(t.pool.state().find((row) => row.machineId === kept?.machineId)?.state, 'ready');
  });

  it('gives each task its own box, makes the next slot only when none is free, and queues the rest first come first served', async () => {
    const { pool, fleet } = setup();
    const leases = [];
    for (const taskId of ['t1', 't2', 't3'])
      leases.push(await pool.acquire({ tenantId: A, taskId }));
    assert.equal(new Set(leases.map((l) => l.machineId)).size, 3);
    assert.deepEqual(
      pool.state().map((box) => box.slot),
      [0, 1, 2],
    );
    const fourth = pool.acquire({ tenantId: A, taskId: 't4' });
    const fifth = pool.acquire({ tenantId: A, taskId: 't5' });
    await flush();
    assert.equal(pool.waiting(A), 2);
    assert.equal(fleet.callsTo('createMachine').length, 3, 'the invite is at its maximum');

    await leases[1]?.release();
    assert.equal((await fourth).machineId, leases[1]?.machineId);
    await flush();
    assert.equal(pool.waiting(A), 1);
    assert.equal(labelsOf(fleet, leases[1]?.machineId as string)?.[LABEL.task], 't4');

    await leases[0]?.release();
    assert.equal((await fifth).machineId, leases[0]?.machineId);
    assert.equal(pool.waiting(), 0);
  });

  it('never hands an invite the box of another, even when it is free and the invite waits', async () => {
    const { pool, fleet } = setup({ maxPerInvite: 1 });
    const a = await pool.acquire({ tenantId: A, taskId: 'a1' });
    const b = await pool.acquire({ tenantId: B, taskId: 'b1' });
    assert.notEqual(a.machineId, b.machineId);
    assert.equal(labelsOf(fleet, b.machineId)?.[LABEL.invite], B);

    await a.release();
    const second = pool.acquire({ tenantId: B, taskId: 'b2' });
    await flush();
    assert.equal(pool.waiting(B), 1, "A's free box is not B's to take");
    await b.release();
    assert.equal((await second).machineId, b.machineId);
  });

  it('prefers the box a conversation used before, then the lowest slot', async () => {
    const conversations: Record<string, string> = { t1: 'c1', t2: 'c2', t3: 'c1', t4: 'c2' };
    const { pool } = setup({ conversationOf: (taskId) => conversations[taskId] });
    const first = await pool.acquire({ tenantId: A, taskId: 't1' });
    const second = await pool.acquire({ tenantId: A, taskId: 't2' });
    await first.release();
    await second.release();
    // Both are free; t3 is of conversation c1 and gets the box t1 used (also the lowest slot).
    const third = await pool.acquire({ tenantId: A, taskId: 't3' });
    assert.equal(third.machineId, first.machineId);
    await third.release();
    // t4 is of c2: the box t2 used, although slot 0 is lower.
    const fourth = await pool.acquire({ tenantId: A, taskId: 't4' });
    assert.equal(fourth.machineId, second.machineId);
  });

  it('is idempotent per task, and a replaced lease frees nothing', async () => {
    const { pool } = setup({ maxPerInvite: 1 });
    const old = await pool.acquire({ tenantId: A, taskId: 't1' });
    const again = await pool.acquire({ tenantId: A, taskId: 't1' });
    assert.equal(again.machineId, old.machineId);
    const other = pool.acquire({ tenantId: A, taskId: 't2' });
    await old.release();
    await flush();
    assert.equal(pool.waiting(A), 1, 'the stale lease did not free the box');
    await again.release();
    assert.equal((await other).machineId, old.machineId);
  });

  it('asks twice at once and gets one box, not two', async () => {
    const { pool, fleet } = setup();
    const gate = fleet.hold('createMachine');
    const first = pool.acquire({ tenantId: A, taskId: 't1' });
    await gate.reached;
    const second = pool.acquire({ tenantId: A, taskId: 't1' });
    await flush();
    gate.release();
    const [one, two] = await Promise.all([first, second]);
    assert.equal(one.machineId, two.machineId);
    assert.equal(fleet.callsTo('createMachine').length, 1);
  });

  it('does not make a second box for the last slot while the first is being made', async () => {
    const { pool, fleet } = setup({ maxPerInvite: 1 });
    const gate = fleet.hold('createMachine');
    const first = pool.acquire({ tenantId: A, taskId: 't1' });
    await gate.reached;
    const second = pool.acquire({ tenantId: A, taskId: 't2' });
    await flush();
    assert.equal(pool.waiting(A), 1);
    assert.equal(fleet.callsTo('createMachine').length, 1);
    gate.release();
    const lease = await first;
    await lease.release();
    assert.equal((await second).machineId, lease.machineId);
    assert.equal(fleet.callsTo('createMachine').length, 1);
  });

  it('fails a task that waited too long, and the box it was waiting for is not lost to it', async () => {
    const { pool, timers, fleet } = setup({ maxPerInvite: 1 });
    const holder = await pool.acquire({ tenantId: A, taskId: 't1' });
    const waiting = pool.acquire({ tenantId: A, taskId: 't2' });
    await flush();
    timers.fireAll();
    await assert.rejects(waiting, NoFreeBoxError);
    assert.equal(pool.waiting(), 0);
    await holder.release();
    assert.deepEqual(
      pool.state().map((box) => box.taskId),
      [undefined],
    );
    const next = await pool.acquire({ tenantId: A, taskId: 't3' });
    assert.equal(next.machineId, holder.machineId);
    assert.equal(labelsOf(fleet, next.machineId)?.[LABEL.task], 't3');
  });

  it('shuts down: waiting tasks fail, new ones are refused, claims are left alone', async () => {
    const { pool } = setup({ maxPerInvite: 1 });
    await pool.acquire({ tenantId: A, taskId: 't1' });
    const waiting = pool.acquire({ tenantId: A, taskId: 't2' });
    await flush();
    pool.dispose();
    await assert.rejects(waiting, /shut down/);
    await assert.rejects(pool.acquire({ tenantId: A, taskId: 't3' }), /shut down/);
    assert.equal(pool.state()[0]?.taskId, 't1');
  });

  it('gives the slot back when a create fails, so the next task can make the box', async () => {
    const { pool, fleet } = setup();
    fleet.failNextOperation = true;
    await assert.rejects(pool.acquire({ tenantId: A, taskId: 't1' }), /no_capacity/);
    assert.deepEqual(pool.state(), []);
    const lease = await pool.acquire({ tenantId: A, taskId: 't2' });
    assert.ok(lease.machineId);
    assert.equal(fleet.callsTo('createMachine').length, 2);
  });

  it('deletes a new box that fails its guard and does not hand it out', async () => {
    let fail = true;
    const { pool, fleet } = setup({
      beforeUse: async () => {
        if (fail) throw new Error('egress guard refused');
      },
    });
    await assert.rejects(pool.acquire({ tenantId: A, taskId: 't1' }), /egress guard refused/);
    assert.deepEqual(pool.state(), []);
    assert.equal([...fleet.machines.values()].filter((m) => m.state !== 'deleted').length, 0);
    fail = false;
    const lease = await pool.acquire({ tenantId: A, taskId: 't2' });
    assert.equal(fleet.machines.get(lease.machineId)?.name, boxName(A, 0));
  });

  it('refuses a new box whose labels are not what was asked for', async () => {
    const { pool, fleet, guarded } = setup();
    fleet.tamper = (machine) => {
      machine.metadata[LABEL.invite] = B;
    };
    await assert.rejects(pool.acquire({ tenantId: A, taskId: 't1' }), BoxRefusedError);
    assert.deepEqual(pool.state(), []);
    assert.deepEqual(guarded, []);
  });

  describe('the account limit', () => {
    it('is learned from the refusal; a task whose invite has boxes waits instead of failing', async () => {
      const { pool, fleet, clock } = setup({ limitRecheckMs: 60_000 });
      fleet.accountLimit = 2;
      const one = await pool.acquire({ tenantId: A, taskId: 't1' });
      await pool.acquire({ tenantId: A, taskId: 't2' });
      const third = pool.acquire({ tenantId: A, taskId: 't3' });
      await flush();
      assert.equal(fleet.callsTo('createMachine').length, 3, 'the third create was refused');
      assert.equal(pool.waiting(A), 1);
      await one.release();
      assert.equal((await third).machineId, one.machineId);

      // The limit is known now: a fourth task waits without asking instabox again.
      const fourth = pool.acquire({ tenantId: A, taskId: 't4' });
      await flush();
      assert.equal(fleet.callsTo('createMachine').length, 3);
      assert.equal(pool.waiting(A), 1);

      // After the recheck time the pool tries again, and now the account has room.
      fleet.accountLimit = 3;
      clock.now += 61_000;
      const fifth = await pool.acquire({ tenantId: A, taskId: 't5' });
      assert.equal(fleet.callsTo('createMachine').length, 4);
      assert.ok(fifth.machineId);
      void fourth.catch(() => undefined);
    });

    it('fails a task at once when the invite has no box and the account is full', async () => {
      const { pool, fleet } = setup();
      fleet.accountLimit = 1;
      fleet.seed({ name: 'someone-elses-sandbox' });
      await assert.rejects(pool.acquire({ tenantId: A, taskId: 't1' }), (error: unknown) => {
        assert.ok(error instanceof NoFreeBoxError);
        assert.match(error.message, /limit/);
        return true;
      });
      assert.deepEqual(pool.state(), []);
    });
  });

  describe('finding boxes again', () => {
    it('uses only boxes whose labels all match, and re-claims a live task but frees a dead one', async () => {
      const { pool, fleet, live, warnings } = setup();
      const labels = (invite: string, slot: number, task?: string) => ({
        [LABEL.pool]: '1',
        [LABEL.invite]: invite,
        [LABEL.slot]: String(slot),
        ...(task ? { [LABEL.task]: task } : {}),
      });
      live.add('live-task');
      const free = fleet.seed({ name: boxName(A, 0), metadata: labels(A, 0) });
      const held = fleet.seed({ name: boxName(A, 1), metadata: labels(A, 1, 'live-task') });
      const stale = fleet.seed({ name: boxName(A, 2), metadata: labels(A, 2, 'dead-task') });
      const wrongName = fleet.seed({ name: 'mk-wrong-0', metadata: labels(B, 0) });
      const outOfRange = fleet.seed({ name: boxName(B, 7), metadata: labels(B, 7) });
      const duplicate = fleet.seed({ name: boxName(A, 0), metadata: labels(A, 0) });
      const noInvite = fleet.seed({
        name: boxName(B, 1),
        metadata: { [LABEL.pool]: '1', [LABEL.slot]: '1' },
      });

      const known = await pool.knownMachines();
      assert.deepEqual([...known].sort(), [free.id, held.id, stale.id].sort());
      assert.equal(warnings.filter((w) => w.startsWith('refused box')).length, 4);

      // The live task gets its own box back; the dead claim was cleared, so that box is free.
      assert.equal((await pool.acquire({ tenantId: A, taskId: 'live-task' })).machineId, held.id);
      const other = await pool.acquire({ tenantId: A, taskId: 'n1' });
      assert.equal(other.machineId, free.id);
      const third = await pool.acquire({ tenantId: A, taskId: 'n2' });
      assert.equal(third.machineId, stale.id);
      assert.equal(labelsOf(fleet, stale.id)?.[LABEL.task], 'n2');

      // Invite B has no usable box, so it gets a new one; none of the refused ones.
      const b = await pool.acquire({ tenantId: B, taskId: 'b1' });
      assert.ok(![wrongName.id, outOfRange.id, duplicate.id, noInvite.id].includes(b.machineId));
      assert.equal(labelsOf(fleet, b.machineId)?.[LABEL.invite], B);
    });

    it('keeps a paused box suspended when its stale task label is cleared, so the next task wakes and guards it', async () => {
      const { pool, fleet, guarded } = setup();
      const paused = fleet.seed({
        name: boxName(A, 0),
        state: 'suspended',
        metadata: { [LABEL.pool]: '1', [LABEL.invite]: A, [LABEL.slot]: '0', [LABEL.task]: 'dead' },
      });
      await pool.knownMachines();
      assert.equal(pool.state()[0]?.state, 'suspended');
      await flush();
      assert.equal(
        labelsOf(fleet, paused.id)?.[LABEL.task],
        undefined,
        'the stale label is cleared',
      );
      const lease = await pool.acquire({ tenantId: A, taskId: 't1' });
      assert.equal(lease.machineId, paused.id);
      assert.equal(fleet.callsTo('ensureRunning').length, 1, 'it was woken');
      assert.deepEqual(guarded, [{ machineId: paused.id, reason: 'wake' }]);

      // The same through reconcile: a paused box adopted for a task that has since ended.
      const other = setup();
      other.live.add('old');
      const adoptedFleet = other.fleet;
      adoptedFleet.seed({
        name: boxName(A, 1),
        state: 'suspended',
        metadata: { [LABEL.pool]: '1', [LABEL.invite]: A, [LABEL.slot]: '1', [LABEL.task]: 'old' },
      });
      await other.pool.knownMachines();
      other.live.clear();
      await other.pool.reconcile();
      assert.equal(other.pool.state()[0]?.state, 'suspended');
    });

    it('adopts the box a repeated create finds by name, and guards it before use', async () => {
      const { pool, fleet, guarded } = setup();
      await pool.knownMachines();
      // Another process made the slot's box after this pool looked.
      const existing = fleet.seed({
        name: boxName(A, 0),
        metadata: { [LABEL.pool]: '1', [LABEL.invite]: A, [LABEL.slot]: '0' },
      });
      const lease = await pool.acquire({ tenantId: A, taskId: 't1' });
      assert.equal(lease.machineId, existing.id);
      assert.equal(labelsOf(fleet, existing.id)?.[LABEL.task], 't1');
      assert.deepEqual(guarded, [{ machineId: existing.id, reason: 'create' }]);
    });

    it('does not adopt a box of that name that is broken or held by another task', async () => {
      const { pool, fleet } = setup({ maxPerInvite: 1 });
      await pool.knownMachines();
      fleet.seed({
        name: boxName(A, 0),
        state: 'error',
        metadata: { [LABEL.pool]: '1', [LABEL.invite]: A, [LABEL.slot]: '0' },
      });
      await assert.rejects(pool.acquire({ tenantId: A, taskId: 't1' }), BoxRefusedError);
    });

    it('frees a claim found after a restart only in reconcile, never one a lease in this process holds', async () => {
      const { pool, fleet, live } = setup();
      live.add('old');
      const adopted = fleet.seed({
        name: boxName(A, 1),
        metadata: { [LABEL.pool]: '1', [LABEL.invite]: A, [LABEL.slot]: '1', [LABEL.task]: 'old' },
      });
      const mine = await pool.acquire({ tenantId: A, taskId: 'mine' });
      live.clear();
      await pool.reconcile();
      const states = Object.fromEntries(pool.state().map((box) => [box.machineId, box.taskId]));
      assert.equal(states[mine.machineId], 'mine');
      assert.equal(states[adopted.id], undefined);
      await flush();
      assert.equal(labelsOf(fleet, adopted.id)?.[LABEL.task], undefined);
    });
  });

  it('writes the labels of one box in order, so a box taken again while its clearing write is in flight ends up labelled with the new task', async () => {
    const { pool, fleet } = setup({ maxPerInvite: 1 });
    const first = await pool.acquire({ tenantId: A, taskId: 't1' });
    const clearing = fleet.hold('patchMachineMetadata');
    const release = first.release();
    await clearing.reached;
    // The write that clears t1 is in flight, slow. t2 takes the box now; its write must not overtake.
    const second = pool.acquire({ tenantId: A, taskId: 't2' });
    await flush();
    clearing.release();
    await release;
    const lease = await second;
    assert.equal(lease.machineId, first.machineId);
    assert.equal(labelsOf(fleet, lease.machineId)?.[LABEL.task], 't2');
  });

  describe('restoring a task from a snapshot', () => {
    it('makes a new box from the snapshot for a task whose box is gone, guarded, in the freed slot', async () => {
      const { pool, fleet, guarded } = setup();
      const old = await pool.acquire({ tenantId: A, taskId: 't1' });
      const gone = fleet.machines.get(old.machineId);
      if (gone) gone.state = 'deleted';
      const lease = await pool.restoreFromSnapshot({
        tenantId: A,
        taskId: 't1',
        snapshotId: 'sn_9',
      });
      assert.notEqual(lease.machineId, old.machineId);
      const request = fleet.callsTo('createMachine').at(-1)?.[0] as Record<string, unknown>;
      assert.equal(request.snapshotId, 'sn_9');
      assert.equal(request.templateId, undefined);
      assert.equal(labelsOf(fleet, lease.machineId)?.[LABEL.task], 't1');
      assert.equal(guarded.at(-1)?.reason, 'restore');
      // The lease of the box that is gone cannot free the new one.
      await old.release();
      assert.equal(pool.state().find((b) => b.machineId === lease.machineId)?.taskId, 't1');
    });

    it('leaves a broken box in its slot and fails when no other slot is free', async () => {
      const { pool, fleet } = setup({ maxPerInvite: 1 });
      const old = await pool.acquire({ tenantId: A, taskId: 't1' });
      const broken = fleet.machines.get(old.machineId);
      if (broken) broken.state = 'error';
      await assert.rejects(
        pool.restoreFromSnapshot({ tenantId: A, taskId: 't1', snapshotId: 'sn_9' }),
        NoFreeBoxError,
      );
      assert.equal(fleet.callsTo('createMachine').length, 1);
      assert.equal(pool.state()[0]?.state, 'lost');
    });

    it('dates the broken box it leaves behind, so cleanup deletes it and the slot comes back', async () => {
      const { pool, fleet, clock } = setup({ maxPerInvite: 1 });
      const old = await pool.acquire({ tenantId: A, taskId: 't1' });
      const broken = fleet.machines.get(old.machineId);
      if (broken) broken.state = 'error';
      await assert.rejects(
        pool.restoreFromSnapshot({ tenantId: A, taskId: 't1', snapshotId: 'sn_9' }),
        NoFreeBoxError,
      );
      // Repeated restores do not use up more slots, and the broken one is not forgotten.
      assert.equal(pool.state().length, 1);
      clock.now += 24 * 60 * 60_000;
      const result = await pool.cleanup();
      assert.deepEqual(result.deleted, [old.machineId]);
      assert.equal(pool.state().length, 0, 'the slot is free again');
      const lease = await pool.restoreFromSnapshot({
        tenantId: A,
        taskId: 't1',
        snapshotId: 'sn_9',
      });
      assert.notEqual(lease.machineId, old.machineId);
    });

    it('does not wait for a slot: another task holding the only box fails the restore at once', async () => {
      const { pool, fleet } = setup({ maxPerInvite: 1 });
      await pool.acquire({ tenantId: A, taskId: 't2' });
      await assert.rejects(
        pool.restoreFromSnapshot({ tenantId: A, taskId: 't1', snapshotId: 'sn_9' }),
        NoFreeBoxError,
      );
      assert.equal(fleet.callsTo('createMachine').length, 1);
    });
  });
});
