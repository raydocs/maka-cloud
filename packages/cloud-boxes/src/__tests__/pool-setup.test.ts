import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InstaboxApiError } from '@maka-cloud/instabox';
import { builderLabels, builderName, LABEL } from '../labels.js';
import { BoxPool } from '../pool.js';
import { BoxRefusedError, NoFreeBoxError } from '../types.js';
import { repoKey, SetupSnapshots } from '../snapshots.js';
import { AGENT, flush, labelsOf, setup } from './support.js';

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

  it('stays waking through the resume: a second ask of the same task waits for it, and a stale lease frees nothing', async () => {
    const t = await sleepingBox({ maxPerInvite: 1 });
    const resume = t.fleet.hold('exec');
    const settled = { first: false, second: false };
    const first = t.pool.acquire({ tenantId: A, taskId: 't1' }).then((lease) => {
      settled.first = true;
      return lease;
    });
    await resume.reached;
    assert.equal(t.pool.state()[0]?.state, 'waking');
    const second = t.pool.acquire({ tenantId: A, taskId: 't1' }).then((lease) => {
      settled.second = true;
      return lease;
    });
    await flush();
    assert.deepEqual(
      settled,
      { first: false, second: false },
      'neither returns before the resume ends',
    );
    // Another task wants the only box: it must wait, the box is still being woken for t1.
    const other = t.pool.acquire({ tenantId: A, taskId: 't2' });
    let otherDone = false;
    void other.then(
      () => {
        otherDone = true;
      },
      () => undefined,
    );
    resume.release();
    const [lease1, lease2] = await Promise.all([first, second]);
    await flush();
    assert.equal(t.pool.state()[0]?.taskId, 't1');
    await lease1.release();
    await flush();
    assert.equal(t.pool.state()[0]?.taskId, 't1', 'the older lease no longer matches the claim');
    assert.equal(otherDone, false, 't2 still has no box');
    await lease2.release();
    assert.equal((await other).machineId, t.machineId, 't2 gets the box once t1 is done');
  });

  it('runs as the unprivileged agent account, after checking that account on this box once', async () => {
    const t = await sleepingBox();
    const first = await t.pool.acquire({ tenantId: A, taskId: 't2' });
    const [run] = resumeRuns(t);
    assert.match(run?.cmd ?? '', /^sudo -n -u 'maka-agent' -- env -i PATH=/);
    assert.match(run?.cmd ?? '', /\${MAKA_REPO_DIR\+"MAKA_REPO_DIR=\$MAKA_REPO_DIR"}/);
    assert.match(run?.cmd ?? '', /\.agents\/resume/);
    assert.deepEqual(t.fleet.agentChecks, [{ machineId: t.machineId, user: 'maka-agent' }]);
    await first.release();
    t.clock.now += 21 * MIN;
    await t.pool.sweepIdle();
    await t.pool.acquire({ tenantId: A, taskId: 't3' });
    assert.equal(resumeRuns(t).length, 2, 'it runs again after the next wake');
    assert.equal(t.fleet.agentChecks.length, 1, 'but the account is checked once per box');
  });

  it('does not run the repository script, and says so, when the account can use sudo or has capabilities', async () => {
    for (const facts of [
      'FACT dev_uid=1000\nFACT agent_uid=1001\nFACT agent_sudo=yes\nFACT agent_nocaps=yes\n',
      'FACT dev_uid=1000\nFACT agent_uid=1001\nFACT agent_sudo=no\nFACT agent_nocaps=no\n',
      'FACT dev_uid=1000\nFACT agent_uid=1000\nFACT agent_sudo=no\nFACT agent_nocaps=yes\n',
      '',
    ]) {
      const failures: string[] = [];
      const t = setup({
        setupOf: async () => choice(),
        onResumeFailure: (_id, reason) => failures.push(reason),
      });
      t.fleet.agentFacts = facts;
      const lease = await t.pool.acquire({ tenantId: A, taskId: 't2' });
      assert.ok(lease.machineId, 'the box is still handed out');
      assert.equal(resumeRuns(t).length, 0, 'but no repository code ran on it');
      assert.match(failures[0] ?? '', /agent account/);
    }
  });

  it('runs no repository script at all when no agent account is configured', async () => {
    const failures: string[] = [];
    const t = setup({
      setupOf: async () => choice(),
      onResumeFailure: (_id, reason) => failures.push(reason),
    });
    // A pool built without the account, over the same fleet.
    const bare = new BoxPool({
      api: t.fleet,
      source: () => ({ templateId: 't_node' }),
      isTaskLive: () => false,
      setupOf: async () => choice(),
      onResumeFailure: (_id, reason) => failures.push(reason),
      timers: t.timers,
      now: () => t.clock.now,
    });
    await bare.acquire({ tenantId: A, taskId: 't1' });
    assert.equal(resumeRuns(t).length, 0);
    assert.equal(t.fleet.agentChecks.length, 0);
    assert.match(failures[0] ?? '', /no unprivileged agent account/);
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

  /** Makes the wait for a delete operation a handshake: it ends when the test says. */
  function holdDeletes(t: ReturnType<typeof setup>) {
    const real = t.fleet.waitForOperation.bind(t.fleet);
    const gates: { id: string; open: () => void }[] = [];
    let reached!: () => void;
    const first = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const deleting = new Set<string>();
    const realDelete = t.fleet.deleteMachine.bind(t.fleet);
    t.fleet.deleteMachine = async (id: string) => {
      const operation = await realDelete(id);
      deleting.add(operation.id);
      return operation;
    };
    t.fleet.waitForOperation = async (id: string) => {
      if (deleting.has(id)) {
        await new Promise<void>((resolve) => {
          gates.push({ id, open: resolve });
          reached();
        });
      }
      return await real(id);
    };
    return { first, openAll: () => gates.splice(0).forEach((gate) => gate.open()) };
  }

  it('waits for instabox to finish deleting before it says the builder is given back', async () => {
    const t = setup();
    const gate = holdDeletes(t);
    const builder = await t.pool.builderBoxes().lease({ tenantId: A, job: 'setup-abc' });
    let given = false;
    const release = Promise.resolve(builder.release()).then(() => {
      given = true;
    });
    await gate.first;
    await flush();
    assert.equal(given, false, 'the delete operation is still running');
    gate.openAll();
    await release;
    assert.equal(given, true);
  });

  it('removes a builder it could not delete before the next build, and refuses the build while it cannot', async () => {
    const t = setup();
    const boxes = t.pool.builderBoxes();
    const first = await boxes.lease({ tenantId: A, job: 'setup-abc' });
    const realDelete = t.fleet.deleteMachine.bind(t.fleet);
    let failing = true;
    t.fleet.deleteMachine = async (id: string) => {
      if (failing) throw new Error('instabox is unreachable');
      return await realDelete(id);
    };
    await first.release();
    assert.equal(nameOf(t, first.machineId)?.state, 'running', 'it is still there');
    await assert.rejects(boxes.lease({ tenantId: A, job: 'setup-def' }), NoFreeBoxError);
    assert.equal(t.fleet.callsTo('createMachine').length, 1, 'nothing is made over the name');
    failing = false;
    const second = await boxes.lease({ tenantId: A, job: 'setup-def' });
    assert.equal(nameOf(t, first.machineId)?.state, 'deleted');
    assert.notEqual(second.machineId, first.machineId);
  });

  it('waits for the delete of a builder left by an earlier process before the pool starts', async () => {
    const t = setup();
    const gate = holdDeletes(t);
    const orphan = t.fleet.seed({ name: builderName(A), metadata: builderLabels(A, 'setup-old') });
    let started = false;
    const acquire = t.pool.acquire({ tenantId: A, taskId: 't1' }).then(() => {
      started = true;
    });
    await gate.first;
    await flush();
    assert.equal(started, false, 'discovery is still waiting for the delete');
    gate.openAll();
    await acquire;
    assert.equal(orphan.state, 'deleted');
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
      agent: AGENT,
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

describe('a builder box left over from an earlier build', () => {
  it('does not block the next build once it is gone', async () => {
    const t = setup();
    const boxes = t.pool.builderBoxes();
    const first = await boxes.lease({ tenantId: A, job: 'setup-abc' });
    const realDelete = t.fleet.deleteMachine.bind(t.fleet);
    let failing = true;
    t.fleet.deleteMachine = async (id: string) => {
      if (failing) throw new Error('instabox is unreachable');
      // Instabox answers 404 for a sandbox that is already gone.
      if (t.fleet.machines.get(id)?.state !== 'running') {
        throw new InstaboxApiError(404, { code: 'not_found', message: 'no such sandbox' });
      }
      return await realDelete(id);
    };
    await first.release();
    // The delete went through after all (or the operator removed the box).
    const leftover = t.fleet.machines.get(first.machineId);
    assert.ok(leftover);
    leftover.state = 'deleted';
    failing = false;
    const second = await boxes.lease({ tenantId: A, job: 'setup-def' });
    assert.notEqual(second.machineId, first.machineId);
    await second.release();
    assert.equal(t.fleet.machines.get(second.machineId)?.state, 'deleted');
  });
});
