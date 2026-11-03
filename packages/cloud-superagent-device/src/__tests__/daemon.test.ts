import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ByomHub,
  DeviceDaemon,
  LoopbackTransport,
  runDeviceDaemonCli,
} from '@maka-cloud/superagent';

test('device package daemon pairs and executes through the in-process hub', async () => {
  const hub = new ByomHub({
    settings: { enabled: true, optedRepos: ['acme/app'] },
    deviceId: () => 'dev_pkg',
    secret: () => 'pkg-secret',
    jobId: () => 'job_pkg',
  });
  const pair = hub.createPairing('inv_test');
  assert.equal(pair.ok, true);
  if (!pair.ok) return;
  const root = await mkdtemp(join(tmpdir(), 'sa-device-'));
  const daemon = new DeviceDaemon({
    root,
    transport: new LoopbackTransport(hub),
    capabilities: {
      os: 'linux',
      arch: 'x64',
      toolchains: ['git', 'node'],
      labels: ['ci'],
    },
    pairingCode: pair.code,
    run: async (cmd) => ({ stdout: `pkg:${cmd}`, stderr: '', exitCode: 0 }),
  });
  const hello = await daemon.pairOrHello();
  assert.equal(hello.type, 'paired');
  const exec = hub.runCommand({
    deviceId: 'dev_pkg',
    tenantId: 'inv_test',
    workerId: 'wrk',
    repo: 'acme/app',
    request: { cmd: 'echo pkg' },
  });
  await daemon.poll();
  const out = await exec;
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.result.stdout, 'pkg:echo pkg');
});

test('device CLI still requires env, not argv, for the pairing material', async () => {
  const missing = await runDeviceDaemonCli(['CODEFROMARGV']);
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'missing_url');
});
