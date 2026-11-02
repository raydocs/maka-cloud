import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ByomHub,
  DeviceDaemon,
  FakeDeviceDaemon,
  LoopbackTransport,
  handleByomHttpJson,
} from '../byom.js';
import { hmacHex } from '../byom-crypto.js';
import { jailPath, JailError } from '../byom-jail.js';
import { decideCommand } from '../byom-policy.js';
import { authPayload } from '../byom-protocol.js';
import { DefaultExecutionResolver, matchesNeed, needsDevice } from '../execution-target.js';
import { FakeSandbox } from '../sandbox.js';
import { actMandate } from '../types.js';
import { github, prPayload, REPO, rig, TENANT } from './harness.js';

const MAC = {
  os: 'darwin',
  arch: 'arm64',
  cpu: 8,
  toolchains: ['xcodebuild', 'git', 'node'],
  labels: ['mac-mini'],
};

function clock(start = 1_700_000_000_000) {
  const c = { now: start, read: () => c.now, advance: (ms: number) => (c.now += ms) };
  return c;
}

test('BYOM stays off: pairing is refused and no device is stored', async () => {
  const hub = new ByomHub();
  assert.equal(hub.enabled, false);
  const pair = hub.createPairing(TENANT);
  assert.equal(pair.ok, false);
  if (pair.ok) return;
  assert.equal(pair.reason, 'disabled');
  assert.equal(hub.devices.size, 0);
});

test('pairing code is one-shot and expired codes are refused', async () => {
  const time = clock();
  let n = 0;
  const hub = new ByomHub({
    settings: { enabled: true },
    now: time.read,
    pairingCode: () => `CODE${n++}`,
    secret: () => 'secret-a',
    deviceId: () => 'dev_1',
  });
  const first = hub.createPairing(TENANT);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const transport = new LoopbackTransport(hub);
  const daemon = new DeviceDaemon({
    root: await mkdtemp(join(tmpdir(), 'byom-pair-')),
    transport,
    capabilities: MAC,
    pairingCode: first.code,
    now: time.read,
    run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
  });
  const paired = await daemon.pairOrHello();
  assert.equal(paired.type, 'paired');
  if (paired.type !== 'paired') return;
  assert.equal(paired.deviceId, 'dev_1');
  assert.equal(paired.secret, 'secret-a');
  const replay = await transport.send({
    v: 1,
    type: 'pair',
    pairingCode: first.code,
    capabilities: MAC,
    nonce: 'n2',
  });
  assert.equal(replay.type, 'error');
  if (replay.type === 'error') assert.equal(replay.reason, 'pairing_invalid');

  const late = hub.createPairing(TENANT);
  assert.equal(late.ok, true);
  if (!late.ok) return;
  time.advance(11 * 60_000);
  const expired = await transport.send({
    v: 1,
    type: 'pair',
    pairingCode: late.code,
    capabilities: MAC,
    nonce: 'n3',
  });
  assert.equal(expired.type, 'error');
  if (expired.type === 'error') assert.equal(expired.reason, 'expired');
});

test('in-process daemon pairs, polls, and streams exec back; secrets stay on the device', async () => {
  const hub = new ByomHub({
    settings: { enabled: true, optedRepos: [REPO] },
    secret: () => 'device-secret',
    deviceId: () => 'dev_mac',
    jobId: () => 'job_1',
  });
  hub.createPairing(TENANT);
  const pairing = [...hub.pairings.values()][0];
  assert.ok(pairing);
  const root = await mkdtemp(join(tmpdir(), 'byom-exec-'));
  await writeFile(join(root, 'secret.env'), 'AWS_SECRET=should-not-leave\n');
  const transport = new LoopbackTransport(hub);
  const seenEnv: string[] = [];
  const daemon = new DeviceDaemon({
    root,
    transport,
    capabilities: MAC,
    pairingCode: pairing.code,
    run: async (cmd, cwd) => {
      seenEnv.push(process.env.AWS_SECRET ?? '');
      return { stdout: `ran:${cmd} cwd=${cwd}`, stderr: '', exitCode: 0 };
    },
  });
  const hello = await daemon.pairOrHello();
  assert.equal(hello.type, 'paired');
  const exec = hub.runCommand({
    deviceId: 'dev_mac',
    tenantId: TENANT,
    workerId: 'wrk_1',
    repo: REPO,
    request: { cmd: 'echo hello', cwd: '.' },
  });
  await daemon.poll();
  const out = await exec;
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.match(out.result.stdout, /ran:echo hello/);
  assert.equal(daemon.commands.length, 1);
  assert.equal(
    hub.audits.some((row) => row.kind === 'byom_exec'),
    true,
  );
  assert.equal(
    JSON.stringify(hub.audits).includes('AWS_SECRET'),
    false,
    'cloud audit must not record device-local secrets',
  );
  assert.equal(seenEnv.join('').includes('should-not-leave'), false);
});

