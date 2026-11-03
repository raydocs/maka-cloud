import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boxLooksRunning, isPauseActive, resumeState } from '../pause.js';
import { FakeSandbox } from '../sandbox.js';
import { WORKER_STATES } from '../types.js';
import { commentPayload, github, issuePayload, TENANT, rig } from './harness.js';

test('paused is a first-class worker state and resume never jumps to running', () => {
  assert.equal(WORKER_STATES.includes('paused'), true);
  assert.equal(isPauseActive('running'), true);
  assert.equal(isPauseActive('sleeping'), false);
  assert.equal(resumeState('running'), 'sleeping');
  assert.equal(resumeState('awaiting_approval'), 'awaiting_approval');
  assert.equal(boxLooksRunning('running'), true);
  assert.equal(boxLooksRunning('suspended'), false);
});

test('owner pause verifies the worker stopped; only explicit resume ends it', async () => {
  const sandbox = new FakeSandbox();
  const { agent, handler, time } = rig({
    sandbox,
    sandboxRef: 'box-pause',
    watchdog: { stallAfterMs: 1_000, heartbeatAfterMs: 60_000, loopRepeat: 9 },
  });
  const opened = await agent.ingest(github(TENANT, 'p1', 'issues', issuePayload('opened', 11)));
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  assert.equal(agent.worker(TENANT, opened.workerId)?.state, 'sleeping');
  const paused = await agent.pause(TENANT, opened.workerId);
  assert.equal(paused.ok, true);
  const worker = agent.worker(TENANT, opened.workerId);
  assert.equal(worker?.state, 'paused');
  assert.equal(worker?.pausedVerified, true);
  assert.equal(worker?.pausedFrom, 'sleeping');
  assert.equal(
    agent.store.audit(TENANT).some((row) => row.kind === 'paused'),
    true,
  );

  time.advance(5_000);
  const findings = await agent.tick();
  assert.equal(
    findings.some((row) => row.workerId === opened.workerId),
    false,
  );

  handler.events.length = 0;
  const comment = await agent.ingest(
    github(TENANT, 'p1c', 'issue_comment', commentPayload(11, 'keep going', false, 3)),
  );
  assert.equal(comment.result, 'passthrough');
  assert.equal(handler.events.length, 0);
  assert.equal(agent.worker(TENANT, opened.workerId)?.state, 'paused');

  const resumed = await agent.resume(TENANT, opened.workerId);
  assert.equal(resumed.ok, true);
  assert.equal(agent.worker(TENANT, opened.workerId)?.state, 'sleeping');
  assert.equal(handler.events.length, 1);
  assert.equal(
    agent.store.audit(TENANT).some((row) => row.kind === 'resumed'),
    true,
  );
});

test('pause refuses a still-running box and a mandate that disables it', async () => {
  const sandbox = new FakeSandbox();
  const { agent, store } = rig({ sandbox, sandboxRef: 'box-run' });
  const opened = await agent.ingest(github(TENANT, 'p2', 'issues', issuePayload('opened', 12)));
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  const worker = agent.worker(TENANT, opened.workerId);
  assert.ok(worker);
  sandbox.machines.set('box-run', { id: 'box-run', state: 'running' });
  sandbox.suspend = async () => {
    /* owner asked to pause; the box ignores suspend so verification fails */
  };
  const refused = await agent.pause(TENANT, opened.workerId);
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.equal(refused.reason, 'box_still_running');

  store.putWorker({
    ...agent.worker(TENANT, opened.workerId)!,
    mandate: { ...worker.mandate, ownerPause: false },
    sandboxRef: null,
    state: 'sleeping',
  });
  const disabled = await agent.pause(TENANT, opened.workerId);
  assert.equal(disabled.ok, false);
  if (disabled.ok) return;
  assert.equal(disabled.reason, 'owner_pause_disabled');
});

test('resume of a non-paused worker is refused', async () => {
  const { agent } = rig();
  const opened = await agent.ingest(github(TENANT, 'p3', 'issues', issuePayload('opened', 13)));
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  const resumed = await agent.resume(TENANT, opened.workerId);
  assert.equal(resumed.ok, false);
  if (resumed.ok) return;
  assert.equal(resumed.reason, 'not_paused');
});
