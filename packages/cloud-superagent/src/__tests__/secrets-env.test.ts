import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { EnvOrgSecrets } from '../secrets.js';

test('EnvOrgSecrets injects into a bag and never returns the raw value', async () => {
  const secrets = new EnvOrgSecrets({
    env: { MAKA_CLOUD_ORG_SECRET_GH_TOKEN: 'ghs_secret_value' },
  });
  assert.equal(await secrets.has({ tenantId: 'inv_local', name: 'GH_TOKEN' }), true);
  assert.equal(await secrets.has({ tenantId: 'inv_local', name: 'MISSING' }), false);
  const bag: Record<string, string | undefined> = {};
  const injected = await secrets.inject(
    { tenantId: 'inv_local', name: 'GH_TOKEN' },
    { kind: 'env', name: 'GITHUB_TOKEN', env: bag },
  );
  assert.deepEqual(injected, { ok: true });
  assert.equal(bag.GITHUB_TOKEN, 'ghs_secret_value');
  assert.equal(JSON.stringify(injected).includes('ghs_'), false);
  const refused = await secrets.inject(
    { tenantId: 'inv_local', name: 'GH_TOKEN' },
    { kind: 'env', name: 'GITHUB_TOKEN' },
  );
  assert.deepEqual(refused, { ok: false, reason: 'refused' });
});

test('a secrets file can be tenant-scoped', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sa-secrets-'));
  const path = join(dir, 'secrets.json');
  await writeFile(
    path,
    JSON.stringify({ inv_local: { NPM_TOKEN: 'npm_only_here' }, SHARED: 'open' }),
  );
  const secrets = new EnvOrgSecrets({ filePath: path, env: {} });
  const bag: Record<string, string | undefined> = {};
  const ok = await secrets.inject(
    { tenantId: 'inv_local', name: 'NPM_TOKEN' },
    { kind: 'env', name: 'NPM_TOKEN', env: bag },
  );
  assert.equal(ok.ok, true);
  assert.equal(bag.NPM_TOKEN, 'npm_only_here');
  assert.equal(await secrets.has({ tenantId: 'inv_other', name: 'NPM_TOKEN' }), false);
  await rm(dir, { recursive: true, force: true });
});