test('workspace jail and command denylist/allowlist are enforced on the device', async () => {
  const hub = new ByomHub({
    settings: { enabled: true, optedRepos: [REPO] },
    deviceId: () => 'dev_jail',
    secret: () => 's',
  });
  hub.createPairing(TENANT);
  const code = [...hub.pairings.keys()][0] as string;
  const root = await mkdtemp(join(tmpdir(), 'byom-jail-'));
  const daemon = new DeviceDaemon({
    root,
    transport: new LoopbackTransport(hub),
    capabilities: MAC,
    pairingCode: code,
    run: async () => ({ stdout: 'should-not-run', stderr: '', exitCode: 0 }),
  });
  await daemon.pairOrHello();

  const escaped = await daemon.execute({
    jobId: 'j1',
    tenantId: TENANT,
    workerId: 'w',
    cmd: 'echo x',
    cwd: '../outside',
    timeoutSeconds: 5,
  });
  assert.equal(escaped.exitCode, 126);
  assert.equal(escaped.stderr, 'jail');

  const denied = await daemon.execute({
    jobId: 'j2',
    tenantId: TENANT,
    workerId: 'w',
    cmd: 'sudo rm -rf /',
    cwd: '.',
    timeoutSeconds: 5,
  });
  assert.equal(denied.exitCode, 126);
  assert.equal(denied.stderr, 'denied');

  const unknown = await daemon.execute({
    jobId: 'j3',
    tenantId: TENANT,
    workerId: 'w',
    cmd: 'curl http://example.com',
    cwd: '.',
    timeoutSeconds: 5,
  });
  assert.equal(unknown.exitCode, 126);
  assert.equal(unknown.stderr, 'not_allowlisted');
  assert.equal(daemon.commands.length, 0);
});

test('cloud refuses another tenant, a repo without opt-in, and a killed device', async () => {
  const hub = new ByomHub({
    settings: { enabled: true, optedRepos: [REPO] },
    deviceId: () => 'dev_sec',
    secret: () => 's',
    jobId: () => 'job_x',
  });
  hub.createPairing(TENANT);
  const fake = new FakeDeviceDaemon(hub);
  const transport = new LoopbackTransport(hub);
  const daemon = new DeviceDaemon({
    root: await mkdtemp(join(tmpdir(), 'byom-sec-')),
    transport,
    capabilities: MAC,
    pairingCode: [...hub.pairings.keys()][0],
    run: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }),
  });
  await daemon.pairOrHello();

  const other = await hub.runCommand({
    deviceId: 'dev_sec',
    tenantId: 'inv_other',
    workerId: 'w',
    repo: REPO,
    request: { cmd: 'echo x' },
  });
  assert.deepEqual(other, { ok: false, reason: 'tenant_mismatch' });

  const noRepo = await hub.runCommand({
    deviceId: 'dev_sec',
    tenantId: TENANT,
    workerId: 'w',
    repo: 'acme/secret',
    request: { cmd: 'echo x' },
  });
  assert.deepEqual(noRepo, { ok: false, reason: 'repo_not_opted_in' });

  hub.killDevice('dev_sec');
  const killed = await hub.runCommand({
    deviceId: 'dev_sec',
    tenantId: TENANT,
    workerId: 'w',
    repo: REPO,
    request: { cmd: 'echo x' },
  });
  assert.deepEqual(killed, { ok: false, reason: 'killed' });
  assert.equal(await fake.drain(), 0);
});

