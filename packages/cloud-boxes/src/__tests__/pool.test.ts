import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { boxName, LABEL } from '../labels.js';
import { InstaboxOperationError } from '@maka-cloud/instabox';
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

  it('keeps a box whose create is still running when the wait runs out, as lost, but forgets one whose create failed', async () => {
    const t = setup();
    const wait = t.fleet.waitForOperation.bind(t.fleet);
    let timeouts = 1;
    t.fleet.waitForOperation = async (id: string) => {
      if (timeouts-- > 0) {
        throw new InstaboxOperationError(
          id,
          `instabox operation ${id} (create) still running after the wait deadline.`,
          'unknown',
        );
      }
      return await wait(id);
    };
    await assert.rejects(t.pool.acquire({ tenantId: A, taskId: 't1' }), /still running/);
    const [kept] = t.pool.state();
    assert.equal(kept?.state, 'lost', 'the machine may exist, so the slot keeps it');
    assert.ok(kept?.machineId);
    assert.ok(t.fleet.machines.has(kept?.machineId as string));
    // A later task is not told the box "already belongs to" the first one.
    const second = await t.pool.acquire({ tenantId: A, taskId: 't2' });
    assert.notEqual(second.machineId, kept?.machineId);

    // An operation instabox reports as failed left no machine: the slot is free again.
    const failing = setup();
    failing.fleet.failNextOperation = true;
    await assert.rejects(failing.pool.acquire({ tenantId: A, taskId: 't1' }), /failed/);
    assert.deepEqual(failing.pool.state(), []);
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

  describe('a box whose identity changed under the pool', () => {
    it('is not handed out and not relabelled: it is refused, and the task gets another box', async () => {
      const { pool, fleet, warnings } = setup();
      const first = await pool.acquire({ tenantId: A, taskId: 't1' });
      await first.release();
      const machine = fleet.machines.get(first.machineId);
      assert.ok(machine);
      // Someone relabels the idle box for another invite.
      machine.metadata = { ...machine.metadata, [LABEL.invite]: B };
      const lease = await pool.acquire({ tenantId: A, taskId: 't2' });
      assert.notEqual(lease.machineId, first.machineId, 'A is not given the box labelled for B');
      assert.equal(
        fleet.machines.get(first.machineId)?.metadata?.[LABEL.invite],
        B,
        'its labels were not overwritten',
      );
      assert.equal(pool.state().find((row) => row.machineId === first.machineId)?.state, 'refused');
      assert.deepEqual(
        pool.refusedBoxes().map((entry) => entry.machineId),
        [first.machineId],
      );
      assert.ok(warnings.some((w) => w.includes('refused box')));
      await lease.release();
      assert.equal(
        fleet.machines.get(first.machineId)?.metadata?.[LABEL.invite],
        B,
        'still untouched',
      );
    });

    it('is refused when another live task holds it, and its label is left alone', async () => {
      const { pool, fleet, live } = setup();
      const first = await pool.acquire({ tenantId: A, taskId: 't1' });
      await first.release();
      live.add('elsewhere');
      const machine = fleet.machines.get(first.machineId);
      assert.ok(machine);
      machine.metadata = { ...machine.metadata, [LABEL.task]: 'elsewhere' };
      const lease = await pool.acquire({ tenantId: A, taskId: 't2' });
      assert.notEqual(lease.machineId, first.machineId);
      assert.equal(fleet.machines.get(first.machineId)?.metadata?.[LABEL.task], 'elsewhere');
    });

    it('is not put to sleep: the sweep refuses it before the checkpoint', async () => {
      const t = setup();
      const first = await t.pool.acquire({ tenantId: A, taskId: 't1' });
      await first.release();
      t.clock.now += 30 * 60_000;
      const machine = t.fleet.machines.get(first.machineId);
      assert.ok(machine);
      machine.metadata = { ...machine.metadata, [LABEL.slot]: '2' };
      assert.deepEqual(await t.pool.sweepIdle(), []);
      assert.equal(t.fleet.execLog.length, 0, 'no checkpoint ran in it');
      assert.equal(t.fleet.callsTo('suspendMachine').length, 0);
      assert.equal(t.pool.state()[0]?.state, 'refused');
    });

    it('is refused, not marked lost, when a restore finds it broken under other labels', async () => {
      const { pool, fleet } = setup({ maxPerInvite: 2 });
      const old = await pool.acquire({ tenantId: A, taskId: 't1' });
      const machine = fleet.machines.get(old.machineId);
      assert.ok(machine);
      machine.state = 'error';
      machine.metadata = { ...machine.metadata, [LABEL.invite]: B };
      const lease = await pool.restoreFromSnapshot({
        tenantId: A,
        taskId: 't1',
        snapshotId: 'sn_9',
      });
      assert.notEqual(lease.machineId, old.machineId);
      assert.equal(pool.state().find((row) => row.machineId === old.machineId)?.state, 'refused');
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

describe('review fixes before the pool goes on', () => {
  it('never hands out a box that a newer ask of the same task refused while the older one looked', async () => {
    const { pool, fleet } = setup();
    const first = await pool.acquire({ tenantId: A, taskId: 't1' });
    const machine = fleet.machines.get(first.machineId);
    assert.ok(machine);
    machine.metadata = { ...machine.metadata, [LABEL.invite]: B };
    const looking = fleet.hold('getMachine');
    const older = pool.acquire({ tenantId: A, taskId: 't1' });
    await looking.reached;
    // The newer ask reads the box, refuses it and takes another slot.
    const newer = await pool.acquire({ tenantId: A, taskId: 't1' });
    assert.notEqual(newer.machineId, first.machineId);
    looking.release();
    const lease = await older;
    assert.notEqual(lease.machineId, first.machineId, 'the refused box is not handed out');
    assert.equal(lease.machineId, newer.machineId, 'the task stays on one box');
    assert.equal(pool.state().find((row) => row.machineId === first.machineId)?.state, 'refused');
  });

  it('a restore refuses, and does not mark lost, a box whose label names another live task', async () => {
    const { pool, fleet, live } = setup({ maxPerInvite: 2 });
    const old = await pool.acquire({ tenantId: A, taskId: 't1' });
    live.add('t1');
    live.add('elsewhere');
    const machine = fleet.machines.get(old.machineId);
    assert.ok(machine);
    machine.state = 'error';
    machine.metadata = { ...machine.metadata, [LABEL.task]: 'elsewhere' };
    const lease = await pool.restoreFromSnapshot({ tenantId: A, taskId: 't1', snapshotId: 'sn_9' });
    assert.notEqual(lease.machineId, old.machineId);
    assert.equal(pool.state().find((row) => row.machineId === old.machineId)?.state, 'refused');
    assert.equal(labelsOf(fleet, old.machineId)?.[LABEL.task], 'elsewhere', 'left as it was');

    // The restoring task's own label is not a reason to refuse: that box is lost, as before.
    const own = setup({ maxPerInvite: 2 });
    const mine = await own.pool.acquire({ tenantId: A, taskId: 't1' });
    own.live.add('t1');
    const broken = own.fleet.machines.get(mine.machineId);
    assert.ok(broken);
    broken.state = 'error';
    await own.pool.restoreFromSnapshot({ tenantId: A, taskId: 't1', snapshotId: 'sn_9' });
    assert.equal(own.pool.state().find((row) => row.machineId === mine.machineId)?.state, 'lost');
  });

  it('a task keeps its box across its runs: a run that ends while the task is live frees nothing', async () => {
    const { pool, fleet, live } = setup({ maxPerInvite: 1 });
    live.add('t1');
    const run1 = await pool.acquire({ tenantId: A, taskId: 't1' });
    await run1.release();
    assert.equal(pool.state()[0]?.taskId, 't1', 'the task still holds its box between runs');
    assert.equal(labelsOf(fleet, run1.machineId)?.[LABEL.task], 't1');
    const other = pool.acquire({ tenantId: A, taskId: 't2' });
    let otherGot = false;
    void other.then(
      () => {
        otherGot = true;
      },
      () => undefined,
    );
    await flush();
    assert.equal(otherGot, false, 'another task does not get the box between the runs');
    // The next run borrows the same box, and its end frees nothing either.
    const run2 = await pool.acquire({ tenantId: A, taskId: 't1' });
    assert.equal(run2.machineId, run1.machineId);
    await run2.release();
    await flush();
    assert.equal(otherGot, false);
    // Once the task has ended the box is free for the next one.
    live.delete('t1');
    await pool.reconcile();
    assert.equal((await other).machineId, run1.machineId);
    assert.equal(labelsOf(fleet, run1.machineId)?.[LABEL.task], 't2');
  });

  it('frees the box of a task that ended for the next ask, without waiting for reconcile', async () => {
    const { pool, live } = setup({ maxPerInvite: 1 });
    live.add('t1');
    const run = await pool.acquire({ tenantId: A, taskId: 't1' });
    await run.release();
    live.delete('t1');
    const next = await pool.acquire({ tenantId: A, taskId: 't2' });
    assert.equal(next.machineId, run.machineId);
  });

  it('gives a task of another invite that waits at the account limit the room a deleted box leaves', async () => {
    const { pool, fleet, clock } = setup({ cleanup: { idleDeleteMs: 60_000 } });
    fleet.accountLimit = 1;
    const a = await pool.acquire({ tenantId: A, taskId: 't1' });
    await assert.rejects(pool.acquire({ tenantId: B, taskId: 't2' }), NoFreeBoxError);
    const waiting = pool.acquire({ tenantId: B, taskId: 't3' });
    await flush();
    assert.equal(pool.waiting(B), 1, 'the limit is known, so it waits');
    await a.release();
    clock.now += 61_000;
    assert.deepEqual((await pool.cleanup()).deleted, [a.machineId]);
    await flush();
    assert.equal(pool.waiting(B), 0, 'the room went to the waiting invite');
    const lease = await waiting;
    assert.notEqual(lease.machineId, a.machineId);
  });

  it('makes nothing for an ask that was under way when the pool shut down', async () => {
    const { pool, fleet } = setup();
    const listing = fleet.hold('listMachines');
    const asking = pool.acquire({ tenantId: A, taskId: 't1' });
    await listing.reached;
    pool.dispose();
    listing.release();
    await assert.rejects(asking, /shut down/);
    assert.equal(fleet.callsTo('createMachine').length, 0);
  });

  it('hands out no box whose create ended after the shutdown, and keeps the box, free', async () => {
    const { pool, fleet } = setup();
    const creating = fleet.hold('createMachine');
    const asking = pool.acquire({ tenantId: A, taskId: 't1' });
    await creating.reached;
    pool.dispose();
    let settled = false;
    const waiting = pool.settled().then(() => {
      settled = true;
    });
    await flush();
    assert.equal(settled, false, 'the shutdown waits for the create');
    creating.release();
    await assert.rejects(asking, /shut down/);
    await waiting;
    const [box] = pool.state();
    assert.equal(box?.state, 'ready');
    assert.equal(box?.taskId, undefined);
    assert.equal(labelsOf(fleet, box?.machineId as string)?.[LABEL.task], undefined);
  });

  it('keeps a live task’s box when its next ask fails on the way, so no other task gets it', async () => {
    const { pool, fleet, live } = setup({ maxPerInvite: 1 });
    live.add('t1');
    const run1 = await pool.acquire({ tenantId: A, taskId: 't1' });
    await run1.release();
    const real = fleet.getMachine.bind(fleet);
    let failures = 1;
    fleet.getMachine = async (id: string) => {
      if (failures-- > 0) throw new Error('instabox is unreachable');
      return await real(id);
    };
    await assert.rejects(pool.acquire({ tenantId: A, taskId: 't1' }), /unreachable/);
    assert.equal(pool.state()[0]?.taskId, 't1', 'the task still holds its box');
    const other = pool.acquire({ tenantId: A, taskId: 't2' });
    await flush();
    assert.equal(pool.waiting(A), 1, 'another task waits instead of taking it');
    const again = await pool.acquire({ tenantId: A, taskId: 't1' });
    assert.equal(again.machineId, run1.machineId);
    void other.catch(() => undefined);
  });

  it('queues no waiter for a create the account refused after the shutdown', async () => {
    const { pool, fleet } = setup();
    await pool.acquire({ tenantId: A, taskId: 't1' });
    fleet.accountLimit = 1;
    const creating = fleet.hold('createMachine');
    const asking = pool.acquire({ tenantId: A, taskId: 't2' });
    await creating.reached;
    pool.dispose();
    const refused = assert.rejects(asking, /shut down/);
    creating.release();
    await flush();
    assert.equal(pool.waiting(), 0, 'nothing waits after the shutdown');
    await refused;
    await pool.settled();
  });

  it('waits on shutdown for the label write that gives back a box made after it', async () => {
    const { pool, fleet } = setup();
    const creating = fleet.hold('createMachine');
    const asking = pool.acquire({ tenantId: A, taskId: 't1' });
    await creating.reached;
    pool.dispose();
    const clearing = fleet.hold('patchMachineMetadata');
    let settled = false;
    const waiting = pool.settled().then(() => {
      settled = true;
    });
    creating.release();
    await clearing.reached;
    await flush();
    assert.equal(settled, false, 'the give-back write is still under way');
    clearing.release();
    await assert.rejects(asking, /shut down/);
    await waiting;
  });

  it('puts back the claim of a run still under way when a newer ask of its task fails', async () => {
    const { pool, fleet, live } = setup({ maxPerInvite: 1 });
    live.add('t1');
    const running = await pool.acquire({ tenantId: A, taskId: 't1' });
    const real = fleet.getMachine.bind(fleet);
    let failures = 1;
    fleet.getMachine = async (id: string) => {
      if (failures-- > 0) throw new Error('instabox is unreachable');
      return await real(id);
    };
    await assert.rejects(pool.acquire({ tenantId: A, taskId: 't1' }), /unreachable/);
    // The task ends while its run still unwinds: the box is the run's until it gives it back.
    live.delete('t1');
    await pool.reconcile();
    const other = pool.acquire({ tenantId: A, taskId: 't2' });
    await flush();
    assert.equal(pool.waiting(A), 1, 'the next task waits for the run');
    await running.release();
    assert.equal((await other).machineId, running.machineId);
  });

  it('does not put back the claim of a run that gave its lease back while a newer ask was under way', async () => {
    const { pool, fleet } = setup({ maxPerInvite: 1 });
    const running = await pool.acquire({ tenantId: A, taskId: 't1' });
    let fail!: () => void;
    const real = fleet.getMachine.bind(fleet);
    fleet.getMachine = async (id: string) => {
      await new Promise<void>((resolve) => {
        fail = resolve;
      });
      fleet.getMachine = real;
      throw new Error('instabox is unreachable');
    };
    const repeat = pool.acquire({ tenantId: A, taskId: 't1' });
    await flush();
    await running.release();
    fail();
    await assert.rejects(repeat, /unreachable/);
    const next = await pool.acquire({ tenantId: A, taskId: 't2' });
    assert.equal(next.machineId, running.machineId, 'the box is free, not held for ever');
  });

  it('waits on shutdown for the give-back write of an ask that failed', async () => {
    const { pool, fleet } = setup();
    const first = await pool.acquire({ tenantId: A, taskId: 't1' });
    await first.release();
    let fail!: () => void;
    const real = fleet.getMachine.bind(fleet);
    fleet.getMachine = async (id: string) => {
      await new Promise<void>((resolve) => {
        fail = resolve;
      });
      fleet.getMachine = real;
      throw new Error('instabox is unreachable');
    };
    const asking = pool.acquire({ tenantId: A, taskId: 't2' });
    const refused = assert.rejects(asking, /unreachable/);
    await flush();
    pool.dispose();
    const clearing = fleet.hold('patchMachineMetadata');
    let settled = false;
    const waiting = pool.settled().then(() => {
      settled = true;
    });
    fail();
    await clearing.reached;
    await flush();
    assert.equal(settled, false, 'the give-back write is still under way');
    clearing.release();
    await refused;
    await waiting;
  });

  it('puts back the run’s claim when two newer asks of its task both fail, the older first', async () => {
    const { pool, fleet } = setup({ maxPerInvite: 1 });
    const running = await pool.acquire({ tenantId: A, taskId: 't1' });
    const gates: (() => void)[] = [];
    const real = fleet.getMachine.bind(fleet);
    fleet.getMachine = async () => {
      await new Promise<void>((resolve) => gates.push(resolve));
      throw new Error('instabox is unreachable');
    };
    const b = pool.acquire({ tenantId: A, taskId: 't1' });
    const c = pool.acquire({ tenantId: A, taskId: 't1' });
    const bFails = assert.rejects(b, /unreachable/);
    const cFails = assert.rejects(c, /unreachable/);
    await flush();
    assert.equal(gates.length, 2);
    gates[0]?.();
    await bFails;
    gates[1]?.();
    await cFails;
    fleet.getMachine = real;
    const other = pool.acquire({ tenantId: A, taskId: 't2' });
    await flush();
    assert.equal(pool.waiting(A), 1, 'the run still holds the box');
    await running.release();
    await flush();
    assert.equal(pool.waiting(A), 0, 'its release frees the box');
    assert.equal((await other).machineId, running.machineId);
  });
});
