import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commentPayload, github, issuePayload, rig, TENANT } from './harness.js';

test('a handler that repeats the same step is a looping finding', async () => {
  const { agent, handler, time } = rig({
    watchdog: { loopRepeat: 3, stallAfterMs: 60_000, heartbeatAfterMs: 120_000, maxRestarts: 3 },
  });
  handler.script = () => ({ stepSignature: 'edit-login.ts', progress: false });
  const opened = await agent.ingest(github(TENANT, 'o', 'issues', issuePayload('opened', 1)));
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  await agent.ingest(github(TENANT, 'c1', 'issue_comment', commentPayload(1, 'one', false, 1)));
  await agent.ingest(github(TENANT, 'c2', 'issue_comment', commentPayload(1, 'two', false, 2)));
  const worker = agent.worker(TENANT, opened.workerId);
  assert.equal(worker?.stepRepeats, 3);
  time.advance(1);
  const findings = await agent.tick();
  assert.equal(
    findings.some((row) => row.rule === 'looping' && row.workerId === opened.workerId),
    true,
  );
  assert.equal(agent.worker(TENANT, opened.workerId)?.state, 'stuck');
});

test('a crashed handler is restarted until the cap, then escalated', async () => {
  const { agent, handler, time } = rig({
    watchdog: { maxRestarts: 3, heartbeatAfterMs: 1_000, stallAfterMs: 60_000, loopRepeat: 9 },
  });
  handler.script = () => {
    throw new Error('boom');
  };
  const opened = await agent.ingest(github(TENANT, 'o', 'issues', issuePayload('opened', 2)));
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  assert.equal(agent.worker(TENANT, opened.workerId)?.state, 'crashed');
  assert.equal(agent.worker(TENANT, opened.workerId)?.generation, 1);

  time.advance(5);
  const first = await agent.tick();
  assert.equal(
    first.some((row) => row.rule === 'crashed' && row.action === 'restart'),
    true,
  );
  assert.equal(agent.worker(TENANT, opened.workerId)?.generation, 2);

  time.advance(5);
  const second = await agent.tick();
  assert.equal(
    second.some((row) => row.rule === 'crashed' && row.action === 'restart'),
    true,
  );
  assert.equal(agent.worker(TENANT, opened.workerId)?.generation, 3);

  time.advance(5);
  const capped = await agent.tick();
  assert.equal(
    capped.some((row) => row.rule === 'crashed' && row.action === 'escalate'),
    true,
  );
  assert.equal(agent.worker(TENANT, opened.workerId)?.generation, 3);
});

test('usage over the mandate budget stops the worker and does not restart', async () => {
  const { agent, handler } = rig();
  handler.script = () => ({ usage: { usdMicros: 6_000_000 }, progress: true });
  const opened = await agent.ingest(github(TENANT, 'o', 'issues', issuePayload('opened', 3)));
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  const worker = agent.worker(TENANT, opened.workerId);
  assert.equal(worker?.state, 'stuck');
  assert.equal(worker?.usage.usdMicros, 6_000_000);
  const findings = await agent.tick();
  assert.equal(
    findings.some((row) => row.rule === 'over_budget' && row.action === 'stop'),
    true,
  );
  assert.equal(agent.worker(TENANT, opened.workerId)?.generation, 1);
});

test('a running worker with no progress inside the stall window is stuck', async () => {
  const { agent, store, time } = rig({
    watchdog: { stallAfterMs: 1_000, heartbeatAfterMs: 60_000, loopRepeat: 9 },
  });
  const opened = await agent.ingest(github(TENANT, 'o', 'issues', issuePayload('opened', 5)));
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  const worker = agent.worker(TENANT, opened.workerId);
  assert.ok(worker);
  store.putWorker({
    ...worker,
    state: 'running',
    lastProgressAt: time.now - 5,
    lastHeartbeatAt: time.now,
  });
  time.advance(2_000);
  const findings = await agent.tick();
  assert.equal(
    findings.some((row) => row.rule === 'stuck' && row.workerId === opened.workerId),
    true,
  );
});
