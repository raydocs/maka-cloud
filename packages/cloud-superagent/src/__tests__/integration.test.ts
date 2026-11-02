import assert from 'node:assert/strict';
import { test } from 'node:test';
import { subjectOfFollowUp } from '../subjects.js';
import { actMandate } from '../types.js';
import { FakeSandbox } from '../sandbox.js';
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

test('an issue worker receives comments, CI on its later PR is pass-through, close retires it', async () => {
  const { agent, judge, handler } = rig();
  const opened = await agent.ingest(github(TENANT, 'i1', 'issues', issuePayload('opened', 15)));
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  handler.script = (event, worker) => ({
    progress: true,
    memory: worker.memory,
    plan: event.type === 'issue_comment' ? 'address the comment' : worker.plan,
  });
  const comment = await agent.ingest(
    github(TENANT, 'c1', 'issue_comment', commentPayload(15, 'please add logs', false, 3)),
  );
  assert.equal(comment.result, 'passthrough');
  assert.equal(judge.calls.length, 1);

  // A new PR owned by a follow-up watch is a different subject; spawn it as #460 would.
  const watch = subjectOfFollowUp({ tenantId: TENANT, repo: REPO, number: 44 });
  assert.equal(watch.key.includes('#44'), true);
  const pr = await agent.ingest(github(TENANT, 'p44', 'pull_request', prPayload('opened', 44)));
  assert.equal(pr.result, 'spawned');
  const before = judge.calls.length;
  const ci = await agent.ingest(
    github(TENANT, 'ci44', 'workflow_run', workflowPayload('failure', 44)),
  );
  assert.equal(ci.result, 'passthrough');
  assert.equal(judge.calls.length, before);

  const closed = await agent.ingest(github(TENANT, 'iclose', 'issues', issuePayload('closed', 15)));
  assert.equal(closed.result, 'passthrough');
  if (closed.result !== 'passthrough') return;
  assert.equal(agent.worker(TENANT, opened.workerId)?.state, 'retired');
  if (pr.result === 'spawned') {
    assert.equal(agent.worker(TENANT, pr.workerId)?.state, 'sleeping');
  }
});

test('metering records usage and FakeSandbox stays unused until a host adapter calls it', async () => {
  const { agent, handler, usage } = rig();
  handler.script = () => ({ usage: { tokens: 40, usdMicros: 2500, wallMs: 12 }, progress: true });
  const opened = await agent.ingest(github(TENANT, 'm', 'issues', issuePayload('opened', 2)));
  assert.equal(opened.result, 'spawned');
  assert.equal(usage.records.length >= 1, true);
  assert.equal(usage.records[0]?.tokens, 40);
  const box = new FakeSandbox();
  await box.ensureRunning('box-1');
  assert.equal((await box.getMachine('box-1')).state, 'running');
});

test('an act worker can proceed after approval and a later event still skips the Router', async () => {
  const { agent, handler, judge } = rig();
  judge.inner = {
    async decide() {
      return { action: 'spawn', mandate: actMandate([REPO]), title: 'PR' };
    },
  };
  handler.script = (event) => {
    if (event.type === 'approval_granted' || event.type === 'issue_comment') {
      return { progress: true, plan: 'fix after approval' };
    }
    return { action: { kind: 'push_protected', boundText: 'Push to main' } };
  };
  const opened = await agent.ingest(github(TENANT, 'p', 'pull_request', prPayload('opened', 7)));
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  const approvalId = agent.store.pendingApprovals(TENANT, opened.workerId)[0]?.approvalId as string;
  await agent.approve(TENANT, approvalId, 'Push to main');
  const before = judge.calls.length;
  const comment = await agent.ingest(
    github(TENANT, 'late', 'issue_comment', commentPayload(7, 'looks good')),
  );
  assert.equal(comment.result, 'passthrough');
  assert.equal(judge.calls.length, before);
  assert.equal(agent.worker(TENANT, opened.workerId)?.plan, 'fix after approval');
});
