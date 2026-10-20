import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InstaboxClient } from '@maka-cloud/instabox';
import { FixedMachineProvider } from '../providers.js';
import { collect, notes, reader, setup, terminal } from './harness.js';

/** Everything a run may hold: sandbox lease, model access, the activity lease, watches, timers. */
async function assertReleased(h: Awaited<ReturnType<typeof setup>>, taskId: string) {
  assert.equal(h.runners.fleet.openRuns, 0, 'run still open');
  assert.equal(h.runners.fleet.poller.watchCount(), 0, 'poll watch left behind');
  assert.equal(h.fake.leases.size, 0, 'activity lease left behind');
  assert.ok(h.revoked.includes(taskId), 'model access not revoked');
  assert.deepEqual(
    await h.runners.fleet.machine(h.fake.machineId).liveTaskDirs(),
    [],
    'process left',
  );
}

test('every way a run can end releases what it holds', async (t) => {
  await t.test('success', async () => {
    const h = await setup();
    t.after(() => h.cleanup());
    await collect(await h.runners.claude.start(await h.spec('tsk_x_ok')));
    await assertReleased(h, 'tsk_x_ok');
  });

  await t.test('the CLI fails', async () => {
    const h = await setup();
    t.after(() => h.cleanup());
    await h.setMode('fail');
    await collect(await h.runners.claude.start(await h.spec('tsk_x_fail')));
    await assertReleased(h, 'tsk_x_fail');
  });

  await t.test('cancel', async () => {
    const h = await setup();
    t.after(() => h.cleanup());
    await h.setMode('hang');
    const handle = await h.runners.claude.start(await h.spec('tsk_x_cancel'));
    const events = reader(handle);
    await events.until((e) => e.type === 'progress' && e.note === 'working on it');
    await handle.cancel();
    await events.rest();
    await assertReleased(h, 'tsk_x_cancel');
  });

  await t.test('the sandbox cannot be reached while polling', async () => {
    const h = await setup({ cloud: { pollMaxFailures: 2 } });
    t.after(() => h.cleanup());
    h.fake.onExec = (request) =>
      request.body.cmd.includes('while IFS')
        ? { status: 503, error: { code: 'host_unavailable', message: 'down', retryable: false } }
        : undefined;
    const events = await collect(await h.runners.claude.start(await h.spec('tsk_x_down')));
    const last = terminal(events);
    assert.equal(last?.type, 'failed');
    assert.match(last?.type === 'failed' ? last.reason : '', /sandbox unreachable/);
    h.fake.onExec = undefined;
    await assertReleased(h, 'tsk_x_down');
  });

  await t.test('the CLI never starts', async () => {
    const h = await setup({ cloud: { startTimeoutMs: 30 } });
    t.after(() => h.cleanup());
    // The launch script is accepted but the process never writes a pid.
    h.fake.onExec = (request) =>
      request.body.cmd.includes('ALREADY') ? { stdin: 'exit 0\n' } : undefined;
    const events = await collect(await h.runners.claude.start(await h.spec('tsk_x_start')));
    const last = terminal(events);
    assert.equal(last?.type, 'failed');
    assert.match(last?.type === 'failed' ? last.reason : '', /did not start/);
    h.fake.onExec = undefined;
    await assertReleased(h, 'tsk_x_start');
  });

  await t.test('no sandbox can be acquired', async () => {
    const h = await setup({
      cloud: { sandboxes: new FixedMachineProvider('m_other', 'someone-else') },
    });
    t.after(() => h.cleanup());
    const events = await collect(await h.runners.claude.start(await h.spec('tsk_x_acq')));
    assert.match(JSON.stringify(events), /No sandbox is assigned to tenant/);
    assert.equal(h.runners.fleet.openRuns, 0);
    assert.ok(h.revoked.includes('tsk_x_acq'));
  });

  await t.test('the install fails', async () => {
    const h = await setup({
      installClis: false,
      cloud: { installCommands: { 'claude-agent-sdk': 'echo no network; exit 4' } },
    });
    t.after(() => h.cleanup());
    const events = await collect(await h.runners.claude.start(await h.spec('tsk_x_inst')));
    assert.match(JSON.stringify(events), /installing claude@9\.9\.9/);
    await assertReleased(h, 'tsk_x_inst');
  });

  await t.test('restore after a restart', async () => {
    const h = await setup();
    t.after(() => h.cleanup());
    await h.setMode('hang');
    const events = reader(await h.runners.claude.start(await h.spec('tsk_x_rest')));
    await events.until((e) => e.type === 'progress' && e.note === 'working on it');
    await h.makeRunners().claude.stopOrphaned('tsk_x_rest');
    await events.rest();
    await assertReleased(h, 'tsk_x_rest');
  });

  await t.test('a thrown error while writing the result', async () => {
    const h = await setup();
    t.after(() => h.cleanup());
    const base = await h.spec('tsk_x_write');
    // resultPath is a directory, so the rename fails.
    const { mkdir } = await import('node:fs/promises');
    await mkdir(base.resultPath, { recursive: true });
    const events = await collect(await h.runners.claude.start(base));
    assert.equal(terminal(events)?.type, 'failed');
    await assertReleased(h, 'tsk_x_write');
  });

  void InstaboxClient;
  void notes;
});

test('a task whose tenant cannot be named fails before any sandbox is acquired', async (t) => {
  const acquired: string[] = [];
  const h = await setup({
    cloud: {
      tenantOf: () => {
        throw new Error('Task has no owning invite, so no sandbox');
      },
      sandboxes: {
        knownMachines: () => [],
        acquire: async (input) => {
          acquired.push(input.tenantId);
          return { machineId: 'm_shared', release: () => undefined };
        },
      },
    },
  });
  t.after(() => h.cleanup());
  const events = await collect(await h.runners.claude.start(await h.spec('tsk_no_tenant')));
  const last = terminal(events);
  assert.equal(last?.type, 'failed');
  assert.match(last?.type === 'failed' ? last.reason : '', /no owning invite/);
  assert.deepEqual(acquired, [], 'no machine was asked for, so none could be shared');
  assert.equal(h.runners.fleet.openRuns, 0);
  assert.ok(h.revoked.includes('tsk_no_tenant'), 'the run’s model access is revoked');
});
