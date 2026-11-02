import assert from 'node:assert/strict';
import { test } from 'node:test';
import { actMandate } from '../types.js';
import {
  commentPayload,
  github,
  issuePayload,
  prPayload,
  REPO,
  rig,
  TENANT,
  workflowPayload,
} from './harness.js';

test('a CI failure on a subscribed pull request is pass-through with zero judge calls', async () => {
  const { agent, judge } = rig();
  const opened = await agent.ingest(github(TENANT, 'open', 'pull_request', prPayload('opened')));
  assert.equal(opened.result, 'spawned');
  const before = judge.calls.length;
  const ci = await agent.ingest(
    github(TENANT, 'ci1', 'workflow_run', workflowPayload('failure', 12)),
  );
  assert.equal(ci.result, 'passthrough');
  if (ci.result !== 'passthrough' || opened.result !== 'spawned') return;
  assert.equal(ci.judgeCalls, 0);
  assert.equal(judge.calls.length, before);
  assert.deepEqual(ci.workerIds, [opened.workerId]);
  const worker = agent.worker(TENANT, opened.workerId);
  assert.equal(worker?.lastEventId !== null, true);
});

test('the same delivery id creates one worker', async () => {
  const { agent, judge } = rig();
  const first = await agent.ingest(github(TENANT, 'same', 'issues', issuePayload('opened')));
  const second = await agent.ingest(github(TENANT, 'same', 'issues', issuePayload('opened')));
  assert.equal(first.result, 'spawned');
  assert.equal(second.result, 'duplicate');
  assert.equal(agent.workers(TENANT).filter((row) => row.state !== 'retired').length, 1);
  assert.equal(judge.calls.length, 1);
});

test('an unowned CI failure is ignored and does not call the judge', async () => {
  const { agent, judge } = rig();
  const ci = await agent.ingest(
    github(TENANT, 'ci-none', 'workflow_run', workflowPayload('failure', 99)),
  );
  assert.equal(ci.result, 'ignored');
  if (ci.result !== 'ignored') return;
  assert.equal(ci.reason, 'unowned_ci');
  assert.equal(judge.calls.length, 0);
  assert.equal(agent.workers(TENANT).length, 0);
});

test('a bot cannot spawn an unowned worker', async () => {
  const { agent, judge } = rig();
  const payload = prPayload('opened');
  (payload as { sender: { login: string; type: string } }).sender = {
    login: 'dependabot[bot]',
    type: 'Bot',
  };
  const result = await agent.ingest(github(TENANT, 'bot', 'pull_request', payload));
  assert.equal(result.result, 'ignored');
  if (result.result !== 'ignored') return;
  assert.equal(result.reason, 'bot');
  assert.equal(judge.calls.length, 0);
});

test('a status question is answered without a worker', async () => {
  const { agent } = rig();
  const result = await agent.ingest({
    source: 'chat',
    tenantId: TENANT,
    conversationId: 'cnv_1',
    messageId: 'm1',
    text: 'status on the login bug?',
    actor: 'alice',
  });
  assert.equal(result.result, 'answered');
});

test('a second spawn on the same subject is refused as already owned', async () => {
  const { agent, judge } = rig();
  judge.inner = {
    async decide() {
      return { action: 'spawn', mandate: actMandate([REPO]), title: 'work' };
    },
  };
  const first = await agent.ingest(github(TENANT, 'a', 'issues', issuePayload('opened', 4)));
  assert.equal(first.result, 'spawned');
  // A different delivery on the same issue is pass-through (subscribed), not a second spawn.
  const follow = await agent.ingest(
    github(TENANT, 'b', 'issue_comment', commentPayload(4, 'more detail', false, 1)),
  );
  assert.equal(follow.result, 'passthrough');
});

test('tenant pause refuses new unowned work', async () => {
  const { agent, usage } = rig();
  usage.stop = true;
  const result = await agent.ingest(github(TENANT, 'paused', 'issues', issuePayload('opened')));
  assert.equal(result.result, 'ignored');
  if (result.result !== 'ignored') return;
  assert.equal(result.reason, 'tenant_paused');
});
