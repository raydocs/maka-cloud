import assert from 'node:assert/strict';
import { test } from 'node:test';
import { followRecall } from '../recall-chain.js';
import { FakeSandbox } from '../sandbox.js';
import { commentPayload, github, issuePayload, rig, TENANT } from './harness.js';

test('followRecall walks trigger id → thread id → worker id', async () => {
  const { agent } = rig({ sandbox: new FakeSandbox() });
  const opened = await agent.ingest(github(TENANT, 'rc-open', 'issues', issuePayload('opened', 5)));
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  const byTrigger = agent.followRecall(TENANT, { triggerId: opened.eventId });
  assert.ok(byTrigger.length >= 1);
  assert.equal(
    byTrigger.some((row) => row.workerId === opened.workerId),
    true,
  );
  const threadId = agent.worker(TENANT, opened.workerId)?.subject.key;
  assert.ok(threadId);
  const byThread = agent.followRecall(TENANT, { threadId });
  assert.ok(byThread.some((row) => row.triggerId === opened.eventId));
  const byWorker = agent.followRecall(TENANT, { workerId: opened.workerId });
  assert.ok(byWorker.every((row) => row.threadId === threadId));

  const comment = await agent.ingest(
    github(TENANT, 'rc-c', 'issue_comment', commentPayload(5, 'more detail', false, 2)),
  );
  assert.equal(comment.result, 'passthrough');
  if (comment.result !== 'passthrough') return;
  const follow = agent.followRecall(TENANT, { triggerId: comment.eventId });
  assert.equal(follow[0]?.layer, 'passthrough');
  assert.equal(follow[0]?.workerId, opened.workerId);
  assert.equal(follow[0]?.threadId, threadId);
  assert.deepEqual(
    followRecall(follow, { workerId: opened.workerId }).map((row) => row.triggerId),
    [comment.eventId],
  );
});
