import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

const run = promisify(execFile);
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

test('GitCloneStore exportPatch includes new untracked files', async () => {
  const src = await initLocalRepo({ 'readme.txt': 'hello\n' });
  const dest = await mkdtemp(join(tmpdir(), 'maka-clone-'));
  const store = new GitCloneStore();
  const handle = await store.prepare({
    tenantId: 't',
    workerId: 'w-untracked',
    repoUrl: src,
    workDir: dest,
  });
  await writeFile(join(dest, 'extra.ts'), 'export const n = 1;\n');
  const patch = await store.exportPatch(handle);
  assert.match(patch, /extra\.ts/);
  assert.match(patch, /\+export const n = 1;/);
  await store.release(handle);
});

test('GitCloneStore snapshot is a worktree tree id, not only HEAD', async () => {
  const src = await initLocalRepo({ 'readme.txt': 'hello\n' });
  const dest = await mkdtemp(join(tmpdir(), 'maka-clone-'));
  const store = new GitCloneStore();
  const handle = await store.prepare({
    tenantId: 't',
    workerId: 'w-snap',
    repoUrl: src,
    workDir: dest,
  });
  const { stdout: head } = await run('git', ['-C', dest, 'rev-parse', 'HEAD']);
  const { stdout: headTree } = await run('git', ['-C', dest, 'rev-parse', 'HEAD^{tree}']);
  const clean = await store.snapshot(handle);
  assert.equal(clean.id, headTree.trim());
  assert.notEqual(clean.id, head.trim());

  await writeFile(join(dest, 'readme.txt'), 'changed\n');
  await writeFile(join(dest, 'new.txt'), 'brand new\n');
  const dirty = await store.snapshot(handle);
  assert.notEqual(dirty.id, headTree.trim());
  const { stdout: kind } = await run('git', ['-C', dest, 'cat-file', '-t', dirty.id]);
  assert.equal(kind.trim(), 'tree');
  const { stdout: headAfter } = await run('git', ['-C', dest, 'rev-parse', 'HEAD']);
  assert.equal(headAfter.trim(), head.trim());
  const { stdout: staged } = await run('git', ['-C', dest, 'diff', '--cached', '--name-only']);
  assert.equal(staged.trim(), '');
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
