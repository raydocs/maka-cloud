import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  createWorkspaceStore,
  GitCloneStore,
  initLocalRepo,
  LayerFsDisabledError,
  LayerFsMountUnsupportedError,
  LayerFsStore,
} from '../workspace.js';

test('GitCloneStore clones a local repo and exports a patch of later edits', async () => {
  const src = await initLocalRepo({ 'readme.txt': 'hello\n' });
  const dest = await mkdtemp(join(tmpdir(), 'maka-clone-'));
  const store = new GitCloneStore();
  const handle = await store.prepare({
    tenantId: 't',
    workerId: 'w',
    repoUrl: src,
    workDir: dest,
  });
  assert.equal(handle.kind, 'git-clone');
  const snap = await store.snapshot(handle);
  assert.equal(snap.id.length >= 7, true);
  await writeFile(join(dest, 'readme.txt'), 'hello world\n');
  const patch = await store.exportPatch(handle);
  assert.equal(patch.includes('hello world'), true);
  assert.equal(patch.includes('readme.txt'), true);
  await store.release(handle);
});

test('LayerFS is off by default and refuses a live mount when enabled', async () => {
  const off = new LayerFsStore(false);
  await assert.rejects(
    () => off.prepare({ tenantId: 't', workerId: 'w', repoUrl: 'x' }),
    LayerFsDisabledError,
  );
  const on = new LayerFsStore(true);
  await assert.rejects(
    () => on.prepare({ tenantId: 't', workerId: 'w', repoUrl: 'x', liveMount: true }),
    LayerFsMountUnsupportedError,
  );
  const handle = await on.prepare({
    tenantId: 't',
    workerId: 'w',
    repoUrl: 'x',
    seedFiles: { 'a.ts': 'one' },
  });
  on.write(handle, 'a.ts', 'two');
  const patch = await on.exportPatch(handle);
  assert.equal(patch.includes('+two'), true);
  const forked = await on.prepare({
    tenantId: 't',
    workerId: 'w2',
    repoUrl: 'x',
    forkOf: handle.id,
  });
  on.write(forked, 'a.ts', 'three');
  const forkPatch = await on.exportPatch(forked);
  assert.equal(forkPatch.includes('+three'), true);
  const other = await on.prepare({
    tenantId: 't',
    workerId: 'w3',
    repoUrl: 'x',
    forkOf: handle.id,
  });
  on.write(other, 'a.ts', 'four');
  assert.deepEqual(on.conflicts(forked, other), ['a.ts']);
  assert.equal(createWorkspaceStore().kind, 'git-clone');
  assert.equal(createWorkspaceStore({ layerfs: true }).kind, 'layerfs');
});
