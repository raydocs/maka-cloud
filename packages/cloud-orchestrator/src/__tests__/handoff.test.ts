import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
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
