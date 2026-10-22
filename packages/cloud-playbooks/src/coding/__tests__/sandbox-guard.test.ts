import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { InstaboxClient } from '@maka-cloud/instabox';
import { FakeInstabox } from '@maka-cloud/instabox/testing';
import { Fleet, FixedMachineProvider } from '@maka-cloud/runners';
import { FleetCodingSandbox } from '../sandbox.js';
import { BASE_RESTORE_SCRIPT } from '../scripts.js';

/** A fleet on a fake box whose egress guard refuses once `refuse` is set. */
async function guarded(t: TestContext, agentChannel?: { user: string; group: string }) {
  const tmp = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'sandbox-guard-')));
  const fake = await new FakeInstabox().start();
  t.after(async () => {
    await fake.close();
    await fs.rm(tmp, { recursive: true, force: true });
  });
  const state = { refuse: false };
  const fleet = new Fleet({
    client: new InstaboxClient({
      apiKey: fake.apiKey,
      baseUrl: fake.url,
      sleep: async () => {},
      random: () => 0,
    }),
    sandboxes: new FixedMachineProvider(fake.machineId),
    workRoot: join(tmp, 'work'),
    logRoot: join(tmp, 'logs'),
    pollIntervalMs: 5,
    ...(agentChannel ? { agentChannel } : {}),
    egressGuard: async () => {
      if (state.refuse) throw new Error('egress guard: refused');
    },
  });
  return { fake, fleet, state };
}

test('the stop of a check still reaches a box whose guard now fails; repo code does not', async (t) => {
  const { fleet, state } = await guarded(t);
  const ws = await new FleetCodingSandbox(fleet).open('tsk_guard_stop');
  t.after(() => ws.release());
  assert.equal((await ws.exec('true')).exitCode, 0);
  state.refuse = true;
  const stopped = await ws.execCheckStop('echo stop-sent');
  assert.equal(stopped.stdout.trim(), 'stop-sent');
  await assert.rejects(ws.exec('echo repo-code'), /refused/u);
});

test('the restore after a base check, run as the agent account, still reaches a box whose guard now fails', async (t) => {
  // The test's own account stands in for the agent's: what counts is whether the script reaches the box.
  const me = userInfo();
  const group = execFileSync('id', ['-gn'], { encoding: 'utf8' }).trim();
  const { fake, fleet, state } = await guarded(t, { user: me.username, group });
  fleet.ensureAgentIsolation = async () => {};
  const sent: string[] = [];
  fake.onExec = (request) => {
    if (typeof request.body?.cmd === 'string') sent.push(request.body.cmd);
    return undefined;
  };
  const taskId = 'tsk_guard_restore';
  await fleet.machine(fake.machineId).prepare(taskId);
  const ws = await new FleetCodingSandbox(fleet).open(taskId);
  t.after(() => ws.release());
  await ws.exec('mkdir -p "$MAKA_DIR/workspace"', { envs: { MAKA_DIR: ws.dir } });
  state.refuse = true;
  await assert.rejects(ws.execCheck('echo repo-code'), /refused/u);
  sent.length = 0;
  // The change a base check took away is put back all the same.
  await ws.execCheck(BASE_RESTORE_SCRIPT, { envs: { MAKA_DIR: ws.dir } });
  assert.ok(
    sent.some((cmd) => cmd.includes('restore()')),
    'the restore was not sent to the box',
  );
});
