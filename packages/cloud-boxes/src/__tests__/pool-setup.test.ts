import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { builderLabels, builderName, LABEL } from '../labels.js';
import { BoxRefusedError, NoFreeBoxError } from '../types.js';
import { repoKey, SetupSnapshots } from '../snapshots.js';
import { labelsOf, setup } from './support.js';

const A = 'inv_aaaaaaaaaaaa';
const B = 'inv_bbbbbbbbbbbb';
const MIN = 60_000;
const REPO = 'https://github.com/example/app.git';
const SHA = 'a'.repeat(40);
const choice = (hash = 'h1'.padEnd(16, '0'), snapshotId = 'sn_setup', tenantId = A) => ({
  tenantId,
  setupHash: hash,
  repo: repoKey(REPO),
  snapshotId,
});

describe('boxes and setup snapshots', () => {
  it('makes a box from the repository setup snapshot and labels it with the setup and repository', async () => {
    const t = setup({ setupOf: async () => choice() });
    const lease = await t.pool.acquire({ tenantId: A, taskId: 't1' });
    const [request] = t.fleet.callsTo('createMachine')[0] as [
      { snapshotId?: string; templateId?: string },
    ];
    assert.equal(request.snapshotId, 'sn_setup');
    assert.equal(request.templateId, undefined);
    assert.equal(labelsOf(t.fleet, lease.machineId)?.[LABEL.setup], choice().setupHash);
    assert.equal(labelsOf(t.fleet, lease.machineId)?.[LABEL.repo], repoKey(REPO));
  });

  it('never starts a box from another invite’s setup snapshot, whatever the lookup returned', async () => {
    const t = setup({ setupOf: async () => choice('h1'.padEnd(16, '0'), 'sn_of_b', B) });
    const lease = await t.pool.acquire({ tenantId: A, taskId: 't1' });
    const [request] = t.fleet.callsTo('createMachine')[0] as [
      { snapshotId?: string; templateId?: string },
    ];
    assert.equal(request.snapshotId, undefined);
    assert.equal(request.templateId, 't_node');
    assert.equal(labelsOf(t.fleet, lease.machineId)?.[LABEL.setup], undefined);
    assert.ok(t.warnings.some((w) => w.includes('sn_of_b')));
  });

  it('starts from the template, without setup labels, when the setup snapshot is gone', async () => {
    const t = setup({ setupOf: async () => choice() });
    t.fleet.failNextCreate = { status: 404, code: 'not_found' };
    const lease = await t.pool.acquire({ tenantId: A, taskId: 't1' });
    const [, second] = t.fleet.callsTo('createMachine') as [{ templateId?: string }][][];
    const retry = second?.[0] as { templateId?: string } | undefined;
    assert.equal(retry?.templateId, 't_node');
    assert.equal(labelsOf(t.fleet, lease.machineId)?.[LABEL.setup], undefined);
    assert.equal(labelsOf(t.fleet, lease.machineId)?.[LABEL.repo], undefined);
    assert.ok(t.warnings.some((w) => w.includes('sn_setup')));
  });

  it('does not hide other create failures behind that fallback', async () => {
    const t = setup({ setupOf: async () => choice() });
    t.fleet.failNextCreate = { status: 500, code: 'internal' };
    await assert.rejects(t.pool.acquire({ tenantId: A, taskId: 't1' }));
    assert.equal(t.fleet.callsTo('createMachine').length, 1);
  });

  it('carries on without a setup when the lookup fails', async () => {
    const t = setup({
      setupOf: async () => {
        throw new Error('lookup down');
      },
    });
    const lease = await t.pool.acquire({ tenantId: A, taskId: 't1' });
    assert.ok(lease.machineId);
    assert.ok(t.warnings.some((w) => w.includes('setup snapshot')));
  });

  it('puts a task of a repository on the box that holds its setup', async () => {
    const t = setup({
      setupOf: async (_tenant, taskId) => (taskId.startsWith('r') ? choice() : undefined),
    });
    const unrelated = await t.pool.acquire({ tenantId: A, taskId: 'x1' });
    const first = await t.pool.acquire({ tenantId: A, taskId: 'r1' });
    assert.notEqual(unrelated.machineId, first.machineId);
    await unrelated.release();
    await first.release();
    // Two free boxes: slot 0 without the setup, slot 1 with it. A repo task takes the second, whatever its slot.
    const again = await t.pool.acquire({ tenantId: A, taskId: 'r2' });
    assert.equal(again.machineId, first.machineId);
    assert.equal(t.fleet.callsTo('createMachine').length, 2);
  });
});

