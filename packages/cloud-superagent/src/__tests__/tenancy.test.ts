import assert from 'node:assert/strict';
import { test } from 'node:test';
import { github, issuePayload, rig, TENANT } from './harness.js';

test('tenant A cannot read tenant B workers, approvals or audit', async () => {
  const { agent } = rig();
  const a = await agent.ingest(github(TENANT, 'a', 'issues', issuePayload('opened', 1)));
  const b = await agent.ingest(github('inv_other', 'b', 'issues', issuePayload('opened', 1)));
  assert.equal(a.result, 'spawned');
  assert.equal(b.result, 'spawned');
  if (a.result !== 'spawned' || b.result !== 'spawned') return;
  assert.equal(agent.worker('inv_other', a.workerId), undefined);
  assert.equal(agent.worker(TENANT, b.workerId), undefined);
  assert.equal(
    agent.workers(TENANT).every((row) => row.tenantId === TENANT),
    true,
  );
  assert.equal(
    agent.workers('inv_other').every((row) => row.tenantId === 'inv_other'),
    true,
  );
  assert.equal(
    agent.store.audit(TENANT).every((row) => row.tenantId === TENANT),
    true,
  );
  assert.equal(agent.store.pendingApprovals('inv_other', a.workerId).length, 0);
});

test('a comment for tenant A does not wake tenant B on the same repo number', async () => {
  const { agent, handler } = rig();
  await agent.ingest(github(TENANT, 'a', 'issues', issuePayload('opened', 9)));
  await agent.ingest(github('inv_other', 'b', 'issues', issuePayload('opened', 9)));
  handler.events.length = 0;
  await agent.ingest({
    source: 'github',
    tenantId: TENANT,
    deliveryId: 'c-a',
    event: 'issue_comment',
    payload: {
      action: 'created',
      issue: { number: 9, title: 'Issue 9' },
      comment: { id: 1, body: 'only A' },
      repository: { full_name: 'acme/app' },
      sender: { login: 'bob', type: 'User' },
    },
  });
  assert.equal(
    handler.events.every((event) => event.tenantId === TENANT),
    true,
  );
  assert.equal(
    handler.events.some((event) => event.fields.some(([, v]) => v === 'only A')),
    true,
  );
});
