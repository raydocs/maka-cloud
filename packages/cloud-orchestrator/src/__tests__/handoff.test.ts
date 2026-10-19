import assert from 'node:assert/strict';
import { mkdir, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_FAKE_MANIFEST } from '../fake-runner.js';
import { Handoff, MAX_MANIFEST_BYTES } from '../handoff.js';
import { makeHarness } from './harness.js';

async function setup(t: Parameters<typeof makeHarness>[0]) {
  const h = await makeHarness(t);
  const handoff = new Handoff(h.dir);
  const paths = await handoff.writeBrief('tsk_a', 'brief');
  return { h, handoff, paths };
}

test('a result.json that is a symlink is rejected, even when it points at a valid manifest', async (t) => {
  const { h, handoff, paths } = await setup(t);
  const elsewhere = join(h.dir, 'elsewhere.json');
  await writeFile(elsewhere, JSON.stringify(DEFAULT_FAKE_MANIFEST));
  await symlink(elsewhere, paths.resultPath);
  const result = await handoff.readManifest('tsk_a');
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.reason, /symbolic link/u);
});

test('a result.json that is not a regular file is rejected', async (t) => {
  const { handoff, paths } = await setup(t);
  await mkdir(paths.resultPath);
  const result = await handoff.readManifest('tsk_a');
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.reason, /not a regular file/u);
});

test('the size cap counts the bytes read, up to and including the limit', async (t) => {
  const { handoff, paths } = await setup(t);
  const json = JSON.stringify(DEFAULT_FAKE_MANIFEST);
  await writeFile(paths.resultPath, json + ' '.repeat(MAX_MANIFEST_BYTES - json.length));
  assert.equal((await handoff.readManifest('tsk_a')).ok, true);
  await writeFile(paths.resultPath, json + ' '.repeat(MAX_MANIFEST_BYTES - json.length + 1));
  const result = await handoff.readManifest('tsk_a');
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.reason, /larger than/u);
});

test('a task whose runner leaves a symlink as its result fails with that reason', async (t) => {
  const h = await makeHarness(t);
  const session = h.session();
  const { taskId } = await h.orchestrator.delegate(session, { runner: 'fake', brief: 'go' });
  const run = h.fake.runFor(taskId);
  const elsewhere = join(h.dir, 'elsewhere.json');
  await writeFile(elsewhere, JSON.stringify(DEFAULT_FAKE_MANIFEST));
  await symlink(elsewhere, run.spec.resultPath);
  run.finishWithoutManifest();
  const view = await h.orchestrator.wait(session, taskId, 2000);
  assert.equal(view.state, 'failed');
  assert.match(view.failureReason ?? '', /symbolic link/u);
});

/** Moves the task dir away and leaves a symlink to it, so every path under the task dir still resolves. */
async function swapForSymlink(root: string, taskId: string): Promise<string> {
  const moved = join(root, `moved-${taskId}`);
  await rename(join(root, taskId), moved);
  await symlink(moved, join(root, taskId));
  return moved;
}

test('a task dir that was swapped for a symlink is rejected, even with a valid manifest behind it', async (t) => {
  const { h, handoff, paths } = await setup(t);
  await writeFile(paths.resultPath, JSON.stringify(DEFAULT_FAKE_MANIFEST));
  assert.equal((await handoff.readManifest('tsk_a')).ok, true);
  await swapForSymlink(h.dir, 'tsk_a');
  const result = await handoff.readManifest('tsk_a');
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.reason, /task directory is a symbolic link/u);
});

test('a task dir that is not a directory is rejected', async (t) => {
  const { h, handoff } = await setup(t);
  await rm(join(h.dir, 'tsk_a'), { recursive: true });
  await writeFile(join(h.dir, 'tsk_a'), JSON.stringify(DEFAULT_FAKE_MANIFEST));
  const result = await handoff.readManifest('tsk_a');
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.reason, /not a directory/u);
});

test('a handoff root reached through a symlink still works', async (t) => {
  const h = await makeHarness(t);
  const alias = join(h.dir, 'alias');
  await symlink(h.dir, alias);
  const handoff = new Handoff(alias);
  const paths = await handoff.writeBrief('tsk_a', 'brief');
  await writeFile(paths.resultPath, JSON.stringify(DEFAULT_FAKE_MANIFEST));
  assert.equal((await handoff.readManifest('tsk_a')).ok, true);
});

test('a task that has its dir swapped for a symlink fails instead of accepting the manifest behind it', async (t) => {
  const h = await makeHarness(t);
  const session = h.session();
  const { taskId } = await h.orchestrator.delegate(session, { runner: 'fake', brief: 'go' });
  const run = h.fake.runFor(taskId);
  await swapForSymlink(h.dir, taskId);
  await run.complete();
  const view = await h.orchestrator.wait(session, taskId, 2000);
  assert.equal(view.state, 'failed');
  assert.match(view.failureReason ?? '', /task directory is a symbolic link/u);
});

test('task dirs are created for the orchestrator only', async (t) => {
  const { h } = await setup(t);
  assert.equal((await stat(join(h.dir, 'tsk_a'))).mode & 0o777, 0o700);
});

test('a brief is never written through something already sitting at the task dir path', async (t) => {
  const h = await makeHarness(t);
  const outside = join(h.dir, 'outside');
  await mkdir(outside);
  await symlink(outside, join(h.dir, 'tsk_a'));
  await assert.rejects(new Handoff(h.dir).writeBrief('tsk_a', 'brief'));
  assert.deepEqual(await readdir(outside), []);
});