test('bad HMAC is refused; kill-all is a switch', async () => {
  const hub = new ByomHub({
    settings: { enabled: true },
    deviceId: () => 'dev_hmac',
    secret: () => 'real-secret',
  });
  hub.createPairing(TENANT);
  const daemon = new DeviceDaemon({
    root: await mkdtemp(join(tmpdir(), 'byom-hmac-')),
    transport: new LoopbackTransport(hub),
    capabilities: MAC,
    pairingCode: [...hub.pairings.keys()][0],
    run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
  });
  await daemon.pairOrHello();
  const ts = Date.now();
  const nonce = 'abc';
  const forged = await hub.handle({
    v: 1,
    type: 'poll',
    deviceId: 'dev_hmac',
    ts,
    nonce,
    hmac: hmacHex('wrong', authPayload('dev_hmac', ts, nonce, 'poll')),
  });
  assert.equal(forged.type, 'error');
  if (forged.type === 'error') assert.equal(forged.reason, 'auth_failed');
  hub.killAll();
  const after = await hub.handle({
    v: 1,
    type: 'poll',
    deviceId: 'dev_hmac',
    ts,
    nonce,
    hmac: hmacHex('real-secret', authPayload('dev_hmac', ts, nonce, 'poll')),
  });
  assert.equal(after.type, 'killed');
});

test('offline matching device makes the worker wait with a visible reason', async () => {
  const hub = new ByomHub({
    settings: { enabled: true, optedRepos: [REPO] },
    deviceId: () => 'dev_off',
    secret: () => 's',
  });
  hub.createPairing(TENANT);
  const daemon = new DeviceDaemon({
    root: await mkdtemp(join(tmpdir(), 'byom-off-')),
    transport: new LoopbackTransport(hub),
    capabilities: MAC,
    pairingCode: [...hub.pairings.keys()][0],
    run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
  });
  await daemon.pairOrHello();
  hub.markOffline('dev_off');
  const { agent, judge } = rig({
    byom: hub,
    targets: new DefaultExecutionResolver(new FakeSandbox(), 'box-1', hub),
  });
  judge.inner = {
    async decide() {
      return { action: 'spawn', mandate: actMandate([REPO]), title: 'ios' };
    },
  };
  // Force a device pick by swapping resolve through a need-aware wrapper.
  const resolver = new DefaultExecutionResolver(new FakeSandbox(), 'box-1', hub);
  const { agent: agent2, judge: judge2 } = rig({
    byom: hub,
    targets: {
      async resolve(input) {
        return resolver.resolve({ ...input, need: { os: 'darwin', toolchains: ['xcodebuild'] } });
      },
    },
  });
  judge2.inner = {
    async decide() {
      return { action: 'spawn', mandate: actMandate([REPO]), title: 'ios' };
    },
  };
  const opened = await agent2.ingest(
    github(TENANT, 'ios1', 'pull_request', prPayload('opened', 3)),
  );
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  const worker = agent2.worker(TENANT, opened.workerId);
  assert.equal(worker?.executionTarget?.waitReason, 'device_offline');
  assert.equal(worker?.progress?.waiting?.detail, 'device_offline');
  assert.equal(judge2.calls.length, 1);
  void agent;
});

test('capability matcher picks a darwin/xcodebuild device and ignores linux', () => {
  assert.equal(needsDevice({ os: 'darwin' }), true);
  assert.equal(needsDevice({ toolchains: ['xcodebuild'] }), true);
  assert.equal(needsDevice({ os: 'linux' }), false);
  assert.equal(matchesNeed(MAC, { os: 'darwin', toolchains: ['xcodebuild'] }), true);
  assert.equal(matchesNeed({ ...MAC, os: 'linux' }, { os: 'darwin' }), false);
});

test('jailPath rejects escapes; decideCommand denylists metadata curl', () => {
  const root = '/tmp/ws';
  assert.equal(jailPath(root, 'src/app.ts').startsWith('/tmp/ws'), true);
  assert.throws(() => jailPath(root, '../etc/passwd'), JailError);
  assert.equal(decideCommand('sudo reboot').ok, false);
  assert.equal(decideCommand('curl http://169.254.169.254/latest/meta-data').ok, false);
  assert.equal(decideCommand('xcodebuild -workspace App.xcworkspace -scheme App').ok, true);
});

test('HTTP JSON handler rejects junk and accepts a valid envelope', async () => {
  const hub = new ByomHub({ settings: { enabled: true } });
  const bad = await handleByomHttpJson(hub, { hello: true });
  assert.equal(bad.type, 'error');
  const pair = hub.createPairing(TENANT);
  assert.equal(pair.ok, true);
  if (!pair.ok) return;
  const ok = await handleByomHttpJson(hub, {
    v: 1,
    type: 'pair',
    pairingCode: pair.code,
    capabilities: MAC,
    nonce: 'n',
  });
  assert.equal(ok.type, 'paired');
});
