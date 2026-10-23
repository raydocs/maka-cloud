import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { boxName, LABEL } from '../labels.js';
import { flush, labelsOf, setup } from './support.js';

const A = 'inv_aaaaaaaaaaaa';
const MIN = 60_000;

/** A pool with one released box that has been idle for `idleMs`. */
async function idleBox(
  idleMs: number,
  overrides: Parameters<typeof setup>[0] = {},
): Promise<ReturnType<typeof setup> & { machineId: string }> {
  const t = setup(overrides);
  const lease = await t.pool.acquire({ tenantId: A, taskId: 't1' });
  await lease.release();
  t.clock.now += idleMs;
  return { ...t, machineId: lease.machineId };
}

describe('putting boxes to sleep', () => {
  it('suspends a box whose agent was idle 5 minutes and nobody looked for 20, after a checkpoint', async () => {
    const t = await idleBox(21 * MIN);
    const slept = await t.pool.sweepIdle();
    assert.deepEqual(slept, [t.machineId]);
    assert.equal(t.pool.state()[0]?.state, 'suspended');
    assert.deepEqual(
      t.fleet.execLog.map((entry) => entry.cmd),
      ['sync'],
    );
    assert.equal(t.fleet.machines.get(t.machineId)?.state, 'suspended');
  });

  it('leaves alone a box that is claimed, or idle for too short a time, or looked at lately', async () => {
    const claimed = setup();
    await claimed.pool.acquire({ tenantId: A, taskId: 't1' });
    claimed.clock.now += 60 * MIN;
    assert.deepEqual(await claimed.pool.sweepIdle(), []);

    const brief = await idleBox(4 * MIN);
    assert.deepEqual(await brief.pool.sweepIdle(), []);

    const watched = await idleBox(30 * MIN);
    watched.clock.now -= 5 * MIN;
    watched.pool.noteUserActivity(watched.machineId);
    watched.clock.now += 5 * MIN + 10 * MIN;
    assert.deepEqual(await watched.pool.sweepIdle(), [], 'looked at 10 minutes ago');
    watched.clock.now += 11 * MIN;
    assert.deepEqual(await watched.pool.sweepIdle(), [watched.machineId]);
    assert.equal(brief.fleet.callsTo('suspendMachine').length, 0);
    assert.equal(claimed.fleet.callsTo('suspendMachine').length, 0);
  });

  it('turns the sleep back when a task takes the box during the checkpoint, and suspends nothing', async () => {
    const t = await idleBox(30 * MIN);
    const checkpoint = t.fleet.hold('exec');
    const sweep = t.pool.sweepIdle();
    await checkpoint.reached;
    assert.equal(t.pool.state()[0]?.state, 'suspending');
    const lease = await t.pool.acquire({ tenantId: A, taskId: 't2' });
    assert.equal(lease.machineId, t.machineId);
    checkpoint.release();
    assert.deepEqual(await sweep, []);
    assert.equal(t.fleet.callsTo('suspendMachine').length, 0);
    assert.equal(t.pool.state()[0]?.taskId, 't2');
    assert.equal(t.pool.state()[0]?.state, 'claimed');
  });

  it('turns the sleep back when a write or a look shows up at the last re-check', async () => {
    let written = true;
    const t = await idleBox(30 * MIN, { recentWrite: async () => written });
    assert.deepEqual(await t.pool.sweepIdle(), []);
    assert.equal(t.fleet.callsTo('suspendMachine').length, 0);
    assert.equal(t.pool.state()[0]?.state, 'ready');
    written = false;
    assert.deepEqual(await t.pool.sweepIdle(), [t.machineId]);

    // A look that arrives while the checkpoint runs counts too.
    const u = await idleBox(30 * MIN);
    const checkpoint = u.fleet.hold('exec');
    const sweep = u.pool.sweepIdle();
    await checkpoint.reached;
    u.pool.noteUserActivity(u.machineId);
    checkpoint.release();
    assert.deepEqual(await sweep, []);
    assert.equal(u.fleet.callsTo('suspendMachine').length, 0);
  });

  it('treats a recent-write check that cannot tell as a write', async () => {
    const t = await idleBox(30 * MIN, {
      recentWrite: async () => {
        throw new Error('exec failed');
      },
    });
    assert.deepEqual(await t.pool.sweepIdle(), []);
    assert.equal(t.fleet.callsTo('suspendMachine').length, 0);
    assert.equal(t.pool.state()[0]?.state, 'ready');
    assert.equal(t.warnings.length, 1);
  });

  it('does not suspend a box twice when two sweeps run at once', async () => {
    const t = await idleBox(30 * MIN);
    const checkpoint = t.fleet.hold('exec');
    const first = t.pool.sweepIdle();
    const second = t.pool.sweepIdle();
    await checkpoint.reached;
    checkpoint.release();
    await Promise.all([first, second]);
    assert.equal(t.fleet.callsTo('suspendMachine').length, 1);
  });

  describe('a sleep that fails while a task takes the box', () => {
    /** The checkpoint fails, and the follow-up look at the box is held until the test lets it answer. */
    async function failedSleepWithLateLookup(answer: 'unreachable' | 'paused') {
      const t = await idleBox(30 * MIN);
      t.fleet.failNextExec = true;
      const real = t.fleet.getMachine.bind(t.fleet);
      let looks = 0;
      let reached!: () => void;
      const lookReached = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let open!: () => void;
      const lookMayAnswer = new Promise<void>((resolve) => {
        open = resolve;
      });
      t.fleet.getMachine = async (id: string) => {
        looks++;
        if (looks !== 2) return await real(id);
        reached();
        await lookMayAnswer;
        if (answer === 'unreachable') throw new Error('instabox unreachable');
        const machine = await real(id);
        return { ...machine, state: 'suspended' as const };
      };
      const sweep = t.pool.sweepIdle();
      await lookReached;
      assert.equal(t.pool.state()[0]?.state, 'suspending');
      const lease = await t.pool.acquire({ tenantId: A, taskId: 't2' });
      assert.equal(lease.machineId, t.machineId);
      open();
      await sweep;
      return { ...t, lease };
    }

    it('does not wipe the new task’s claim when the late lookup fails', async () => {
      const t = await failedSleepWithLateLookup('unreachable');
      assert.equal(t.pool.state()[0]?.state, 'claimed');
      assert.equal(t.pool.state()[0]?.taskId, 't2');
      await t.lease.release();
      assert.equal(t.pool.state()[0]?.state, 'ready', 'the task’s own lease still frees the box');
    });

    it('does not mark a box the new task holds as suspended when the late lookup says it is paused', async () => {
      const t = await failedSleepWithLateLookup('paused');
      assert.equal(t.pool.state()[0]?.state, 'claimed');
      assert.equal(t.pool.state()[0]?.taskId, 't2');
    });
  });

  it('asks instabox again when a suspend fails: running is ready again, paused is suspended, broken is lost', async () => {
    const t = await idleBox(30 * MIN);
    t.fleet.failNextSuspend = true;
    assert.deepEqual(await t.pool.sweepIdle(), []);
    assert.equal(t.pool.state()[0]?.state, 'ready');
    // It is not tried again at once.
    assert.deepEqual(await t.pool.sweepIdle(), []);
    assert.equal(t.fleet.callsTo('suspendMachine').length, 1);

    const paused = await idleBox(30 * MIN);
    paused.fleet.failNextSuspend = true;
    const machine = paused.fleet.machines.get(paused.machineId);
    // The suspend fails from the client's side, but instabox did pause the box.
    const real = paused.fleet.waitForOperation.bind(paused.fleet);
    paused.fleet.waitForOperation = async (id: string) => {
      if (machine) machine.state = 'suspended';
      return await real(id);
    };
    assert.deepEqual(await paused.pool.sweepIdle(), []);
    assert.equal(paused.pool.state()[0]?.state, 'suspended');

    const broken = await idleBox(30 * MIN);
    broken.fleet.failNextSuspend = true;
    const real2 = broken.fleet.waitForOperation.bind(broken.fleet);
    broken.fleet.waitForOperation = async (id: string) => {
      const m = broken.fleet.machines.get(broken.machineId);
      if (m) m.state = 'error';
      return await real2(id);
    };
    await broken.pool.sweepIdle();
    assert.equal(broken.pool.state()[0]?.state, 'lost');
  });

  it('notes a box instabox already paused for idleness instead of suspending it again', async () => {
    const t = await idleBox(30 * MIN);
    const machine = t.fleet.machines.get(t.machineId);
    if (machine) machine.state = 'suspended';
    assert.deepEqual(await t.pool.sweepIdle(), []);
    assert.equal(t.pool.state()[0]?.state, 'suspended');
    assert.equal(t.fleet.execLog.length, 0, 'a command would have woken it');
    assert.equal(t.fleet.callsTo('suspendMachine').length, 0);
  });
});

