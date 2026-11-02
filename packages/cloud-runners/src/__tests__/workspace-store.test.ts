import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { InstaboxClient } from '@maka-cloud/instabox';
import { createCloudRunners, FixedMachineProvider } from '../index.js';
import { GitCloneStore, initLocalRepo, LayerFsStore, workspaceStoreFromEnv } from '../workspace.js';

test('the fleet defaults to GitCloneStore and LayerFS stays off unless flagged', () => {
  const fleet = createCloudRunners({
    client: new InstaboxClient({ apiKey: 'ibk_test', baseUrl: 'http://127.0.0.1:9' }),
    sandboxes: new FixedMachineProvider('m_test'),
  }).fleet;
  assert.equal(fleet.workspaces.kind, 'git-clone');
  assert.ok(fleet.workspaces instanceof GitCloneStore);
  assert.equal(workspaceStoreFromEnv({}).kind, 'git-clone');
  assert.equal(workspaceStoreFromEnv({ MAKA_CLOUD_LAYERFS: '1' }).kind, 'layerfs');
  assert.equal(workspaceStoreFromEnv({ MAKA_CLOUD_LAYERFS: '0' }).kind, 'git-clone');
});

test('prepareWorkspace clones through the fleet store and exportPatch keeps later edits', async () => {
  const src = await initLocalRepo({ 'readme.txt': 'hello\n' });
  const dest = await mkdtemp(join(tmpdir(), 'runner-ws-'));
  const store = new GitCloneStore();
  const fleet = createCloudRunners({
    client: new InstaboxClient({ apiKey: 'ibk_test', baseUrl: 'http://127.0.0.1:9' }),
    sandboxes: new FixedMachineProvider('m_test'),
    workspaces: store,
  }).fleet;
  const handle = await fleet.workspaces.prepare({
    tenantId: 'inv_test',
    workerId: 'tsk_ws',
    repoUrl: src,
    workDir: dest,
  });
  assert.equal(handle.kind, 'git-clone');
  await writeFile(join(dest, 'readme.txt'), 'hello from the runner\n');
  const patch = await fleet.workspaces.exportPatch(handle);
  assert.equal(patch.includes('hello from the runner'), true);
  await fleet.workspaces.release(handle);
});

test('LayerFsStore reports a conflict when two forks edit the same file', async () => {
  const store = new LayerFsStore(true);
  const base = await store.prepare({
    tenantId: 't',
    workerId: 'base',
    repoUrl: 'x',
    seedFiles: { 'src/a.ts': 'one' },
  });
  const left = await store.prepare({
    tenantId: 't',
    workerId: 'w1',
    repoUrl: 'x',
    forkOf: base.id,
  });
  const right = await store.prepare({
    tenantId: 't',
    workerId: 'w2',
    repoUrl: 'x',
    forkOf: base.id,
  });
  store.write(left, 'src/a.ts', 'left');
  store.write(right, 'src/a.ts', 'right');
  assert.deepEqual(store.conflicts(left, right), ['src/a.ts']);
  const afterKill = await store.exportPatch(right);
  await store.release(left);
  assert.equal(afterKill.includes('+right'), true);
  const still = await store.exportPatch(right);
  assert.equal(still, afterKill, 'exportPatch survives the other worker going away');
});
