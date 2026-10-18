import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { claudeAgentSdkRunner, codexRunner, RunnerRegistry } from '../runner.js';
import { DEFAULT_FAKE_MANIFEST } from '../fake-runner.js';
import { OrchestratorError } from '../types.js';
import { eventually, makeHarness } from './harness.js';

test('async delegate writes the brief, starts the runner and reports progress and the manifest', async (t) => {
  const h = await makeHarness(t);
  const session = h.session();
  const created = await h.orchestrator.delegate(session, {
    runner: 'fake',
    brief: '# Do the thing\nCarefully.',
    title: 'thing',
  });
  assert.equal(created.runner, 'fake');
  assert.equal(created.title, 'thing');
  assert.ok(['queued', 'running'].includes(created.state));

  await eventually(() => h.fake.runs.length === 1, 'runner start');
  const run = h.fake.runFor(created.taskId);
  assert.equal(await readFile(run.spec.briefPath, 'utf8'), '# Do the thing\nCarefully.');
  await eventually(
    () => h.orchestrator.status(session, created.taskId).state === 'running',
    'running',
  );

  run.progress('step 1');
  await eventually(
    () => h.orchestrator.status(session, created.taskId).progress.includes('step 1'),
    'progress',
  );

  await run.complete();
  const done = await h.orchestrator.wait(session, created.taskId, 2000);
  assert.equal(done.state, 'succeeded');
  assert.deepEqual(done.manifest, DEFAULT_FAKE_MANIFEST);
  assert.equal(done.waitTimedOut, undefined);
});

test('wait mode blocks until the task ends', async (t) => {
  const h = await makeHarness(t, {
    fake: { onStart: (run) => void setTimeout(() => void run.complete(), 20) },
  });
  const view = await h.orchestrator.delegate(h.session(), {
    runner: 'fake',
    brief: 'go',
    mode: 'wait',
    timeoutMs: 5000,
  });
  assert.equal(view.state, 'succeeded');
});

test('a wait timeout reports waitTimedOut and does not cancel the task', async (t) => {
  const h = await makeHarness(t);
  const session = h.session();
  const view = await h.orchestrator.delegate(session, {
    runner: 'fake',
    brief: 'go',
    mode: 'wait',
    timeoutMs: 30,
  });
  assert.equal(view.waitTimedOut, true);
  assert.equal(view.state, 'running');
  assert.equal(h.fake.runFor(view.taskId).cancelCalls, 0);
  const later = await h.orchestrator.wait(session, view.taskId, 20);
  assert.equal(later.waitTimedOut, true);
  await h.fake.runFor(view.taskId).complete();
  assert.equal((await h.orchestrator.wait(session, view.taskId, 2000)).state, 'succeeded');
});

test('a manifest that is missing, malformed or off-schema fails the task', async (t) => {
  const cases: Array<{ raw: string | undefined; reason: RegExp }> = [
    { raw: undefined, reason: /result\.json was not written/u },
    { raw: '{not json', reason: /not valid JSON/u },
    { raw: JSON.stringify({ summary: 'x' }), reason: /invalid manifest: done/u },
    {
      raw: JSON.stringify({ ...DEFAULT_FAKE_MANIFEST, confidence: 'certain' }),
      reason: /invalid manifest: confidence/u,
    },
  ];
  for (const { raw, reason } of cases) {
    const h = await makeHarness(t);
    const session = h.session();
    const { taskId } = await h.orchestrator.delegate(session, { runner: 'fake', brief: 'go' });
    await eventually(() => h.fake.runs.length === 1, 'runner start');
    const run = h.fake.runFor(taskId);
    if (raw === undefined) {
      run.finishWithoutManifest();
    } else {
      await run.complete(DEFAULT_FAKE_MANIFEST, raw);
    }
    const view = await h.orchestrator.wait(session, taskId, 2000);
    assert.equal(view.state, 'failed', String(raw));
    assert.match(view.failureReason ?? '', reason);
  }
});