describe('.agents/resume', () => {
  const resumeRuns = (t: ReturnType<typeof setup>) =>
    t.fleet.execRequests.filter((request) => request.cmd.includes('.agents/resume'));

  async function sleepingBox(overrides: Parameters<typeof setup>[0] = {}) {
    const t = setup({ setupOf: async () => choice(), ...overrides });
    const lease = await t.pool.acquire({ tenantId: A, taskId: 't1' });
    await lease.release();
    t.clock.now += 21 * MIN;
    await t.pool.sweepIdle();
    t.fleet.execRequests.length = 0;
    t.guarded.length = 0;
    return { ...t, machineId: lease.machineId };
  }

  it('runs after a wake, in the checkout, once the guard has passed', async () => {
    const t = await sleepingBox();
    const events: string[] = [];
    t.fleet.execHandler = (_id, request) => {
      if (request.cmd.includes('.agents/resume')) events.push('resume');
      return {};
    };
    const again = await t.pool.acquire({ tenantId: A, taskId: 't2' });
    assert.equal(again.machineId, t.machineId);
    assert.deepEqual(t.guarded, [{ machineId: t.machineId, reason: 'wake' }]);
    assert.deepEqual(events, ['resume']);
    assert.equal(resumeRuns(t)[0]?.envs.MAKA_REPO_DIR, `/data/maka/repos/${repoKey(REPO)}`);
  });

  it('runs on a box made from the setup snapshot, after the guard', async () => {
    const t = setup({ setupOf: async () => choice() });
    const order: string[] = [];
    const guard = t.guarded;
    t.fleet.execHandler = () => {
      order.push(`exec after ${guard.length} guard(s)`);
      return {};
    };
    await t.pool.acquire({ tenantId: A, taskId: 't1' });
    assert.deepEqual(order, ['exec after 1 guard(s)']);
    assert.equal(resumeRuns(t).length, 1);
  });

  it('is not run for a box that holds no repository, or when the guard refused the box', async () => {
    const plain = setup();
    await plain.pool.acquire({ tenantId: A, taskId: 't1' });
    assert.equal(resumeRuns(plain).length, 0);

    const refused = setup({
      setupOf: async () => choice(),
      beforeUse: async () => {
        throw new Error('egress guard refused');
      },
    });
    await assert.rejects(refused.pool.acquire({ tenantId: A, taskId: 't1' }));
    assert.equal(refused.fleet.execRequests.length, 0);
  });

  it('reports a failing resume and still hands the box out', async () => {
    const failures: { machineId: string; reason: string }[] = [];
    const t = await sleepingBox({
      onResumeFailure: (machineId, reason) => failures.push({ machineId, reason }),
    });
    t.fleet.execHandler = (_id, request) =>
      request.cmd.includes('.agents/resume')
        ? { exitCode: 3, stderr: 'dev server did not start' }
        : {};
    const again = await t.pool.acquire({ tenantId: A, taskId: 't2' });
    assert.equal(again.machineId, t.machineId);
    assert.equal(failures.length, 1);
    assert.match(failures[0]?.reason ?? '', /exit 3.*dev server did not start/s);
    assert.ok(t.warnings.some((w) => w.includes('.agents/resume failed')));
  });

  it('reports a resume that times out or cannot be run, and still hands the box out', async () => {
    const failures: string[] = [];
    const t = await sleepingBox({ onResumeFailure: (_id, reason) => failures.push(reason) });
    t.fleet.failNextExec = true;
    const again = await t.pool.acquire({ tenantId: A, taskId: 't2' });
    assert.equal(again.machineId, t.machineId);
    assert.equal(failures.length, 1);
    t.pool.noteUserActivity(again.machineId);
    await again.release();
    t.clock.now += 21 * MIN;
    await t.pool.sweepIdle();
    t.fleet.execHandler = () => ({ timedOut: true, exitCode: -1 });
    await t.pool.acquire({ tenantId: A, taskId: 't3' });
    assert.equal(failures.length, 2);
    assert.match(failures[1] ?? '', /longer than/);
  });
});

