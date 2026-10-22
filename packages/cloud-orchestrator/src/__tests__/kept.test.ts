import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { MemoryTaskStore } from '../store.js';
import type { FakeRun } from '../fake-runner.js';
import type { ResultManifest } from '../types.js';
import { eventually, type Harness, makeHarness } from './harness.js';

const KEPT: ResultManifest = {
  summary: 'Kept for you to look at, not delivered: the task ended before its review finished.',
  done: ['kept: the task ended before its review finished'],
  notDone: [],
  confidence: 'low',
  knownIssues: [],
  artifacts: ['change.patch', 'verification.json'],
};

async function leave(run: FakeRun, manifest: ResultManifest): Promise<void> {
  await mkdir(dirname(run.spec.resultPath), { recursive: true });
  await writeFile(run.spec.resultPath, JSON.stringify(manifest));
}

async function start(h: Harness) {
  const session = h.session();
  const task = await h.orchestrator.delegate(session, { runner: 'fake', brief: 'change it' });
  await eventually(() => h.fake.runs.length === 1, 'the run');
  return { session, taskId: task.taskId, run: h.fake.runFor(task.taskId) };
}

test('a task that fails after the runner kept a change for the owner shows what was kept, and is still failed', async (t) => {
  const h = await makeHarness(t);
  const { session, taskId, run } = await start(h);
  await leave(run, KEPT);
  run.fail('the review could not run');
  await eventually(() => h.orchestrator.status(session, taskId).state === 'failed', 'failed');
  const view = h.orchestrator.status(session, taskId);
  assert.equal(view.manifest, undefined, 'it is not a result');
  assert.deepEqual(view.kept?.artifacts, ['change.patch', 'verification.json']);
  assert.match(view.kept?.summary ?? '', /^Kept for you to look at/);
});

test('a task that is stopped after the runner kept a change for the owner shows what was kept', async (t) => {
  const h = await makeHarness(t);
  const { session, taskId, run } = await start(h);
  await leave(run, KEPT);
  const view = await h.orchestrator.cancel(session, taskId);
  assert.equal(view.state, 'cancelled');
  assert.deepEqual(view.kept?.artifacts, ['change.patch', 'verification.json']);
  assert.equal(h.orchestrator.status(session, taskId).kept?.confidence, 'low');
});

test('a manifest that does not say it kept a change is not shown as one', async (t) => {
  const h = await makeHarness(t);
  const { session, taskId, run } = await start(h);
  await leave(run, { ...KEPT, done: ['everything the brief asked'] });
  run.fail('the run failed');
  await eventually(() => h.orchestrator.status(session, taskId).state === 'failed', 'failed');
  assert.equal(h.orchestrator.status(session, taskId).kept, undefined);
});

test('a restart that ends a task whose runner kept a change for the owner shows what was kept', async (t) => {
  const store = new MemoryTaskStore();
  const first = await makeHarness(t, { store });
  const { session, taskId, run } = await start(first);
  await leave(run, KEPT);
  // The process goes away with the task running; the handoff directory stays.
  const second = await makeHarness(t, { store, dir: first.dir });
  const view = second.orchestrator.status(session, taskId);
  assert.equal(view.state, 'failed');
  assert.match(view.failureReason ?? '', /orphaned/);
  assert.deepEqual(view.kept?.artifacts, ['change.patch', 'verification.json']);
});

test('a restart that ends a task whose manifest does not say it kept a change shows no kept change', async (t) => {
  const store = new MemoryTaskStore();
  const first = await makeHarness(t, { store });
  const { session, taskId, run } = await start(first);
  await leave(run, { ...KEPT, done: ['everything the brief asked'] });
  const second = await makeHarness(t, { store, dir: first.dir });
  const view = second.orchestrator.status(session, taskId);
  assert.equal(view.state, 'failed');
  assert.equal(view.kept, undefined);
});
