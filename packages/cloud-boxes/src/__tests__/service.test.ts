import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { startBoxService } from '../service.js';
import type { BoxApi } from '../types.js';
import { FakeFleet } from './fake-fleet.js';
import { flush, ManualTimers } from './support.js';

const A = 'inv_aaaaaaaaaaaa';
const MIN = 60_000;

function start(overrides: Partial<Parameters<typeof startBoxService>[0]> = {}) {
  const fleet = new FakeFleet();
  const timers = new ManualTimers();
  const warnings: string[] = [];
  const guarded: string[] = [];
  const clock = { now: 1_000_000 };
  const service = startBoxService({
    client: fleet as unknown as Parameters<typeof startBoxService>[0]['client'],
    templateId: 't_node',
    isTaskLive: () => false,
    guard: async (machineId) => {
      guarded.push(machineId);
    },
    timers,
    onWarning: (message) => warnings.push(message),
    pool: { now: () => clock.now },
    ...overrides,
  });
  return { fleet, timers, warnings, guarded, clock, service };
}
void ({} as BoxApi);

describe('box service', () => {
  it('makes boxes from the template and guards each before it is used', async () => {
    const t = start();
    const lease = await t.service.pool.acquire({ tenantId: A, taskId: 't1' });
    assert.deepEqual(t.guarded, [lease.machineId]);
    const [request] = t.fleet.callsTo('createMachine')[0] as [{ templateId?: string }];
    assert.equal(request.templateId, 't_node');
    await t.service.close();
  });

  it('puts idle boxes to sleep on the sweep timer and guards the wake', async () => {
    const t = start();
    const lease = await t.service.pool.acquire({ tenantId: A, taskId: 't1' });
    await lease.release();
    t.clock.now += 30 * MIN;
    assert.deepEqual(t.timers.limits, [MIN, 5 * MIN]);
    t.timers.fire(MIN);
    await flush();
    assert.equal(t.fleet.machines.get(lease.machineId)?.state, 'suspended');
    assert.deepEqual(
      t.timers.limits.sort((a, b) => a - b),
      [MIN, 5 * MIN],
      'the next sweep is set after this one',
    );
    t.guarded.length = 0;
    await t.service.pool.acquire({ tenantId: A, taskId: 't2' });
    assert.deepEqual(t.guarded, [lease.machineId]);
    await t.service.close();
  });

  it('runs the cleanup on its timer', async () => {
    const t = start();
    t.timers.fire(5 * MIN);
    await flush();
    assert.equal(t.fleet.callsTo('listMachines').length, 1);
    await t.service.close();
  });

  it('reports a failing loop and keeps going', async () => {
    const t = start();
    t.fleet.listMachines = async () => {
      throw new Error('instabox is down');
    };
    t.timers.fire(MIN);
    await flush();
    assert.ok(t.warnings.some((w) => w.includes('sweep failed')));
    assert.ok(t.timers.limits.includes(MIN), 'the next sweep is set');
    await t.service.close();
  });

  it('never runs a loop twice at once: the next run is set only after the last one ends', async () => {
    const t = start();
    const held = t.fleet.hold('listMachines');
    t.timers.fire(MIN);
    await held.reached;
    assert.equal(t.timers.limits.filter((ms) => ms === MIN).length, 0);
    held.release();
    await flush();
    assert.equal(t.timers.limits.filter((ms) => ms === MIN).length, 1);
    await t.service.close();
  });

  it('close stops the loops, waits for a run that is going, and refuses new tasks', async () => {
    const t = start();
    const held = t.fleet.hold('listMachines');
    t.timers.fire(MIN);
    await held.reached;
    let closed = false;
    const closing = t.service.close().then(() => {
      closed = true;
    });
    await flush();
    assert.equal(closed, false, 'it waits for the sweep');
    held.release();
    await closing;
    assert.deepEqual(t.timers.limits, [], 'no timer is left');
    await assert.rejects(t.service.pool.acquire({ tenantId: A, taskId: 't1' }), /shut down/);
  });

  it('a guard that fails keeps the box from the task', async () => {
    const t = start({
      guard: async () => {
        throw new Error('egress guard refused');
      },
    });
    await assert.rejects(
      t.service.pool.acquire({ tenantId: A, taskId: 't1' }),
      /egress guard refused/,
    );
    await t.service.close();
  });

  it('waits on close for a create that is under way, and hands its box to no one', async () => {
    const t = start();
    const creating = t.fleet.hold('createMachine');
    const asking = t.service.pool.acquire({ tenantId: A, taskId: 't1' });
    await creating.reached;
    let closed = false;
    const closing = t.service.close().then(() => {
      closed = true;
    });
    await flush();
    assert.equal(closed, false, 'close waits for the create');
    creating.release();
    await assert.rejects(asking, /shut down/);
    await closing;
    assert.equal(t.service.pool.state()[0]?.state, 'ready');
  });

  it('frees the box of a task that ended on the sweep timer, so a waiting task gets it', async () => {
    const live = new Set(['t1']);
    const t = start({ isTaskLive: (taskId) => live.has(taskId), maxPerInvite: 1 });
    const run = await t.service.pool.acquire({ tenantId: A, taskId: 't1' });
    await run.release();
    const waiting = t.service.pool.acquire({ tenantId: A, taskId: 't2' });
    await flush();
    assert.equal(t.service.pool.waiting(A), 1);
    live.delete('t1');
    t.timers.fire(MIN);
    await flush();
    assert.equal((await waiting).machineId, run.machineId);
    await t.service.close();
  });
});