describe('boxes to build setup snapshots in', () => {
  const nameOf = (t: ReturnType<typeof setup>, machineId: string) =>
    t.fleet.machines.get(machineId);

  it('is its own sandbox, outside the pool slots, labelled as a builder, and deleted when given back', async () => {
    const t = setup();
    const task = await t.pool.acquire({ tenantId: A, taskId: 't1' });
    await task.release();
    const builder = await t.pool.builderBoxes().lease({ tenantId: A, job: 'setup-abc' });
    assert.notEqual(builder.machineId, task.machineId, 'never a box a task held');
    const machine = nameOf(t, builder.machineId);
    assert.equal(machine?.name, builderName(A));
    assert.equal(machine?.metadata[LABEL.slot], 'builder');
    assert.equal(machine?.metadata[LABEL.task], 'setup-abc');
    assert.equal(t.pool.state().length, 1, 'the pool does not count it');
    await builder.release();
    assert.equal(nameOf(t, builder.machineId)?.state, 'deleted');
    assert.equal(nameOf(t, task.machineId)?.state, 'running');
  });

  it('works even when all three task boxes of the invite have held tasks', async () => {
    const t = setup();
    const leases = [];
    for (let i = 1; i <= 3; i++)
      leases.push(await t.pool.acquire({ tenantId: A, taskId: `t${i}` }));
    for (const lease of leases) await lease.release();
    const builder = await t.pool.builderBoxes().lease({ tenantId: A, job: 'setup-abc' });
    assert.ok(leases.every((lease) => lease.machineId !== builder.machineId));
    await builder.release();
  });

  it('is one at a time per invite, and the next can start once it is given back', async () => {
    const t = setup();
    const boxes = t.pool.builderBoxes();
    const first = await boxes.lease({ tenantId: A, job: 'setup-abc' });
    await assert.rejects(boxes.lease({ tenantId: A, job: 'setup-def' }), NoFreeBoxError);
    await first.release();
    await first.release();
    const second = await boxes.lease({ tenantId: A, job: 'setup-def' });
    await second.release();
  });

  it('is a NoFreeBoxError when the account has no room, and frees its place', async () => {
    const t = setup();
    t.fleet.accountLimit = 0;
    const boxes = t.pool.builderBoxes();
    await assert.rejects(boxes.lease({ tenantId: A, job: 'setup-abc' }), NoFreeBoxError);
    t.fleet.accountLimit = Number.POSITIVE_INFINITY;
    await (await boxes.lease({ tenantId: A, job: 'setup-abc' })).release();
  });

  it('is deleted when the guard refuses it, with nothing run in it', async () => {
    const t = setup({
      beforeUse: async () => {
        throw new Error('egress guard refused');
      },
    });
    const boxes = t.pool.builderBoxes();
    await assert.rejects(boxes.lease({ tenantId: A, job: 'setup-abc' }), /egress guard refused/);
    const [machine] = [...t.fleet.machines.values()];
    assert.equal(machine?.state, 'deleted');
    assert.equal(t.fleet.execRequests.length, 0);
    // The place is free again.
    await assert.rejects(boxes.lease({ tenantId: A, job: 'setup-def' }), /egress guard refused/);
  });

  it('is deleted when it does not carry the labels that were asked for', async () => {
    const t = setup();
    t.fleet.tamper = (machine) => {
      machine.metadata[LABEL.invite] = 'inv_bbbbbbbbbbbb';
    };
    await assert.rejects(
      t.pool.builderBoxes().lease({ tenantId: A, job: 'setup-abc' }),
      BoxRefusedError,
    );
    assert.equal([...t.fleet.machines.values()][0]?.state, 'deleted');
  });

  it('is deleted at the next start when a process died with it, and nothing else with the pool label is', async () => {
    const t = setup();
    const orphan = t.fleet.seed({ name: builderName(A), metadata: builderLabels(A, 'setup-old') });
    const stranger = t.fleet.seed({ name: 'mk-wrong-b', metadata: builderLabels(A, 'setup-x') });
    const other = t.fleet.seed({ name: builderName(B), metadata: builderLabels(A, 'setup-x') });
    await t.pool.acquire({ tenantId: A, taskId: 't1' });
    assert.equal(orphan.state, 'deleted');
    assert.equal(stranger.state, 'running', 'the name must be the invite builder name');
    assert.equal(other.state, 'running', 'the name must match the invite label');
  });

  it('passes the guard before any command of the checkout, the setup or the preparation runs', async () => {
    const order: string[] = [];
    const t = setup({
      beforeUse: async (_id, reason) => {
        order.push(`guard:${reason}`);
      },
    });
    t.fleet.execHandler = (_id, request) => {
      order.push(request.cmd.includes('git') ? 'checkout' : 'command');
      return {};
    };
    const snapshots = new SetupSnapshots({
      api: t.fleet,
      boxes: t.pool.builderBoxes(),
      guard: async () => {
        order.push('guard:snapshots');
      },
    });
    const made = await snapshots.ensure({
      tenantId: A,
      repoUrl: REPO,
      ref: SHA,
      setupScript: '#!/bin/sh\nnpm ci\n',
      prepare: ['echo install the pinned CLIs'],
      base: 't_node',
    });
    assert.equal(made.built, true);
    assert.equal(order[0], 'guard:create');
    assert.ok(order.includes('checkout') && order.includes('command'));
    assert.equal(
      t.fleet.machines.get(t.fleet.snapshots.get(made.snapshotId)?.sourceMachineId ?? '')?.state,
      'deleted',
      'the builder is gone once the snapshot is saved',
    );
  });

  it('runs nothing for a build when the guard refused the box', async () => {
    const t = setup({
      beforeUse: async () => {
        throw new Error('egress guard refused');
      },
    });
    const snapshots = new SetupSnapshots({
      api: t.fleet,
      boxes: t.pool.builderBoxes(),
      guard: async () => {},
    });
    await assert.rejects(
      snapshots.ensure({
        tenantId: A,
        repoUrl: REPO,
        ref: SHA,
        setupScript: '#!/bin/sh\nnpm ci\n',
        prepare: ['echo hi'],
        base: 't_node',
      }),
    );
    assert.equal(t.fleet.execRequests.length, 0);
    assert.equal(t.fleet.snapshots.size, 0);
  });
});