describe('waking boxes', () => {
  it('wakes the sleeping box a task takes, guards it, and keeps the label for the task', async () => {
    const t = await idleBox(30 * MIN);
    await t.pool.sweepIdle();
    t.guarded.length = 0;
    const lease = await t.pool.acquire({ tenantId: A, taskId: 't2' });
    assert.equal(lease.machineId, t.machineId, 'a sleeping box is woken before a new one is made');
    assert.equal(t.fleet.callsTo('ensureRunning').length, 1);
    assert.deepEqual(t.guarded, [{ machineId: t.machineId, reason: 'wake' }]);
    assert.equal(t.fleet.callsTo('createMachine').length, 1);
    assert.equal(t.pool.state()[0]?.state, 'claimed');
    assert.equal(labelsOf(t.fleet, t.machineId)?.[LABEL.task], 't2');
  });

  it('prefers a box that is awake to one that sleeps', async () => {
    const t = setup();
    const a = await t.pool.acquire({ tenantId: A, taskId: 't1' });
    const b = await t.pool.acquire({ tenantId: A, taskId: 't2' });
    await a.release();
    await b.release();
    t.clock.now += 30 * MIN;
    t.pool.noteUserActivity(b.machineId);
    await t.pool.sweepIdle(); // only a goes to sleep: b was looked at just now
    assert.equal(t.fleet.machines.get(a.machineId)?.state, 'suspended');
    const lease = await t.pool.acquire({ tenantId: A, taskId: 't3' });
    assert.equal(lease.machineId, b.machineId);
    assert.equal(t.fleet.callsTo('ensureRunning').length, 0);
  });

  it('tries a wake that timed out once more with a longer limit before the box counts as lost', async () => {
    const t = await idleBox(30 * MIN);
    await t.pool.sweepIdle();
    t.fleet.wakeScript = ['hang', 'ok'];
    const acquiring = t.pool.acquire({ tenantId: A, taskId: 't2' });
    await flush();
    assert.deepEqual(t.timers.history, [60_000], 'the first wake has one minute');
    t.timers.fire(60_000);
    await flush();
    assert.deepEqual(t.timers.history, [60_000, 180_000], 'the second has three');
    const lease = await acquiring;
    assert.equal(lease.machineId, t.machineId);
    assert.equal(t.fleet.callsTo('ensureRunning').length, 2);
    assert.equal(t.pool.state()[0]?.state, 'claimed');
    assert.deepEqual(
      t.warnings.filter((w) => w.includes('lost')),
      [],
    );
  });

  it('marks the box lost after a second failed wake and gives the task another box', async () => {
    const t = await idleBox(30 * MIN);
    await t.pool.sweepIdle();
    t.fleet.wakeScript = ['fail', 'fail'];
    const lease = await t.pool.acquire({ tenantId: A, taskId: 't2' });
    assert.notEqual(lease.machineId, t.machineId);
    const states = Object.fromEntries(t.pool.state().map((box) => [box.machineId, box.state]));
    assert.equal(states[t.machineId], 'lost');
    assert.equal(states[lease.machineId], 'claimed');
    assert.equal(t.fleet.callsTo('ensureRunning').length, 2);
  });

  it('does not retry a wake of a box that is gone', async () => {
    const t = await idleBox(30 * MIN);
    await t.pool.sweepIdle();
    t.fleet.wakeScript = ['gone', 'ok'];
    const lease = await t.pool.acquire({ tenantId: A, taskId: 't2' });
    assert.notEqual(lease.machineId, t.machineId);
    assert.equal(t.fleet.callsTo('ensureRunning').length, 1);
  });

  it('does not use a woken box that fails its guard', async () => {
    let fail = false;
    const t = await idleBox(30 * MIN, {
      beforeUse: async (_id, reason) => {
        if (reason === 'wake' && fail) throw new Error('egress guard refused');
      },
    });
    await t.pool.sweepIdle();
    fail = true;
    const lease = await t.pool.acquire({ tenantId: A, taskId: 't2' });
    assert.notEqual(lease.machineId, t.machineId, 'the new box passed its create guard');
    assert.equal(t.pool.state().find((box) => box.machineId === t.machineId)?.state, 'lost');
    assert.ok(t.warnings.some((w) => w.includes('guard')));
  });

  it('two asks by one task wake the box once', async () => {
    const t = await idleBox(30 * MIN);
    await t.pool.sweepIdle();
    const wake = t.fleet.hold('ensureRunning');
    const first = t.pool.acquire({ tenantId: A, taskId: 't2' });
    await wake.reached;
    const second = t.pool.acquire({ tenantId: A, taskId: 't2' });
    await flush();
    wake.release();
    const [one, two] = await Promise.all([first, second]);
    assert.equal(one.machineId, two.machineId);
    assert.equal(t.fleet.callsTo('ensureRunning').length, 1);
  });

  it('finds sleeping boxes after a restart, and a live task whose box sleeps gets it woken', async () => {
    const t = setup();
    t.live.add('old');
    const asleep = t.fleet.seed({
      name: boxName(A, 0),
      state: 'suspended',
      metadata: { [LABEL.pool]: '1', [LABEL.invite]: A, [LABEL.slot]: '0', [LABEL.task]: 'old' },
    });
    const lease = await t.pool.acquire({ tenantId: A, taskId: 'old' });
    assert.equal(lease.machineId, asleep.id);
    assert.equal(t.fleet.callsTo('ensureRunning').length, 1);
    assert.equal(t.pool.state()[0]?.state, 'claimed');
  });

  it('a task that releases while its box sleeps is not a problem: release, sleep, claim again', async () => {
    const t = await idleBox(30 * MIN);
    await t.pool.sweepIdle();
    const first = await t.pool.acquire({ tenantId: A, taskId: 't2' });
    await first.release();
    t.clock.now += 30 * MIN;
    assert.deepEqual(await t.pool.sweepIdle(), [t.machineId]);
    const again = await t.pool.acquire({ tenantId: A, taskId: 't3' });
    assert.equal(again.machineId, t.machineId);
    assert.equal(t.fleet.callsTo('ensureRunning').length, 2);
  });
});

describe('the sleep sweep and task labels', () => {
  it('refuses, and does not suspend, an idle box whose label names another live task', async () => {
    const t = await idleBox(30 * MIN);
    t.live.add('elsewhere');
    const machine = t.fleet.machines.get(t.machineId);
    assert.ok(machine);
    machine.metadata = { ...machine.metadata, [LABEL.task]: 'elsewhere' };
    assert.deepEqual(await t.pool.sweepIdle(), []);
    assert.equal(t.fleet.callsTo('suspendMachine').length, 0);
    assert.equal(t.fleet.execLog.length, 0, 'no checkpoint ran in it');
    assert.equal(t.pool.state()[0]?.state, 'refused');
    assert.equal(labelsOf(t.fleet, t.machineId)?.[LABEL.task], 'elsewhere');
  });
});
