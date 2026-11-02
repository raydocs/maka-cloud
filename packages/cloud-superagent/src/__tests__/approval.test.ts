import assert from 'node:assert/strict';
import { test } from 'node:test';
import { actMandate, observeMandate } from '../types.js';
import { github, prPayload, REPO, rig, TENANT } from './harness.js';

const MERGE = 'Merge PR #12 into main';

test('merge is held until the owner approves the exact bound text', async () => {
  const { agent, handler, judge } = rig();
  judge.inner = {
    async decide() {
      return { action: 'spawn', mandate: actMandate([REPO], 'explicit'), title: 'PR' };
    },
  };
  handler.script = (event) => {
    if (event.type === 'approval_granted') return { progress: true, memory: 'merged' };
    return { action: { kind: 'merge', boundText: MERGE } };
  };
  const opened = await agent.ingest(github(TENANT, 'o', 'pull_request', prPayload('opened')));
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  const waiting = agent.worker(TENANT, opened.workerId);
  assert.equal(waiting?.state, 'awaiting_approval');
  const pending = agent.store.pendingApprovals(TENANT, opened.workerId);
  assert.equal(pending.length, 1);
  const approvalId = pending[0]?.approvalId as string;

  const wrong = await agent.approve(TENANT, approvalId, 'Merge something else');
  assert.equal(wrong.ok, false);
  if (wrong.ok) return;
  assert.equal(wrong.reason, 'text_mismatch');
  assert.equal(agent.worker(TENANT, opened.workerId)?.state, 'awaiting_approval');

  const ok = await agent.approve(TENANT, approvalId, MERGE);
  assert.equal(ok.ok, true);
  const done = agent.worker(TENANT, opened.workerId);
  assert.equal(done?.memory, 'merged');
  assert.equal(done?.state, 'sleeping');
});

test('observe intensity refuses merge without opening an approval', async () => {
  const { agent, handler, judge } = rig();
  judge.inner = {
    async decide() {
      return { action: 'spawn', mandate: observeMandate([REPO]), title: 'watch' };
    },
  };
  handler.script = () => ({ action: { kind: 'merge', boundText: MERGE } });
  const opened = await agent.ingest(github(TENANT, 'o', 'pull_request', prPayload('opened')));
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  const worker = agent.worker(TENANT, opened.workerId);
  assert.notEqual(worker?.state, 'awaiting_approval');
  assert.equal(agent.store.pendingApprovals(TENANT, opened.workerId).length, 0);
  assert.equal(
    agent.store.audit(TENANT).some((row) => row.kind === 'action_refused'),
    true,
  );
});

test('push, secrets and deploy are held the same way as merge', async () => {
  const kinds = ['push_protected', 'secrets', 'deploy'] as const;
  for (const kind of kinds) {
    const { agent, handler, judge } = rig();
    judge.inner = {
      async decide() {
        return { action: 'spawn', mandate: actMandate([REPO]), title: kind };
      },
    };
    const bound = `Allow ${kind} on ${REPO}`;
    handler.script = () => ({ action: { kind, boundText: bound } });
    const opened = await agent.ingest(
      github(TENANT, `o-${kind}`, 'pull_request', prPayload('opened', 20 + kinds.indexOf(kind))),
    );
    assert.equal(opened.result, 'spawned', kind);
    if (opened.result !== 'spawned') return;
    assert.equal(agent.worker(TENANT, opened.workerId)?.state, 'awaiting_approval', kind);
    const pending = agent.store.pendingApprovals(TENANT, opened.workerId);
    assert.equal(pending[0]?.kind, kind);
    assert.equal(pending[0]?.boundText, bound);
  }
});

test('denying a held action retires the worker', async () => {
  const { agent, handler, judge } = rig();
  judge.inner = {
    async decide() {
      return { action: 'spawn', mandate: actMandate([REPO]), title: 'PR' };
    },
  };
  handler.script = () => ({ action: { kind: 'deploy', boundText: 'Deploy prod' } });
  const opened = await agent.ingest(github(TENANT, 'o', 'pull_request', prPayload('opened')));
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  const approvalId = agent.store.pendingApprovals(TENANT, opened.workerId)[0]?.approvalId as string;
  const denied = await agent.deny(TENANT, approvalId, 'Deploy prod');
  assert.equal(denied.ok, true);
  assert.equal(agent.worker(TENANT, opened.workerId)?.state, 'retired');
});