test('a runner that reports failure fails the task with its reason', async (t) => {
  const h = await makeHarness(t);
  const session = h.session();
  const { taskId } = await h.orchestrator.delegate(session, { runner: 'fake', brief: 'go' });
  await eventually(() => h.fake.runs.length === 1, 'runner start');
  h.fake.runFor(taskId).fail('disk full');
  const view = await h.orchestrator.wait(session, taskId, 2000);
  assert.equal(view.state, 'failed');
  assert.equal(view.failureReason, 'disk full');
});

test('a runner whose stream ends without a result fails the task', async (t) => {
  const h = await makeHarness(t);
  const session = h.session();
  const { taskId } = await h.orchestrator.delegate(session, { runner: 'fake', brief: 'go' });
  await eventually(() => h.fake.runs.length === 1, 'runner start');
  h.fake.runFor(taskId).end();
  const view = await h.orchestrator.wait(session, taskId, 2000);
  assert.equal(view.state, 'failed');
  assert.match(view.failureReason ?? '', /without reporting a result/u);
});

test('a runner that cannot start fails the task', async (t) => {
  const h = await makeHarness(t, { fake: { startError: new Error('no sandbox') } });
  const view = await h.orchestrator.delegate(h.session(), {
    runner: 'fake',
    brief: 'go',
    mode: 'wait',
    timeoutMs: 2000,
  });
  assert.equal(view.state, 'failed');
  assert.match(view.failureReason ?? '', /runner failed to start: no sandbox/u);
});

test('the stub runners fail fast with a clear reason', async (t) => {
  const h = await makeHarness(t, {
    orchestrator: { runners: new RunnerRegistry([claudeAgentSdkRunner, codexRunner]) },
  });
  for (const runner of ['claude-agent-sdk', 'codex']) {
    const view = await h.orchestrator.delegate(h.session(), {
      runner,
      brief: 'go',
      mode: 'wait',
      timeoutMs: 2000,
    });
    assert.equal(view.state, 'failed');
    assert.match(view.failureReason ?? '', /not implemented yet/u);
  }
});

test('bad requests are rejected before anything is recorded', async (t) => {
  const h = await makeHarness(t);
  const session = h.session();
  await assert.rejects(
    h.orchestrator.delegate(session, { runner: 'nope', brief: 'go' }),
    (error: unknown) => error instanceof OrchestratorError && error.code === 'unknown_runner',
  );
  await assert.rejects(
    h.orchestrator.delegate(session, { runner: 'fake', brief: '   ' }),
    (error: unknown) => error instanceof OrchestratorError && error.code === 'invalid_request',
  );
  assert.equal((await h.store.read()).length, 0);
});

test('delegation depth is limited', async (t) => {
  const h = await makeHarness(t, { orchestrator: { maxDepth: 1 } });
  const root = await h.orchestrator.delegate(h.session(), { runner: 'fake', brief: 'a' });
  const child = await h.orchestrator.delegate(h.executorSession(root.taskId), {
    runner: 'fake',
    brief: 'b',
  });
  await assert.rejects(
    h.orchestrator.delegate(h.executorSession(child.taskId), { runner: 'fake', brief: 'c' }),
    (error: unknown) => error instanceof OrchestratorError && error.code === 'depth_exceeded',
  );
});

test('the token handed to a runner works while it runs and is revoked when the task ends', async (t) => {
  const h = await makeHarness(t);
  h.orchestrator.setEndpoint('http://127.0.0.1:1/mcp');
  const session = h.session();
  const { taskId } = await h.orchestrator.delegate(session, { runner: 'fake', brief: 'go' });
  await eventually(() => h.fake.runs.length === 1, 'runner start');
  const run = h.fake.runFor(taskId);
  assert.equal(run.spec.mcp?.url, 'http://127.0.0.1:1/mcp');
  const token = run.spec.mcp?.token ?? '';
  const executor = h.orchestrator.authenticate(token);
  assert.equal(executor?.parentTaskId, taskId);
  assert.notEqual(executor?.sessionId, session.sessionId);
  await run.complete();
  await h.orchestrator.wait(session, taskId, 2000);
  assert.equal(h.orchestrator.authenticate(token), undefined);
});
