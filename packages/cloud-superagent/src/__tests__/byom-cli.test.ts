import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ByomHub, handleByomHttpJson } from '../byom.js';
import { runDeviceDaemonCli } from '../byom-cli.js';
import { TENANT } from './harness.js';

test('device CLI pairs over long-poll HTTP and writes the credential, not argv secrets', async () => {
  const hub = new ByomHub({
    settings: { enabled: true, optedRepos: ['acme/app'] },
    deviceId: () => 'dev_cli',
    secret: () => 'cli-secret',
  });
  const pair = hub.createPairing(TENANT);
  assert.equal(pair.ok, true);
  if (!pair.ok) return;
  const dir = await mkdtemp(join(tmpdir(), 'byom-cli-'));
  const state = join(dir, 'device.json');
  const root = join(dir, 'ws');
  const seen: unknown[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    seen.push(body);
    const reply = await handleByomHttpJson(hub, body);
    return new Response(JSON.stringify(reply), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const result = await runDeviceDaemonCli(['--once'], {
    env: {
      MAKA_CLOUD_BYOM_URL: 'https://cloud.example/v1/byom',
      MAKA_CLOUD_BYOM_CODE: pair.code,
      MAKA_CLOUD_BYOM_STATE: state,
      MAKA_CLOUD_BYOM_ROOT: root,
      MAKA_CLOUD_BYOM_TOOLS: 'git,xcodebuild',
    },
    fetch: fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(result.deviceId, 'dev_cli');
  const stored = JSON.parse(await readFile(state, 'utf8')) as { deviceId: string; secret: string };
  assert.equal(stored.deviceId, 'dev_cli');
  assert.equal(stored.secret, 'cli-secret');
  assert.equal(
    JSON.stringify(seen).includes('cli-secret'),
    false,
    'pairing secret must not be posted back after it is minted',
  );
});

test('device CLI refuses to start without URL/root/state (no secret on argv)', async () => {
  const missing = await runDeviceDaemonCli(['--once'], { env: {} });
  assert.deepEqual(missing, { ok: false, reason: 'missing_url' });
});
