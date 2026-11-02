import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { RecordingHandler } from '../runtime.js';
import { Superagent } from '../runtime.js';
import { sequentialIds } from '../ids.js';
import { RecordingJudge } from '../router.js';
import { SqliteSuperagentStore } from '../sqlite-store.js';
import { commentPayload, github, issuePayload, prPayload, rig, TENANT } from './harness.js';

test('a worker keeps its plan across a sqlite reopen and consumes the next event', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-sa-'));
  const path = join(dir, 'superagent.sqlite');
  const handler1 = new RecordingHandler();
  handler1.script = () => ({
    plan: 'reproduce the login failure',
    progress: true,
    memory: 'looked at issue',
  });
  const store1 = SqliteSuperagentStore.open(path);
  const agent1 = new Superagent({
    store: store1,
    handler: handler1,
    judge: new RecordingJudge(),
    ids: sequentialIds(),
    clock: () => 1_700_000_000_000,
  });
  const opened = await agent1.ingest(github(TENANT, 'open', 'issues', issuePayload('opened', 4)));
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  const before = agent1.worker(TENANT, opened.workerId);
  assert.equal(before?.plan, 'reproduce the login failure');
  assert.equal(before?.state, 'sleeping');
  store1.close();

  const handler2 = new RecordingHandler();
  const judge2 = new RecordingJudge();
  const store2 = SqliteSuperagentStore.open(path);
  const agent2 = new Superagent({
    store: store2,
    handler: handler2,
    judge: judge2,
    ids: sequentialIds(100),
    clock: () => 1_700_000_100_000,
  });
  const restored = await agent2.restore();
  assert.equal(restored.resumed, 0);
  const comment = await agent2.ingest(
    github(TENANT, 'c1', 'issue_comment', commentPayload(4, 'it fails on Safari', false, 11)),
  );
  assert.equal(comment.result, 'passthrough');
  assert.equal(judge2.calls.length, 0);
  const after = agent2.worker(TENANT, opened.workerId);
  assert.equal(after?.plan, 'reproduce the login failure');
  assert.equal(after?.memory, 'looked at issue');
  assert.equal(handler2.events.length, 1);
  assert.equal(handler2.events[0]?.type, 'issue_comment');
  store2.close();
  await rm(dir, { recursive: true, force: true });
});

test('closing the subject retires the worker and a later comment can spawn a new one', async () => {
  const { agent } = rig();
  const opened = await agent.ingest(github(TENANT, 'o', 'issues', issuePayload('opened', 8)));
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  const closed = await agent.ingest(github(TENANT, 'cl', 'issues', issuePayload('closed', 8)));
  assert.equal(closed.result, 'passthrough');
  const retired = agent.worker(TENANT, opened.workerId);
  assert.equal(retired?.state, 'retired');
  const again = await agent.ingest(github(TENANT, 're', 'issues', issuePayload('opened', 8)));
  assert.equal(again.result, 'spawned');
  if (again.result !== 'spawned') return;
  assert.notEqual(again.workerId, opened.workerId);
});

test('a sleeping worker wakes on the next comment without a Router call', async () => {
  const { agent, judge, handler } = rig();
  await agent.ingest(github(TENANT, 'p', 'pull_request', prPayload('opened', 3)));
  const before = judge.calls.length;
  await agent.ingest(github(TENANT, 'c', 'issue_comment', commentPayload(3, 'please add a test')));
  assert.equal(judge.calls.length, before);
  assert.equal(
    handler.events.some((event) => event.type === 'issue_comment'),
    true,
  );
});
