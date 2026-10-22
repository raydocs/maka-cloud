import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { InstaboxClient } from '@maka-cloud/instabox';
import { FakeInstabox } from '@maka-cloud/instabox/testing';
import { Fleet, FixedMachineProvider } from '@maka-cloud/runners';
import { FleetCodingSandbox } from '../sandbox.js';

test('the stop of a check still reaches a box whose guard now fails; repo code does not', async (t) => {
  const tmp = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'sandbox-guard-')));
  const fake = await new FakeInstabox().start();
  t.after(async () => {
    await fake.close();
    await fs.rm(tmp, { recursive: true, force: true });
  });
  let refuse = false;
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
    egressGuard: async () => {
      if (refuse) throw new Error('egress guard: refused');
    },
  });
  const ws = await new FleetCodingSandbox(fleet).open('tsk_guard_stop');
  t.after(() => ws.release());
  assert.equal((await ws.exec('true')).exitCode, 0);
  refuse = true;
  const stopped = await ws.execCheckStop('echo stop-sent');
  assert.equal(stopped.stdout.trim(), 'stop-sent');
  await assert.rejects(ws.exec('echo repo-code'), /refused/u);
});
